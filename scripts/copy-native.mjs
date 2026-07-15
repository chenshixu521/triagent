#!/usr/bin/env node
/**
 * Deterministic secure copy of the ProcessHost helper into dist/native/win-x64/.
 *
 * Every invocation derives source/output/assertions/replace token/transient set
 * from packageRoot + invocation-local state. No module-scope mutable ownership.
 * Only inspects/cleans paths owned by this invocation. Lock release mismatch is
 * a hard failure; finally retries cleanup of this invocation's staging only.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  chmodSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  atomicReplaceFile,
  writeFileAtomically,
  assertRegularNonReparseFile,
  withTransientRenameRetry,
} from './lib/atomic-replace.mjs';
import { acquireBuildLock } from './lib/build-lock.mjs';

const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const DEFAULT_PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
const EXACT_SOURCE_NAME = 'triagent-process-host.exe';

export class CopyNativeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'CopyNativeError';
  }
}

function pathKey(input) {
  return process.platform === 'win32'
    ? input.replaceAll('/', '\\').toLocaleLowerCase('en-US')
    : input;
}

/**
 * @param {string} packageRoot
 * @param {string} absolutePath
 * @param {string} label
 */
function assertInsideRoot(packageRoot, absolutePath, label) {
  const rootResolved = resolve(packageRoot);
  const target = resolve(absolutePath);
  const rootPrefix = rootResolved.endsWith(sep)
    ? rootResolved
    : `${rootResolved}${sep}`;
  if (
    pathKey(target) !== pathKey(rootResolved)
    && !pathKey(target).startsWith(pathKey(rootPrefix))
  ) {
    throw new CopyNativeError(`${label} escapes package root: ${absolutePath}`);
  }
}

function readPeMachine(path) {
  const fd = openSync(path, 'r');
  try {
    const dos = Buffer.alloc(64);
    if (readSync(fd, dos, 0, 64, 0) < 64) {
      throw new CopyNativeError('helper DOS header too short');
    }
    if (dos.toString('ascii', 0, 2) !== 'MZ') {
      throw new CopyNativeError('helper is not a PE executable (missing MZ)');
    }
    const peOffset = dos.readUInt32LE(0x3c);
    const pe = Buffer.alloc(6);
    if (readSync(fd, pe, 0, 6, peOffset) < 6) {
      throw new CopyNativeError('helper PE header unreadable');
    }
    if (pe.toString('ascii', 0, 4) !== 'PE\0\0') {
      throw new CopyNativeError(
        'helper is not a PE executable (missing PE signature)',
      );
    }
    return pe.readUInt16LE(4);
  } finally {
    closeSync(fd);
  }
}

function sha256File(path) {
  const bytes = readFileSync(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  };
}

/**
 * Parse embedded trust constants from generated TypeScript source.
 * Adjacent JSON metadata is NOT the trust anchor.
 * @param {string} path
 */
export function loadEmbeddedTrustFromSource(path) {
  if (!existsSync(path)) {
    throw new CopyNativeError(
      `embedded trust source missing (run generate-native-trust after build:native): ${path}`,
    );
  }
  return parseTrustConstants(readFileSync(path, 'utf8'), path);
}

/**
 * Parse trust constants from arbitrary text (source or bundled dist/cli.js).
 * dist/cli.js is authoritative for packaged runs.
 * @param {string} text
 * @param {string} label
 */
export function parseTrustConstants(text, label) {
  const sha = text.match(
    /EMBEDDED_NATIVE_HELPER_SHA256\s*=\s*\n?\s*["']([0-9a-f]{64})["']/u,
  )
    ?? text.match(/["']([0-9a-f]{64})["']\s*as const/u);
  // Prefer named constant match; fall back to first 64-hex near EMBEDDED marker.
  let sha256;
  const namedSha = text.match(
    /EMBEDDED_NATIVE_HELPER_SHA256[\s\S]{0,80}?["']([0-9a-f]{64})["']/u,
  );
  if (namedSha) {
    sha256 = namedSha[1];
  } else if (sha) {
    sha256 = sha[1];
  } else {
    throw new CopyNativeError(
      `embedded trust SHA256 missing in ${label}`,
    );
  }

  const namedLen = text.match(
    /EMBEDDED_NATIVE_HELPER_BYTE_LENGTH\s*=\s*(\d+)/u,
  );
  if (!namedLen) {
    throw new CopyNativeError(
      `embedded trust byte length missing in ${label}`,
    );
  }
  const namedPe = text.match(
    /EMBEDDED_NATIVE_HELPER_PE_MACHINE\s*=\s*(0x[0-9a-fA-F]+|\d+)/u,
  );
  if (!namedPe) {
    throw new CopyNativeError(
      `embedded trust PE machine missing in ${label}`,
    );
  }
  const peMachine = Number(namedPe[1]);
  if (!Number.isInteger(peMachine) || peMachine !== IMAGE_FILE_MACHINE_AMD64) {
    throw new CopyNativeError(
      `embedded PE machine invalid in ${label}: ${String(namedPe[1])}`,
    );
  }
  return {
    sha256,
    byteLength: Number(namedLen[1]),
    peMachine,
  };
}

/**
 * Load authoritative trust from built dist/cli.js when present.
 * @param {string} packageRoot
 */
export function loadEmbeddedTrustFromCliBundle(packageRoot) {
  const cliPath = join(packageRoot, 'dist', 'cli.js');
  if (!existsSync(cliPath)) {
    return null;
  }
  return parseTrustConstants(readFileSync(cliPath, 'utf8'), cliPath);
}

/**
 * Cross-check source trust, CLI bundle trust (when present), and helper bytes.
 * @param {{ sha256: string, byteLength: number, peMachine: number }} sourceTrust
 * @param {{ sha256: string, byteLength: number, peMachine: number } | null} cliTrust
 * @param {{ sha256: string, byteLength: number }} helperDigest
 * @param {number} helperPe
 */
export function assertTrustAgreement(sourceTrust, cliTrust, helperDigest, helperPe) {
  if (cliTrust !== null) {
    if (
      cliTrust.sha256 !== sourceTrust.sha256
      || cliTrust.byteLength !== sourceTrust.byteLength
      || cliTrust.peMachine !== sourceTrust.peMachine
    ) {
      throw new CopyNativeError(
        `embedded trust source/bundle divergence: source=${sourceTrust.sha256}/${sourceTrust.byteLength}/0x${sourceTrust.peMachine.toString(16)} `
        + `cli=${cliTrust.sha256}/${cliTrust.byteLength}/0x${cliTrust.peMachine.toString(16)}; `
        + 'rebuild dist/cli.js (build:node) after generate-native-trust',
      );
    }
  }
  const authoritative = cliTrust ?? sourceTrust;
  if (
    helperDigest.sha256 !== authoritative.sha256
    || helperDigest.byteLength !== authoritative.byteLength
  ) {
    throw new CopyNativeError(
      `helper does not match authoritative embedded trust `
      + `(helper=${helperDigest.sha256}/${helperDigest.byteLength}, `
      + `trust=${authoritative.sha256}/${authoritative.byteLength})`,
    );
  }
  if (helperPe !== authoritative.peMachine || helperPe !== IMAGE_FILE_MACHINE_AMD64) {
    throw new CopyNativeError(
      `helper PE machine 0x${helperPe.toString(16)} does not match embedded trust`,
    );
  }
  return authoritative;
}

/**
 * @param {Set<string>} ownedTransientPaths
 * @param {string} token
 */
function finalizeOwnedTransients(ownedTransientPaths, token) {
  const remaining = [];
  for (const path of [...ownedTransientPaths]) {
    if (!existsSync(path)) {
      ownedTransientPaths.delete(path);
      continue;
    }
    // Only paths owned by this invocation (token in name).
    if (!path.includes(token)) {
      remaining.push(path);
      continue;
    }
    try {
      withTransientRenameRetry(
        () => {
          rmSync(path, { force: true });
          if (existsSync(path)) {
            const err = new Error(`still exists: ${path}`);
            /** @type {{ code?: string }} */ (err).code = 'EBUSY';
            throw err;
          }
        },
        `finalize ${path}`,
        { maxAttempts: 8 },
      );
      ownedTransientPaths.delete(path);
    } catch {
      remaining.push(path);
    }
  }
  if (remaining.length > 0) {
    throw new CopyNativeError(
      `owned tmp/bak leftovers remain: ${remaining.join('; ')}`,
    );
  }
}

/**
 * @param {string} outDir
 * @param {string} token
 */
function assertNoOwnedLeftovers(outDir, token) {
  if (!existsSync(outDir)) return;
  // Only inspect names that include this invocation's token — never foreign
  // tmp/bak from concurrent or prior runs.
  const leftovers = readdirSync(outDir).filter((name) => name.includes(token));
  if (leftovers.length > 0) {
    throw new CopyNativeError(
      `tmp/bak leftovers after copy (this invocation): ${leftovers.join(', ')}`,
    );
  }
}

/**
 * @param {{
 *   packageRoot?: string,
 *   reentrantToken?: string,
 *   skipLock?: boolean,
 *   validateDestination?: () => void,
 *   sourceExe?: string,
 *   outDir?: string,
 *   __testOnlyAcquireBuildLock?: typeof acquireBuildLock,
 * }} [options]
 */
export function copyNativeHelper(options = {}) {
  // Invocation-local state — never module-scope mutables.
  const packageRoot = resolve(options.packageRoot ?? DEFAULT_PACKAGE_ROOT);
  const replaceToken = `${process.pid}.${randomBytes(8).toString('hex')}`;
  /** @type {Set<string>} */
  const ownedTransientPaths = new Set();

  const sourceExe = resolve(
    options.sourceExe
      ?? join(
        packageRoot,
        'native',
        'TriAgent.ProcessHost',
        'bin',
        'Release',
        'net10.0',
        'win-x64',
        'publish',
        EXACT_SOURCE_NAME,
      ),
  );
  const outDir = resolve(
    options.outDir ?? join(packageRoot, 'dist', 'native', 'win-x64'),
  );
  const outExe = join(outDir, EXACT_SOURCE_NAME);
  const outChecksumJson = join(outDir, 'checksum-metadata.json');
  const outChecksumTxt = join(outDir, 'triagent-process-host.sha256');
  const trustSourcePath = join(
    packageRoot,
    'src',
    'process',
    'generated-native-helper-trust.ts',
  );

  const acquire =
    typeof options.__testOnlyAcquireBuildLock === 'function'
      ? options.__testOnlyAcquireBuildLock
      : acquireBuildLock;

  let lock;
  /** @type {Error | undefined} */
  let lockReleaseError;
  /** @type {{ sha256: string, byteLength: number, peMachine: number, packageRoot: string, outExe: string } | undefined} */
  let result;

  if (options.skipLock !== true) {
    lock = acquire({
      lockRoot: packageRoot,
      reentrantToken:
        options.reentrantToken ?? process.env.TRIAGENT_BUILD_LOCK_TOKEN,
    });
  }

  try {
    assertInsideRoot(packageRoot, sourceExe, 'source helper');
    assertInsideRoot(packageRoot, outExe, 'destination helper');
    assertRegularNonReparseFile(sourceExe, 'published ProcessHost helper');

    const sourceTrust = loadEmbeddedTrustFromSource(trustSourcePath);
    // dist/cli.js is authoritative when present (packaged / after build:node).
    // Source-only trust without a matching bundle must fail if CLI exists and diverges.
    const cliTrust = loadEmbeddedTrustFromCliBundle(packageRoot);
    const source = sha256File(sourceExe);
    const peMachine = readPeMachine(sourceExe);
    const trust = assertTrustAgreement(
      sourceTrust,
      cliTrust,
      source,
      peMachine,
    );

    mkdirSync(outDir, { recursive: true });
    assertInsideRoot(packageRoot, outDir, 'output directory');

    const stagingPath = join(
      outDir,
      `.triagent-process-host.${replaceToken}.tmp`,
    );
    assertInsideRoot(packageRoot, stagingPath, 'staging helper');
    ownedTransientPaths.add(stagingPath);

    if (existsSync(stagingPath)) {
      rmSync(stagingPath, { force: true });
    }
    copyFileSync(sourceExe, stagingPath);
    assertRegularNonReparseFile(stagingPath, 'staged helper');
    const staged = sha256File(stagingPath);
    if (
      staged.sha256 !== trust.sha256
      || staged.byteLength !== trust.byteLength
    ) {
      throw new CopyNativeError(
        'staged helper checksum mismatch vs embedded trust',
      );
    }

    atomicReplaceFile({
      stagingPath,
      destinationPath: outExe,
      label: 'helper-exe',
      token: replaceToken,
      ownedPaths: ownedTransientPaths,
      validateDestination: () => {
        const copied = sha256File(outExe);
        if (
          copied.sha256 !== trust.sha256
          || copied.byteLength !== trust.byteLength
        ) {
          throw new CopyNativeError(
            'copied helper checksum verification failed vs embedded trust',
          );
        }
        const pe = readPeMachine(outExe);
        if (pe !== IMAGE_FILE_MACHINE_AMD64) {
          throw new CopyNativeError(
            `copied helper PE machine 0x${pe.toString(16)} is not win-x64`,
          );
        }
        if (typeof options.validateDestination === 'function') {
          options.validateDestination();
        }
      },
    });

    try {
      chmodSync(outExe, 0o755);
    } catch {
      // Windows may ignore mode bits.
    }

    const metadata = {
      algorithm: 'sha256',
      platform: 'win-x64',
      fileName: EXACT_SOURCE_NAME,
      sha256: trust.sha256,
      byteLength: trust.byteLength,
      peMachine: trust.peMachine,
    };
    writeFileAtomically(
      outChecksumJson,
      `${JSON.stringify(metadata, null, 2)}\n`,
      {
        label: 'checksum-metadata-json',
        token: replaceToken,
        ownedPaths: ownedTransientPaths,
        validateDestination: () => {
          const parsed = JSON.parse(readFileSync(outChecksumJson, 'utf8'));
          if (
            parsed.sha256 !== trust.sha256
            || parsed.byteLength !== trust.byteLength
          ) {
            throw new CopyNativeError(
              'checksum-metadata.json does not match embedded trust',
            );
          }
        },
      },
    );
    writeFileAtomically(
      outChecksumTxt,
      `${trust.sha256}  ${EXACT_SOURCE_NAME}\n`,
      {
        label: 'checksum-sha256-txt',
        token: replaceToken,
        ownedPaths: ownedTransientPaths,
      },
    );

    finalizeOwnedTransients(ownedTransientPaths, replaceToken);
    assertNoOwnedLeftovers(outDir, replaceToken);

    console.log(`Copied ProcessHost -> ${outExe}`);
    console.log(
      `SHA-256 ${trust.sha256} (${trust.byteLength} bytes) [embedded trust]`,
    );
    console.log(`Checksum metadata -> ${outChecksumJson}`);
    // Store result; do not return from try — finally must complete, then we
    // throw release failures or return (return-from-try makes post-finally throws unreachable).
    result = {
      sha256: trust.sha256,
      byteLength: trust.byteLength,
      peMachine,
      packageRoot,
      outExe,
    };
  } finally {
    // Reliable retry cleanup of this invocation's staging only.
    for (const path of [...ownedTransientPaths]) {
      if (!path.includes(replaceToken)) {
        ownedTransientPaths.delete(path);
        continue;
      }
      if (!existsSync(path)) {
        ownedTransientPaths.delete(path);
        continue;
      }
      try {
        withTransientRenameRetry(
          () => {
            rmSync(path, { force: true });
          },
          `finally cleanup ${path}`,
          { maxAttempts: 8 },
        );
        if (!existsSync(path)) {
          ownedTransientPaths.delete(path);
        }
      } catch {
        // leave for operator; still report lock release hard failures below
      }
    }

    if (lock !== undefined) {
      try {
        lock.release();
      } catch (releaseError) {
        // Hard failure — never suppress ownership mismatch.
        lockReleaseError =
          releaseError instanceof Error
            ? releaseError
            : new Error(String(releaseError));
      }
    }
  }

  if (lockReleaseError !== undefined) {
    throw lockReleaseError;
  }
  if (result === undefined) {
    throw new CopyNativeError('copyNativeHelper completed without a result');
  }
  return result;
}

// Re-export for tests
export { atomicReplaceFile };

async function main() {
  let packageRoot;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--package-root=')) {
      packageRoot = arg.slice('--package-root='.length);
    }
  }
  copyNativeHelper({
    ...(packageRoot !== undefined ? { packageRoot } : {}),
    reentrantToken: process.env.TRIAGENT_BUILD_LOCK_TOKEN,
  });
}

const isDirect =
  process.argv[1] !== undefined
  && pathKey(fileURLToPath(import.meta.url))
    === pathKey(resolve(process.argv[1]));

if (isDirect) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
