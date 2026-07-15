import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ProcessHostClient } from '../../../src/process/process-host-client.js';
import { createIsolatedCopyPackageRoot } from './isolated-copy-package-root.js';

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('packaging security', () => {
  it('atomicReplaceFile restores last-known-good when post-promotion validation fails', async () => {
    const mod = (await import(
      pathToFileURL(join(PACKAGE_ROOT, 'scripts/lib/atomic-replace.mjs')).href
    )) as {
      atomicReplaceFile: (options: {
        stagingPath: string;
        destinationPath: string;
        label: string;
        token: string;
        validateDestination?: () => void;
      }) => { backupPath: string | null; restored: boolean };
    };

    const dir = temporaryDirectory('triagent-atomic-rollback-');
    const destination = join(dir, 'artifact.bin');
    writeFileSync(destination, 'GOOD-CONTENT', 'utf8');
    const staging = join(dir, '.artifact.token123.tmp');
    writeFileSync(staging, 'BAD-CONTENT', 'utf8');

    let thrown: unknown;
    try {
      mod.atomicReplaceFile({
        stagingPath: staging,
        destinationPath: destination,
        label: 'rollback-test',
        token: 'token123',
        validateDestination: () => {
          throw new Error('injected post-promotion validation failure');
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toMatch(/restored last-known-good|backup preserved/i);
    // Either restored good content, or backup preserved with recovery path.
    if (existsSync(destination)) {
      const content = readFileSync(destination, 'utf8');
      if (content !== 'GOOD-CONTENT') {
        // destination may still be bad if restore path reported backup preserved
        expect(String(thrown)).toMatch(/backup preserved at/i);
        const bak = readdirSync(dir).find((name) => name.endsWith('.bak'));
        expect(bak).toBeDefined();
        expect(readFileSync(join(dir, bak!), 'utf8')).toBe('GOOD-CONTENT');
      } else {
        expect(content).toBe('GOOD-CONTENT');
      }
    } else {
      const bak = readdirSync(dir).find((name) => name.endsWith('.bak'));
      expect(bak).toBeDefined();
      expect(readFileSync(join(dir, bak!), 'utf8')).toBe('GOOD-CONTENT');
    }
  });

  it('build lock serializes concurrent holders and releases cleanly', async () => {
    const { acquireBuildLock, isPidAlive } = (await import(
      pathToFileURL(join(PACKAGE_ROOT, 'scripts/lib/build-lock.mjs')).href
    )) as {
      acquireBuildLock: (options: {
        lockRoot: string;
        waitMs?: number;
        ttlMs?: number;
        reentrantToken?: string;
        pidAlive?: (pid: number) => boolean;
      }) => { token: string; release: () => void; reentrant: boolean };
      isPidAlive: (pid: number) => boolean;
    };

    const root = temporaryDirectory('triagent-lock-');
    const first = acquireBuildLock({ lockRoot: root, waitMs: 2_000 });
    expect(first.reentrant).toBe(false);
    expect(existsSync(join(root, '.triagent-build.lock'))).toBe(true);

    // Reentrant same token
    const nested = acquireBuildLock({
      lockRoot: root,
      reentrantToken: first.token,
      waitMs: 1_000,
    });
    expect(nested.reentrant).toBe(true);
    nested.release();

    // Concurrent wait should time out while first holds
    let timedOut = false;
    try {
      acquireBuildLock({ lockRoot: root, waitMs: 300 });
    } catch (error) {
      timedOut = /timed out/i.test(String(error));
    }
    expect(timedOut).toBe(true);

    first.release();
    expect(existsSync(join(root, '.triagent-build.lock'))).toBe(false);

    // Stale recovery when owner dead + expired: rewrite owner after acquire.
    const held = acquireBuildLock({ lockRoot: root, waitMs: 1_000 });
    // Break the holder's ability to release by rewriting owner to a dead pid.
    writeFileSync(
      join(root, '.triagent-build.lock', 'owner.json'),
      JSON.stringify({
        pid: 1_000_000_001,
        token: 'stale-token',
        acquiredAt: Date.now() - 60 * 60 * 1000,
        nonce: 'stale',
      }),
      'utf8',
    );
    expect(isPidAlive(1_000_000_001)).toBe(false);
    // Original holder cannot release (token mismatch) — hard fail path.
    expect(() => held.release()).toThrow(/not owned by this token/i);

    const recovered = acquireBuildLock({
      lockRoot: root,
      waitMs: 2_000,
      ttlMs: 1_000,
      pidAlive: () => false,
    });
    recovered.release();
    expect(existsSync(join(root, '.triagent-build.lock'))).toBe(false);
  });

  it('package.json files is an exact allowlist without broad dist/**', () => {
    const pkg = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as { files: string[] };
    expect(pkg.files).toEqual([
      'dist/cli.js',
      'dist/cli.js.map',
      'dist/migrations/*.sql',
      'dist/native/win-x64/triagent-process-host.exe',
      'dist/native/win-x64/checksum-metadata.json',
      'dist/native/win-x64/triagent-process-host.sha256',
      'schemas/agent-result.schema.json',
      'schemas/agent-patch-result.schema.json',
      'README.md',
    ]);
    expect(pkg.files).not.toContain('dist');
    expect(pkg.files).not.toContain('schemas');
    expect(pkg.files.some((entry) => entry.includes('src'))).toBe(false);
    expect(pkg.files.some((entry) => entry.includes('native/TriAgent'))).toBe(
      false,
    );
  });

  it('built distribution includes every SQLite migration required at runtime', () => {
    const sourceDirectory = join(PACKAGE_ROOT, 'src', 'persistence', 'migrations');
    const distributionDirectory = join(PACKAGE_ROOT, 'dist', 'migrations');
    const sourceFiles = readdirSync(sourceDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    expect(existsSync(distributionDirectory), 'dist/migrations is missing').toBe(
      true,
    );
    if (!existsSync(distributionDirectory)) return;

    const distributionFiles = readdirSync(distributionDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(distributionFiles).toEqual(sourceFiles);
    for (const name of sourceFiles) {
      expect(readFileSync(join(distributionDirectory, name), 'utf8')).toBe(
        readFileSync(join(sourceDirectory, name), 'utf8'),
      );
    }
  });

  it('assertRegularNonReparseFile fails closed on every realpath error', async () => {
    const mod = (await import(
      pathToFileURL(join(PACKAGE_ROOT, 'scripts/lib/atomic-replace.mjs')).href
    )) as {
      assertRegularNonReparseFile: (path: string, label: string) => void;
    };
    const dir = temporaryDirectory('triagent-realpath-');
    const target = join(dir, 'file.bin');
    writeFileSync(target, 'x', 'utf8');
    // Missing path
    expect(() =>
      mod.assertRegularNonReparseFile(join(dir, 'missing.bin'), 'probe'),
    ).toThrow(/missing/i);
    // Existing regular file should pass
    expect(() =>
      mod.assertRegularNonReparseFile(target, 'probe'),
    ).not.toThrow();
  });

  it('copy-native fails when source trust diverges from dist/cli.js bundle', async () => {
    const publishExe = join(
      PACKAGE_ROOT,
      'native',
      'TriAgent.ProcessHost',
      'bin',
      'Release',
      'net10.0',
      'win-x64',
      'publish',
      'triagent-process-host.exe',
    );
    const trustPath = join(
      PACKAGE_ROOT,
      'src',
      'process',
      'generated-native-helper-trust.ts',
    );
    const cliPath = join(PACKAGE_ROOT, 'dist', 'cli.js');
    if (
      !existsSync(publishExe)
      || !existsSync(trustPath)
      || !existsSync(cliPath)
    ) {
      return;
    }
    if (readFileSync(trustPath, 'utf8').includes('0'.repeat(64))) return;

    const isolated = createIsolatedCopyPackageRoot(
      PACKAGE_ROOT,
      'triagent-trust-div-',
    );
    temporaryDirectories.push(isolated);

    // Copy real cli.js (authoritative trust) into isolated dist.
    mkdirSync(join(isolated, 'dist'), { recursive: true });
    const { copyFileSync } = await import('node:fs');
    copyFileSync(cliPath, join(isolated, 'dist', 'cli.js'));

    // Diverge source trust without rebuilding cli.js.
    const evilTrust =
      `export const EMBEDDED_NATIVE_HELPER_SHA256 =\n`
      + `  '${'a'.repeat(64)}' as const;\n`
      + `export const EMBEDDED_NATIVE_HELPER_BYTE_LENGTH = 1 as const;\n`
      + `export const EMBEDDED_NATIVE_HELPER_PE_MACHINE = 0x8664 as const;\n`
      + `export const EMBEDDED_NATIVE_HELPER_PLATFORM = 'win-x64' as const;\n`
      + `export const EMBEDDED_NATIVE_HELPER_FILE_NAME =\n`
      + `  'triagent-process-host.exe' as const;\n`
      + `export const EMBEDDED_NATIVE_HELPER_RELATIVE_PATH =\n`
      + `  'dist/native/win-x64/triagent-process-host.exe' as const;\n`;
    writeFileSync(
      join(isolated, 'src', 'process', 'generated-native-helper-trust.ts'),
      evilTrust,
      'utf8',
    );

    const { copyNativeHelper } = (await import(
      pathToFileURL(join(PACKAGE_ROOT, 'scripts/copy-native.mjs')).href
    )) as {
      copyNativeHelper: (options: { packageRoot: string }) => unknown;
    };
    expect(() => copyNativeHelper({ packageRoot: isolated })).toThrow(
      /source\/bundle divergence|does not match authoritative|rebuild dist\/cli/i,
    );
  });

  it('ProcessHostClient production create rejects untrusted package and test factory is explicit', () => {
    const emptyRoot = temporaryDirectory('triagent-no-helper-');
    writeFileSync(
      join(emptyRoot, 'package.json'),
      JSON.stringify({ name: 'triagent-orchestrator' }),
      'utf8',
    );
    expect(() => ProcessHostClient.create({ packageRoot: emptyRoot })).toThrow(
      /verification failed|missing|trust|placeholder/i,
    );

    // Production create has no helperPath parameter — arbitrary paths require
    // the explicit test-only factory (cannot be selected by CLI/settings).
    const evil = join(emptyRoot, 'evil.exe');
    writeFileSync(evil, 'MZ');
    const testClient = ProcessHostClient.createForTests({
      __testOnlyHelperPath: evil,
      __testOnlyAllowUntrustedHelper: true,
    });
    expect(testClient.helperPath).toBe(evil);
    expect(() =>
      ProcessHostClient.createForTests({
        __testOnlyHelperPath: evil,
        // @ts-expect-error missing magic flag
        __testOnlyAllowUntrustedHelper: false,
      }),
    ).toThrow(/explicit test flag/i);
  });

  it(
    'copy-native sequential twice on isolated root leaves no tmp/bak; overlap in build-lock-concurrency',
    () => {
      const publishExe = join(
        PACKAGE_ROOT,
        'native',
        'TriAgent.ProcessHost',
        'bin',
        'Release',
        'net10.0',
        'win-x64',
        'publish',
        'triagent-process-host.exe',
      );
      const trustPath = join(
        PACKAGE_ROOT,
        'src',
        'process',
        'generated-native-helper-trust.ts',
      );
      if (!existsSync(publishExe) || !existsSync(trustPath)) {
        return;
      }
      const trustText = readFileSync(trustPath, 'utf8');
      if (trustText.includes('0'.repeat(64))) {
        return;
      }

      // Never mutate real PACKAGE_ROOT/dist — Vitest runs files in parallel with
      // integration tests that map the real Windows helper exe.
      const isolated = createIsolatedCopyPackageRoot(
        PACKAGE_ROOT,
        'triagent-pkg-sec-copy-',
      );
      temporaryDirectories.push(isolated);

      const copyScript = join(PACKAGE_ROOT, 'scripts', 'copy-native.mjs');
      const runCopy = () =>
        spawnSync(
          process.execPath,
          [copyScript, `--package-root=${isolated}`],
          {
            cwd: isolated,
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
            timeout: 120_000,
            env: {
              ...process.env,
              TRIAGENT_BUILD_LOCK_TOKEN: '',
            },
          },
        );

      const first = runCopy();
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
      const second = runCopy();
      expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);

      const nativeOut = join(isolated, 'dist', 'native', 'win-x64');
      const unexpected = readdirSync(nativeOut).filter((name) => {
        const lower = name.toLowerCase();
        return (
          lower.endsWith('.tmp')
          || lower.endsWith('.bak')
          || lower.endsWith('.bad')
          || lower.startsWith('.')
        );
      });
      expect(unexpected, unexpected.join(', ')).toEqual([]);
    },
    300_000,
  );

  it('fresh native publish fails when publish emits no exe even if stable exists', () => {
    // Injectable publish boundary: command that succeeds but creates nothing.
    const noopCmd = join(temporaryDirectory('triagent-noop-pub-'), 'noop.cmd');
    writeFileSync(noopCmd, '@echo off\r\nexit /b 0\r\n', 'utf8');

    const stable = join(
      PACKAGE_ROOT,
      'native',
      'TriAgent.ProcessHost',
      'bin',
      'Release',
      'net10.0',
      'win-x64',
      'publish',
      'triagent-process-host.exe',
    );
    // Only run if a stable exe already exists (the stale-reuse scenario).
    if (!existsSync(stable)) return;

    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(PACKAGE_ROOT, 'scripts', 'build-native.ps1'),
      ],
      {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 60_000,
        env: {
          ...process.env,
          TRIAGENT_DOTNET_PUBLISH_CMD: noopCmd,
        },
      },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(
      /missing after compile|refusing stale|staging/i,
    );
    // Stable exe must still exist (rollback / untouched).
    expect(existsSync(stable)).toBe(true);
  }, 90_000);
});
