import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { discoverNativeHelper } from '../../../src/process/native-helper-discovery.js';
import { createIsolatedCopyPackageRoot } from './isolated-copy-package-root.js';

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const COPY_NATIVE = join(PACKAGE_ROOT, 'scripts', 'copy-native.mjs');
const ATOMIC = join(PACKAGE_ROOT, 'scripts', 'lib', 'atomic-replace.mjs');
const PUBLISH_EXE = join(
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

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runCopyNativeOnIsolated(isolatedRoot: string): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    [COPY_NATIVE, `--package-root=${isolatedRoot}`],
    {
      cwd: isolatedRoot,
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
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const EXPECTED_NATIVE_OUT_FILES = new Set([
  'triagent-process-host.exe',
  'checksum-metadata.json',
  'triagent-process-host.sha256',
]);

describe('copy-native atomic replace', () => {
  it('imports atomicReplaceFile and replaces an existing destination without delete-then-rename', async () => {
    const mod = (await import(pathToFileURL(ATOMIC).href)) as {
      atomicReplaceFile: (options: {
        stagingPath: string;
        destinationPath: string;
        label: string;
        token: string;
      }) => void;
    };
    expect(typeof mod.atomicReplaceFile).toBe('function');

    const isolated = createIsolatedCopyPackageRoot(
      PACKAGE_ROOT,
      'triagent-atomic-file-',
    );
    temporaryDirectories.push(isolated);
    const dir = join(isolated, 'scratch');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    const destination = join(dir, 'artifact.txt');
    writeFileSync(destination, 'old-content\n', 'utf8');
    const staging = join(dir, '.artifact.staging.tmp');
    writeFileSync(staging, 'new-content\n', 'utf8');
    mod.atomicReplaceFile({
      stagingPath: staging,
      destinationPath: destination,
      label: 'test-artifact',
      token: 'testtoken',
    });

    expect(readFileSync(destination, 'utf8')).toBe('new-content\n');
    expect(existsSync(staging)).toBe(false);
    const leftovers = readdirSync(dir).filter(
      (name) => name.includes('.tmp') || name.includes('.bak'),
    );
    expect(leftovers).toEqual([]);
  });

  it(
    'runs copy-native twice on an isolated package root without EBUSY leftovers',
    () => {
      if (!existsSync(PUBLISH_EXE)) {
        throw new Error(
          `Published helper missing at ${PUBLISH_EXE}. Run npm.cmd run build:native first.`,
        );
      }
      const isolated = createIsolatedCopyPackageRoot(
        PACKAGE_ROOT,
        'triagent-atomic-copy-',
      );
      temporaryDirectories.push(isolated);
      const nativeOut = join(isolated, 'dist', 'native', 'win-x64');

      const first = runCopyNativeOnIsolated(isolated);
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
      expect(existsSync(join(nativeOut, 'triagent-process-host.exe'))).toBe(
        true,
      );
      expect(existsSync(join(nativeOut, 'checksum-metadata.json'))).toBe(true);

      const meta1 = JSON.parse(
        readFileSync(join(nativeOut, 'checksum-metadata.json'), 'utf8'),
      ) as { sha256: string; byteLength: number };

      const second = runCopyNativeOnIsolated(isolated);
      expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);

      const meta2 = JSON.parse(
        readFileSync(join(nativeOut, 'checksum-metadata.json'), 'utf8'),
      ) as { sha256: string; byteLength: number };
      expect(meta2.sha256).toBe(meta1.sha256);
      expect(meta2.byteLength).toBe(meta1.byteLength);

      const unexpected = readdirSync(nativeOut).filter(
        (name) => !EXPECTED_NATIVE_OUT_FILES.has(name),
      );
      expect(
        unexpected,
        `unexpected leftover files: ${unexpected.join(', ')}`,
      ).toEqual([]);

      // Isolated root has trust + helper matching embedded constants; discovery
      // with injected trust from the isolated metadata path is via real package
      // discovery when trust is generated — use packageRoot=isolated with
      // embedded trust from the isolated trust file is not exported; instead
      // verify checksum metadata consistency only (real discovery needs embedded
      // constants from the running module). Real project dist is never mutated.
      expect(meta2.sha256).toMatch(/^[0-9a-f]{64}$/u);
      void discoverNativeHelper;
    },
    180_000,
  );

  it('surfaces lock release ownership mismatch as a hard failure after successful copy work', async () => {
    if (!existsSync(PUBLISH_EXE)) {
      throw new Error(`Published helper missing at ${PUBLISH_EXE}`);
    }
    const isolated = createIsolatedCopyPackageRoot(
      PACKAGE_ROOT,
      'triagent-release-fail-',
    );
    temporaryDirectories.push(isolated);

    const { copyNativeHelper } = (await import(
      pathToFileURL(COPY_NATIVE).href
    )) as {
      copyNativeHelper: (options: {
        packageRoot: string;
        __testOnlyAcquireBuildLock?: (options: {
          lockRoot: string;
          reentrantToken?: string;
        }) => { token: string; release: () => void; reentrant?: boolean };
      }) => { sha256: string };
    };

    expect(() =>
      copyNativeHelper({
        packageRoot: isolated,
        __testOnlyAcquireBuildLock: () => ({
          token: 'test-token',
          reentrant: false,
          release() {
            throw new Error(
              'refusing to release build lock not owned by this token at isolated',
            );
          },
        }),
      }),
    ).toThrow(/not owned by this token|refusing to release/i);

    // Copy artifacts may exist; release failure must still be observable.
    expect(
      existsSync(
        join(isolated, 'dist', 'native', 'win-x64', 'triagent-process-host.exe'),
      ),
    ).toBe(true);
  }, 120_000);
});
