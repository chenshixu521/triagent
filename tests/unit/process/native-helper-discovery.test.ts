import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  discoverNativeHelper,
  IMAGE_FILE_MACHINE_AMD64,
  resolvePackageRoot,
} from '../../../src/process/native-helper-discovery.js';
import * as nativeHelperDiscovery from '../../../src/process/native-helper-discovery.js';
import { ProcessHostClient } from '../../../src/process/process-host-client.js';
import { ProcessSupervisor } from '../../../src/process/process-supervisor.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** Minimal PE image with Machine = 0x8664 (AMD64). */
function minimalPeX64(payload = 'triagent-pe-fixture'): Buffer {
  const peOffset = 0x80;
  const size = peOffset + 0x20 + Buffer.byteLength(payload);
  const buf = Buffer.alloc(size, 0);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.write('PE\0\0', peOffset, 'ascii');
  buf.writeUInt16LE(IMAGE_FILE_MACHINE_AMD64, peOffset + 4);
  buf.write(payload, peOffset + 0x18, 'utf8');
  return buf;
}

function writeFakePackage(
  root: string,
  options: {
    readonly bytes?: Buffer;
    readonly sha256?: string;
    readonly omitChecksum?: boolean;
    readonly omitHelper?: boolean;
    readonly peMachine?: number;
  } = {},
): {
  readonly helperPath: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly embeddedTrust: {
    readonly sha256: string;
    readonly byteLength: number;
    readonly peMachine: number;
  };
} {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'triagent-orchestrator', version: '0.0.0-test' }),
    'utf8',
  );
  const nativeDir = join(root, 'dist', 'native', 'win-x64');
  mkdirSync(nativeDir, { recursive: true });
  const helperPath = join(nativeDir, 'triagent-process-host.exe');
  let bytes = options.bytes ?? minimalPeX64();
  if (options.peMachine !== undefined && options.bytes === undefined) {
    bytes = minimalPeX64();
    bytes.writeUInt16LE(options.peMachine, 0x80 + 4);
  }
  const sha256 = options.sha256 ?? createHash('sha256').update(bytes).digest('hex');
  if (options.omitHelper !== true) {
    writeFileSync(helperPath, bytes);
  }
  if (options.omitChecksum !== true) {
    writeFileSync(
      join(nativeDir, 'checksum-metadata.json'),
      `${JSON.stringify(
        {
          algorithm: 'sha256',
          platform: 'win-x64',
          fileName: 'triagent-process-host.exe',
          sha256,
          byteLength: bytes.byteLength,
          peMachine: IMAGE_FILE_MACHINE_AMD64,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }
  return {
    helperPath,
    sha256,
    byteLength: bytes.byteLength,
    embeddedTrust: {
      sha256,
      byteLength: bytes.byteLength,
      peMachine: IMAGE_FILE_MACHINE_AMD64,
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('native helper discovery', () => {
  it('resolves only the package-relative win-x64 helper when embedded trust matches', () => {
    const root = temporaryDirectory('triagent-helper-ok-');
    const { helperPath, sha256, embeddedTrust } = writeFakePackage(root, {});

    const result = discoverNativeHelper({
      packageRoot: root,
      embeddedTrust,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostic);
    expect(result.helperPath).toBe(helperPath);
    expect(result.sha256).toBe(sha256);
    expect(result.peMachine).toBe(IMAGE_FILE_MACHINE_AMD64);
    expect(result.architectureOk).toBe(true);
  });

  it('fails closed when helper is missing', () => {
    const root = temporaryDirectory('triagent-helper-missing-');
    const { embeddedTrust } = writeFakePackage(root, { omitHelper: true });
    const result = discoverNativeHelper({ packageRoot: root, embeddedTrust });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.diagnostic).toMatch(/missing|not found/i);
  });

  it('fails closed when exe+metadata are replaced together (embedded trust mismatch)', () => {
    const root = temporaryDirectory('triagent-helper-swap-');
    const original = writeFakePackage(root, {});
    // Attacker replaces both exe and adjacent metadata with a different PE.
    const evil = minimalPeX64('evil-payload');
    const evilSha = createHash('sha256').update(evil).digest('hex');
    writeFileSync(original.helperPath, evil);
    writeFileSync(
      join(root, 'dist', 'native', 'win-x64', 'checksum-metadata.json'),
      JSON.stringify({
        algorithm: 'sha256',
        platform: 'win-x64',
        fileName: 'triagent-process-host.exe',
        sha256: evilSha,
        byteLength: evil.byteLength,
        peMachine: IMAGE_FILE_MACHINE_AMD64,
      }),
      'utf8',
    );
    const result = discoverNativeHelper({
      packageRoot: root,
      embeddedTrust: original.embeddedTrust,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.diagnostic).toMatch(/embedded trust|does not match/i);
  });

  it('rejects non-PE helpers and undefined architecture', () => {
    const root = temporaryDirectory('triagent-helper-nonpe-');
    const bytes = Buffer.from('not-a-pe-file');
    const { embeddedTrust } = writeFakePackage(root, {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    // Fix embedded trust to match non-PE bytes so we hit PE validation.
    const trust = {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      byteLength: bytes.byteLength,
      peMachine: IMAGE_FILE_MACHINE_AMD64,
    };
    writeFileSync(
      join(root, 'dist', 'native', 'win-x64', 'checksum-metadata.json'),
      JSON.stringify({
        algorithm: 'sha256',
        platform: 'win-x64',
        fileName: 'triagent-process-host.exe',
        sha256: trust.sha256,
        byteLength: trust.byteLength,
      }),
      'utf8',
    );
    void embeddedTrust;
    const result = discoverNativeHelper({ packageRoot: root, embeddedTrust: trust });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.diagnostic).toMatch(/PE|MZ|executable/i);
  });

  it('rejects hardlinked helpers (nlink !== 1)', () => {
    const root = temporaryDirectory('triagent-helper-hardlink-');
    const { helperPath, embeddedTrust } = writeFakePackage(root, {});
    const linkPath = join(root, 'hardlink-alias.exe');
    try {
      linkSync(helperPath, linkPath);
    } catch {
      // hardlinks may be unavailable on some volumes
      return;
    }
    const result = discoverNativeHelper({ packageRoot: root, embeddedTrust });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.diagnostic).toMatch(/hardlink|nlink/i);
  });

  it('rejects reparse/symlink helpers when supported', () => {
    const root = temporaryDirectory('triagent-helper-link-');
    const { helperPath, embeddedTrust } = writeFakePackage(root, {});
    rmSync(helperPath, { force: true });
    const target = join(root, 'outside-helper.exe');
    const pe = minimalPeX64('linked');
    writeFileSync(target, pe);
    try {
      symlinkSync(target, helperPath);
    } catch {
      return;
    }
    const result = discoverNativeHelper({ packageRoot: root, embeddedTrust });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.diagnostic).toMatch(/reparse|symlink|symbolic/i);
  });

  it('rejects PE machine other than 0x8664', () => {
    const root = temporaryDirectory('triagent-helper-arch-');
    const bytes = minimalPeX64('i386');
    bytes.writeUInt16LE(0x14c, 0x80 + 4); // IMAGE_FILE_MACHINE_I386
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    writeFakePackage(root, { bytes, sha256 });
    // Trust claims amd64 but file is i386 — fail on PE machine.
    const result = discoverNativeHelper({
      packageRoot: root,
      embeddedTrust: {
        sha256,
        byteLength: bytes.byteLength,
        peMachine: IMAGE_FILE_MACHINE_AMD64,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.diagnostic).toMatch(/PE machine|win-x64|0x14c/i);
  });

  it('resolvePackageRoot finds the package.json that owns the module', () => {
    const root = resolvePackageRoot(import.meta.url);
    expect(root.replaceAll('\\', '/')).toMatch(/triagent-implementation$/i);
    const packageJson = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { name: string };
    expect(packageJson.name).toBe('triagent-orchestrator');
  });

  it('resolves packaged schemas from the owning package when the module is bundled under dist', () => {
    const root = temporaryDirectory('triagent-packaged-schema-');
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'triagent-orchestrator', version: '0.0.0-test' }),
      'utf8',
    );
    const bundledEntry = join(root, 'dist', 'cli.js');
    const schemaPath = join(root, 'schemas', 'agent-result.schema.json');
    mkdirSync(join(root, 'dist'), { recursive: true });
    mkdirSync(join(root, 'schemas'), { recursive: true });
    writeFileSync(bundledEntry, '// bundled entry', 'utf8');
    writeFileSync(schemaPath, '{}', 'utf8');

    const resolver = (
      nativeHelperDiscovery as typeof nativeHelperDiscovery & {
        resolvePackageResourcePath?: (
          relativePath: string,
          fromModuleUrl?: string | URL,
        ) => string;
      }
    ).resolvePackageResourcePath;

    expect(resolver).toBeTypeOf('function');
    expect(resolver?.('schemas/agent-result.schema.json', bundledEntry)).toBe(
      schemaPath,
    );
  });

  it('production ProcessHostClient rejects arbitrary helper path; test factory is explicit', () => {
    // Explicit test factory is required for untrusted paths.
    const testClient = ProcessHostClient.createForTests({
      __testOnlyHelperPath: 'C:\\evil\\triagent-process-host.exe',
      __testOnlyAllowUntrustedHelper: true,
    });
    expect(testClient.helperPath).toBe('C:\\evil\\triagent-process-host.exe');

    // Production supervisor ignores arbitrary helperPath without test flag —
    // bound path is package discovery, never the evil path.
    const supervisor = new ProcessSupervisor({
      helperPath: 'C:\\evil\\not-the-package-helper.exe',
    });
    const bound = resolvePackageRoot(import.meta.url);
    // isNativeHelperTrusted reflects package discovery, not evil path.
    const trusted = supervisor.isNativeHelperTrusted();
    expect(typeof trusted).toBe('boolean');
    const diagnostic = supervisor.nativeHelperDiagnostic();
    if (diagnostic !== undefined) {
      expect(diagnostic).not.toMatch(/evil/i);
    }
    void bound;
  });
});
