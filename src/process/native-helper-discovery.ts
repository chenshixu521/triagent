import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EMBEDDED_NATIVE_HELPER_BYTE_LENGTH,
  EMBEDDED_NATIVE_HELPER_FILE_NAME,
  EMBEDDED_NATIVE_HELPER_PE_MACHINE,
  EMBEDDED_NATIVE_HELPER_PLATFORM,
  EMBEDDED_NATIVE_HELPER_RELATIVE_PATH,
  EMBEDDED_NATIVE_HELPER_SHA256,
} from './generated-native-helper-trust.js';

/**
 * Trusted package-relative discovery for the Windows ProcessHost helper.
 *
 * Trust anchor is the EMBEDDED_* constants compiled into dist/cli.js.
 * Adjacent checksum-metadata.json is cross-checked only; replacing exe+metadata
 * without matching embedded constants fails closed.
 *
 * Never searches PATH, cwd, project trees, or temp for substitutes.
 */

export const NATIVE_HELPER_RELATIVE_SEGMENTS = [
  'dist',
  'native',
  'win-x64',
  EMBEDDED_NATIVE_HELPER_FILE_NAME,
] as const;

export const NATIVE_HELPER_RELATIVE_PATH = join(...NATIVE_HELPER_RELATIVE_SEGMENTS);

export const NATIVE_HELPER_CHECKSUM_METADATA_RELATIVE_PATH = join(
  'dist',
  'native',
  'win-x64',
  'checksum-metadata.json',
);

export const IMAGE_FILE_MACHINE_AMD64 = 0x8664 as const;

export interface NativeHelperChecksumMetadata {
  readonly algorithm: 'sha256';
  readonly platform: 'win-x64';
  readonly fileName: 'triagent-process-host.exe';
  readonly sha256: string;
  readonly byteLength: number;
  readonly peMachine?: number;
}

export interface NativeHelperDiscoverySuccess {
  readonly ok: true;
  readonly packageRoot: string;
  readonly helperPath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly metadata: NativeHelperChecksumMetadata;
  readonly peMachine: typeof IMAGE_FILE_MACHINE_AMD64;
  readonly architectureOk: true;
}

export interface NativeHelperDiscoveryFailure {
  readonly ok: false;
  readonly packageRoot?: string;
  readonly helperPath?: string;
  readonly diagnostic: string;
}

export type NativeHelperDiscoveryResult =
  | NativeHelperDiscoverySuccess
  | NativeHelperDiscoveryFailure;

export interface DiscoverNativeHelperOptions {
  readonly packageRoot?: string;
  readonly fromModuleUrl?: string | URL;
  /**
   * Test-only: override embedded trust constants. Production code never sets this.
   * When omitted, EMBEDDED_* from generated-native-helper-trust are used.
   */
  readonly embeddedTrust?: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly peMachine: number;
  };
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;

function pathComparisonKey(input: string): string {
  return process.platform === 'win32'
    ? input.replaceAll('/', '\\').toLocaleLowerCase('en-US')
    : input;
}

function isReparseOrSymlink(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isSymbolicLink();
  } catch {
    // lstat errors are fail-closed by callers — treat as reparse-like anomaly
    return true;
  }
}

/**
 * Walk ancestors from a module path until package.json for triagent-orchestrator.
 */
export function resolvePackageRoot(
  fromModuleUrl: string | URL = import.meta.url,
): string {
  const start =
    typeof fromModuleUrl === 'string' && !fromModuleUrl.startsWith('file:')
      ? resolve(fromModuleUrl)
      : fileURLToPath(fromModuleUrl);
  let current = dirname(start);
  for (let guard = 0; guard < 64; guard += 1) {
    const candidate = join(current, 'package.json');
    if (existsSync(candidate)) {
      try {
        if (isReparseOrSymlink(candidate)) {
          // skip reparse package.json
        } else {
          const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
            name?: string;
          };
          if (
            parsed.name === 'triagent-orchestrator'
            || parsed.name === undefined
          ) {
            return current;
          }
        }
      } catch {
        // ignore unreadable package.json
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`unable to resolve triagent package root from ${start}`);
}

/**
 * Resolve an orchestrator-owned resource from the package that owns a source
 * module or bundled dist entry. Never falls back to cwd, PATH, or project files.
 */
export function resolvePackageResourcePath(
  relativePath: string,
  fromModuleUrl: string | URL = import.meta.url,
): string {
  const trimmed = relativePath.trim();
  if (trimmed.length === 0 || isAbsolute(trimmed)) {
    throw new Error('package resource path must be a non-empty relative path');
  }
  const packageRoot = resolvePackageRoot(fromModuleUrl);
  const resourcePath = resolve(packageRoot, trimmed);
  assertContained(packageRoot, resourcePath);
  return resourcePath;
}

function readChecksumMetadata(path: string): NativeHelperChecksumMetadata {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<NativeHelperChecksumMetadata>;
  if (raw.algorithm !== 'sha256') {
    throw new Error('checksum metadata algorithm must be sha256');
  }
  if (raw.platform !== 'win-x64') {
    throw new Error('checksum metadata platform must be win-x64');
  }
  if (raw.fileName !== 'triagent-process-host.exe') {
    throw new Error('checksum metadata fileName must be triagent-process-host.exe');
  }
  if (typeof raw.sha256 !== 'string' || !SHA256_HEX.test(raw.sha256)) {
    throw new Error('checksum metadata sha256 must be a lowercase 64-hex digest');
  }
  if (
    typeof raw.byteLength !== 'number'
    || !Number.isSafeInteger(raw.byteLength)
    || raw.byteLength <= 0
  ) {
    throw new Error('checksum metadata byteLength must be a positive integer');
  }
  return {
    algorithm: 'sha256',
    platform: 'win-x64',
    fileName: 'triagent-process-host.exe',
    sha256: raw.sha256,
    byteLength: raw.byteLength,
    ...(typeof raw.peMachine === 'number' ? { peMachine: raw.peMachine } : {}),
  };
}

function assertContained(packageRoot: string, absolutePath: string): void {
  const rootResolved = resolve(packageRoot);
  const targetResolved = resolve(absolutePath);
  const rootKey = pathComparisonKey(
    rootResolved.endsWith(sep) ? rootResolved : `${rootResolved}${sep}`,
  );
  const targetKey = pathComparisonKey(targetResolved);
  if (
    targetKey !== pathComparisonKey(rootResolved)
    && !targetKey.startsWith(rootKey)
  ) {
    throw new Error(`path escape rejected: ${absolutePath}`);
  }
}

/**
 * Read PE Machine field. Throws / returns fail for non-PE (no undefined success).
 */
export function readPeMachineRequired(helperPath: string): number {
  let fd: number;
  try {
    fd = openSync(helperPath, 'r');
  } catch (error) {
    throw new Error(
      `unable to open helper for PE parse: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    const dos = Buffer.alloc(64);
    const dosRead = readSync(fd, dos, 0, 64, 0);
    if (dosRead < 64) throw new Error('DOS header too short');
    if (dos.toString('ascii', 0, 2) !== 'MZ') throw new Error('missing MZ signature');
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset > 1024 * 1024) throw new Error('invalid PE offset');
    const pe = Buffer.alloc(6);
    const peRead = readSync(fd, pe, 0, 6, peOffset);
    if (peRead < 6) throw new Error('PE header too short');
    if (pe.toString('ascii', 0, 4) !== 'PE\0\0') {
      throw new Error('missing PE signature');
    }
    return pe.readUInt16LE(4);
  } finally {
    closeSync(fd);
  }
}

/** @deprecated use readPeMachineRequired — undefined architecture is not accepted */
export function readPeMachine(helperPath: string): number | undefined {
  try {
    return readPeMachineRequired(helperPath);
  } catch {
    return undefined;
  }
}

function sha256File(path: string): { readonly sha256: string; readonly byteLength: number } {
  const bytes = readFileSync(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.byteLength,
  };
}

function resolveEmbeddedTrust(
  options: DiscoverNativeHelperOptions,
): { sha256: string; byteLength: number; peMachine: number } {
  if (options.embeddedTrust !== undefined) {
    return options.embeddedTrust;
  }
  return {
    sha256: EMBEDDED_NATIVE_HELPER_SHA256,
    byteLength: EMBEDDED_NATIVE_HELPER_BYTE_LENGTH,
    peMachine: EMBEDDED_NATIVE_HELPER_PE_MACHINE,
  };
}

/**
 * Discover and verify the packaged native helper for real runs.
 * Fail-closed: any anomaly returns ok:false with a diagnostic.
 */
export function discoverNativeHelper(
  options: DiscoverNativeHelperOptions = {},
): NativeHelperDiscoveryResult {
  const trust = resolveEmbeddedTrust(options);

  // Placeholder / unbuilt trust cannot authorize real runs.
  if (
    trust.byteLength <= 0
    || trust.sha256 === '0'.repeat(64)
    || !SHA256_HEX.test(trust.sha256)
  ) {
    return {
      ok: false,
      diagnostic:
        'embedded native helper trust is unset or placeholder; '
        + 'run build:native + generate-native-trust before real runs',
    };
  }
  if (trust.peMachine !== IMAGE_FILE_MACHINE_AMD64) {
    return {
      ok: false,
      diagnostic: `embedded PE machine 0x${trust.peMachine.toString(16)} is not win-x64`,
    };
  }

  let packageRoot: string;
  try {
    packageRoot = options.packageRoot !== undefined
      ? resolve(options.packageRoot)
      : resolvePackageRoot(options.fromModuleUrl ?? import.meta.url);
  } catch (error) {
    return {
      ok: false,
      diagnostic:
        error instanceof Error
          ? error.message
          : `package root resolution failed: ${String(error)}`,
    };
  }

  if (!isAbsolute(packageRoot)) {
    return {
      ok: false,
      packageRoot,
      diagnostic: `package root must be absolute: ${packageRoot}`,
    };
  }

  const helperPath = join(packageRoot, NATIVE_HELPER_RELATIVE_PATH);
  const metadataPath = join(
    packageRoot,
    NATIVE_HELPER_CHECKSUM_METADATA_RELATIVE_PATH,
  );

  // Containment before open/stat/hash.
  try {
    assertContained(packageRoot, helperPath);
    assertContained(packageRoot, metadataPath);
  } catch (error) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }

  // Canonical relative path identity (posix form of embedded relative path).
  const expectedRelative = EMBEDDED_NATIVE_HELPER_RELATIVE_PATH.replaceAll('\\', '/');
  const actualRelative = NATIVE_HELPER_RELATIVE_PATH.replaceAll('\\', '/');
  if (actualRelative !== expectedRelative) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic: `helper relative path mismatch: ${actualRelative} vs ${expectedRelative}`,
    };
  }

  if (!existsSync(helperPath)) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic:
        `native helper missing at package-relative ${NATIVE_HELPER_RELATIVE_PATH}; `
        + 'real runs disabled (never search PATH/cwd for substitutes)',
    };
  }

  let stats;
  try {
    stats = lstatSync(helperPath);
  } catch (error) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic:
        error instanceof Error
          ? `unable to lstat native helper: ${error.message}`
          : 'unable to lstat native helper',
    };
  }

  if (stats.isSymbolicLink()) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic: `native helper is a reparse/symlink; real runs disabled: ${helperPath}`,
    };
  }
  if (!stats.isFile()) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic: `native helper is not a regular file: ${helperPath}`,
    };
  }
  if (typeof stats.nlink !== 'number' || stats.nlink !== 1) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic:
        `native helper hardlink anomaly (nlink=${String(stats.nlink)}); real runs disabled`,
    };
  }

  try {
    const real = realpathSync.native(helperPath);
    if (pathComparisonKey(normalize(real)) !== pathComparisonKey(normalize(helperPath))) {
      if (pathComparisonKey(resolve(real)) !== pathComparisonKey(resolve(helperPath))) {
        return {
          ok: false,
          packageRoot,
          helperPath,
          diagnostic:
            `native helper realpath diverges (possible reparse): ${helperPath} -> ${real}`,
        };
      }
    }
    assertContained(packageRoot, real);
  } catch (error) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic:
        error instanceof Error
          ? `native helper realpath failed: ${error.message}`
          : 'native helper realpath failed',
    };
  }

  // Adjacent metadata is NOT the trust anchor, but when present must match embedded.
  let metadata: NativeHelperChecksumMetadata | undefined;
  if (existsSync(metadataPath)) {
    try {
      if (isReparseOrSymlink(metadataPath)) {
        return {
          ok: false,
          packageRoot,
          helperPath,
          diagnostic: `checksum metadata is a reparse/symlink; real runs disabled: ${metadataPath}`,
        };
      }
      metadata = readChecksumMetadata(metadataPath);
      if (
        metadata.sha256 !== trust.sha256
        || metadata.byteLength !== trust.byteLength
      ) {
        return {
          ok: false,
          packageRoot,
          helperPath,
          diagnostic:
            'adjacent checksum-metadata.json does not match embedded trust constants; '
            + 'real runs disabled (exe+metadata swap rejected)',
        };
      }
    } catch (error) {
      return {
        ok: false,
        packageRoot,
        helperPath,
        diagnostic:
          error instanceof Error
            ? `invalid checksum metadata: ${error.message}`
            : 'invalid checksum metadata',
      };
    }
  } else {
    // Metadata is packaged with the helper; missing is fail-closed for production.
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic:
        `native helper checksum metadata missing at package-relative `
        + `${NATIVE_HELPER_CHECKSUM_METADATA_RELATIVE_PATH}; real runs disabled`,
    };
  }

  let digest: { readonly sha256: string; readonly byteLength: number };
  try {
    digest = sha256File(helperPath);
  } catch (error) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic:
        error instanceof Error
          ? `unable to hash native helper: ${error.message}`
          : 'unable to hash native helper',
    };
  }

  if (digest.sha256 !== trust.sha256 || digest.byteLength !== trust.byteLength) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic:
        `native helper does not match embedded trust `
        + `(actual=${digest.sha256}/${String(digest.byteLength)}, `
        + `embedded=${trust.sha256}/${String(trust.byteLength)}); real runs disabled`,
    };
  }

  try {
    const st = statSync(helperPath);
    if (st.size !== trust.byteLength) {
      return {
        ok: false,
        packageRoot,
        helperPath,
        diagnostic: `native helper stat size mismatch: ${helperPath}`,
      };
    }
  } catch (error) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic:
        error instanceof Error
          ? `unable to re-stat native helper: ${error.message}`
          : 'unable to re-stat native helper',
    };
  }

  // Containment after open/stat/hash.
  try {
    assertContained(packageRoot, helperPath);
  } catch (error) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }

  let peMachine: number;
  try {
    peMachine = readPeMachineRequired(helperPath);
  } catch (error) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic:
        error instanceof Error
          ? `native helper is not a valid PE executable: ${error.message}`
          : 'native helper is not a valid PE executable',
    };
  }
  if (peMachine !== IMAGE_FILE_MACHINE_AMD64 || peMachine !== trust.peMachine) {
    return {
      ok: false,
      packageRoot,
      helperPath,
      diagnostic:
        `native helper PE machine 0x${peMachine.toString(16)} is not win-x64 `
        + `(expected 0x${IMAGE_FILE_MACHINE_AMD64.toString(16)}); real runs disabled`,
    };
  }

  return {
    ok: true,
    packageRoot,
    helperPath,
    sha256: digest.sha256,
    byteLength: digest.byteLength,
    metadata: metadata ?? {
      algorithm: 'sha256',
      platform: EMBEDDED_NATIVE_HELPER_PLATFORM,
      fileName: EMBEDDED_NATIVE_HELPER_FILE_NAME,
      sha256: trust.sha256,
      byteLength: trust.byteLength,
      peMachine: trust.peMachine,
    },
    peMachine: IMAGE_FILE_MACHINE_AMD64,
    architectureOk: true,
  };
}

export function requireNativeHelperPath(
  options: DiscoverNativeHelperOptions = {},
): string {
  const result = discoverNativeHelper(options);
  if (!result.ok) {
    throw new Error(result.diagnostic);
  }
  return result.helperPath;
}
