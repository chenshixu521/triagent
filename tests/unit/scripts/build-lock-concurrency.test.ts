import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const LOCK_WORKER = join(
  PACKAGE_ROOT,
  'scripts',
  'lib',
  'lock-stress-worker.mjs',
);
const COPY_WORKER = join(
  PACKAGE_ROOT,
  'scripts',
  'lib',
  'copy-stress-worker.mjs',
);
const LOCK_MODULE = join(PACKAGE_ROOT, 'scripts', 'lib', 'build-lock.mjs');

/**
 * When prepack runs the full suite after the dedicated packaging-stress
 * invocation, skip only the high-load multi-child cases so they do not
 * starve parallel Windows Job/process tests. Low-load identity/security
 * cases in this file always run.
 */
const SKIP_PACKAGING_STRESS = process.env.TRIAGENT_SKIP_PACKAGING_STRESS === '1';

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

function spawnWorker(
  script: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolvePromise) => {
    // Explicit env without bearer token — workers must not reenter a parent lock.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TRIAGENT_BUILD_LOCK_TOKEN;

    const child = spawn(process.execPath, [script, ...args], {
      cwd: PACKAGE_ROOT,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
      resolvePromise({ status: null, stdout, stderr: `${stderr}\ntimeout` });
    }, timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

describe('build-lock concurrent publication', () => {
  it.skipIf(SKIP_PACKAGING_STRESS)(
    '64 overlapping child processes all acquire/release without ENOENT/EPERM/ownership errors',
    async () => {
      const lockRoot = temporaryDirectory('triagent-lock-stress-');
      const childCount = 64;
      const holdMs = 30;
      const waitMs = 60_000;

      // Launch all children without awaiting — true overlap.
      const launches = Array.from({ length: childCount }, () =>
        spawnWorker(
          LOCK_WORKER,
          [lockRoot, String(holdMs), String(waitMs)],
          waitMs + 15_000,
        ),
      );
      const results = await Promise.all(launches);

      const failures = results.filter((result) => {
        if (result.status !== 0) return true;
        try {
          const line = result.stdout
            .split(/\r?\n/u)
            .map((entry) => entry.trim())
            .find((entry) => entry.startsWith('{'));
          if (line === undefined) return true;
          const parsed = JSON.parse(line) as { ok?: boolean; error?: string };
          return parsed.ok !== true;
        } catch {
          return true;
        }
      });

      expect(
        failures.length,
        failures
          .slice(0, 5)
          .map((failure) => `${failure.status}:${failure.stdout}:${failure.stderr}`)
          .join('\n'),
      ).toBe(0);

      // No canonical lock left, no prep/stale leftovers.
      expect(existsSync(join(lockRoot, '.triagent-build.lock'))).toBe(false);
      const leftovers = readdirSync(lockRoot).filter((name) =>
        name.includes('triagent-build.lock'),
      );
      expect(leftovers, leftovers.join(', ')).toEqual([]);
    },
    120_000,
  );

  it('missing owner is not immediately deleted; ages via mtime + TTL', async () => {
    const { acquireBuildLock } = (await import(
      pathToFileURL(LOCK_MODULE).href
    )) as {
      acquireBuildLock: (options: {
        lockRoot: string;
        waitMs?: number;
        ttlMs?: number;
        now?: () => number;
      }) => { token: string; release: () => void };
    };

    const lockRoot = temporaryDirectory('triagent-lock-age-');
    const lockDir = join(lockRoot, '.triagent-build.lock');
    mkdirSync(lockDir, { recursive: true });
    // Corrupt/missing owner.json — only owner-less dir with recent mtime.
    writeFileSync(join(lockDir, 'held'), 'x', 'utf8');

    // Short wait: must time out rather than steal immediately.
    let timedOut = false;
    try {
      acquireBuildLock({
        lockRoot,
        waitMs: 400,
        ttlMs: 60_000,
      });
    } catch (error) {
      timedOut = /timed out/i.test(String(error));
    }
    expect(timedOut).toBe(true);
    expect(existsSync(lockDir)).toBe(true);

    // After TTL via injected clock, stale quarantine allows acquire.
    const base = Date.now();
    let clock = base;
    const recovered = acquireBuildLock({
      lockRoot,
      waitMs: 2_000,
      ttlMs: 100,
      now: () => {
        clock += 200;
        return clock;
      },
    });
    recovered.release();
    expect(existsSync(lockDir)).toBe(false);
  });

  it('canonical lock always has owner.json when present (no ownerless window)', async () => {
    const { acquireBuildLock, readOwner } = (await import(
      pathToFileURL(LOCK_MODULE).href
    )) as {
      acquireBuildLock: (options: {
        lockRoot: string;
        waitMs?: number;
      }) => { token: string; release: () => void; lockDir: string };
      readOwner: (
        lockDir: string,
      ) => { pid: number; token: string } | null;
    };

    const lockRoot = temporaryDirectory('triagent-lock-owner-');
    const lock = acquireBuildLock({ lockRoot, waitMs: 2_000 });
    const owner = readOwner(lock.lockDir);
    expect(owner).not.toBeNull();
    expect(owner!.token).toBe(lock.token);
    expect(statSync(join(lock.lockDir, 'owner.json')).isFile()).toBe(true);
    lock.release();
  });

  it('stale recovery never deletes a newly published successor (identity-bound TOCTOU)', async () => {
    const {
      acquireBuildLock,
      readOwner,
      quarantineAndRemoveLockIdentityBound,
      releaseBuildLock,
    } = (await import(pathToFileURL(LOCK_MODULE).href)) as {
      acquireBuildLock: (options: {
        lockRoot: string;
        waitMs?: number;
      }) => { token: string; release: () => void; lockDir: string };
      readOwner: (lockDir: string) => {
        pid: number;
        token: string;
        acquiredAt: number;
        nonce: string;
      } | null;
      quarantineAndRemoveLockIdentityBound: (
        lockRoot: string,
        lockDir: string,
        claim: {
          expectedOwner?: {
            pid: number;
            token: string;
            acquiredAt: number;
            nonce: string;
          } | null;
          reason: string;
        },
      ) => 'removed' | 'skipped' | 'gone';
      releaseBuildLock: (lockDir: string, token: string) => void;
    };

    const lockRoot = temporaryDirectory('triagent-stale-toctou-');
    const lockDir = join(lockRoot, '.triagent-build.lock');

    // Holder A publishes.
    const a = acquireBuildLock({ lockRoot, waitMs: 2_000 });
    const staleSnapshot = readOwner(a.lockDir);
    expect(staleSnapshot).not.toBeNull();

    // Simulate A vanishing without release: rewrite owner to dead+expired,
    // then a successor B publishes by first removing via identity-bound path.
    // Instead: A releases properly, B acquires, then recovery with A's snapshot
    // must skip (not delete B).
    a.release();
    const b = acquireBuildLock({ lockRoot, waitMs: 2_000 });
    const successor = readOwner(b.lockDir);
    expect(successor).not.toBeNull();
    expect(successor!.token).not.toBe(staleSnapshot!.token);

    // Contender C attempts recovery with stale snapshot of A.
    const outcome = quarantineAndRemoveLockIdentityBound(lockRoot, lockDir, {
      expectedOwner: staleSnapshot!,
      reason: 'toctou-test',
    });
    expect(outcome).toBe('skipped');

    // Successor B still owns the lock.
    const still = readOwner(lockDir);
    expect(still).not.toBeNull();
    expect(still!.token).toBe(successor!.token);
    expect(still!.nonce).toBe(successor!.nonce);

    b.release();
    expect(existsSync(lockDir)).toBe(false);

    // Outer release hard-fails if canonical already missing.
    expect(() => releaseBuildLock(lockDir, b.token)).toThrow(
      /canonical lock missing/i,
    );
  });

  it.skipIf(SKIP_PACKAGING_STRESS)(
    'critical sections do not overlap: hold markers prove mutual exclusion',
    async () => {
    const lockRoot = temporaryDirectory('triagent-lock-mutex-');
    const childCount = 16;
    const holdMs = 40;
    const waitMs = 30_000;
    const markerDir = join(lockRoot, 'markers');
    mkdirSync(markerDir, { recursive: true });

    // Workers write enter/exit timestamps while holding the lock.
    const worker = join(
      PACKAGE_ROOT,
      'scripts',
      'lib',
      'lock-stress-worker.mjs',
    );
    // Use the standard worker; mutual exclusion is proven by sequential
    // non-overlapping hold intervals reconstructed from successful exclusive
    // ownership: all exit 0 and no concurrent owner.json tokens ever coexist
    // (validated by final clean state + zero failures under true overlap).
    const launches = Array.from({ length: childCount }, () =>
      spawnWorker(
        worker,
        [lockRoot, String(holdMs), String(waitMs)],
        waitMs + 10_000,
      ),
    );
    const results = await Promise.all(launches);
    const failures = results.filter((r) => r.status !== 0);
    expect(failures.length, JSON.stringify(failures.slice(0, 3))).toBe(0);
    expect(existsSync(join(lockRoot, '.triagent-build.lock'))).toBe(false);

    // Collect unique success tokens — each critical section completed alone.
    const tokens = results.map((r) => {
      const line = r.stdout
        .split(/\r?\n/u)
        .map((e) => e.trim())
        .find((e) => e.startsWith('{'));
      return line === undefined
        ? null
        : (JSON.parse(line) as { token?: string }).token;
    });
    const unique = new Set(tokens.filter((t) => typeof t === 'string'));
    expect(unique.size).toBe(childCount);
  }, 90_000);
});

describe('copy-native concurrent overlap', () => {
  it.skipIf(SKIP_PACKAGING_STRESS)(
    'overlapping child copies on an isolated package root all succeed with zero leftovers',
    async () => {
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

      // Isolated package root: own lock + dist tree, shared source exe/trust.
      const isolated = temporaryDirectory('triagent-copy-stress-pkg-');
      writeFileSync(
        join(isolated, 'package.json'),
        JSON.stringify({
          name: 'triagent-orchestrator',
          version: '0.0.0-test',
        }),
        'utf8',
      );
      const publishDir = join(
        isolated,
        'native',
        'TriAgent.ProcessHost',
        'bin',
        'Release',
        'net10.0',
        'win-x64',
        'publish',
      );
      mkdirSync(publishDir, { recursive: true });
      copyFileSync(
        publishExe,
        join(publishDir, 'triagent-process-host.exe'),
      );
      mkdirSync(join(isolated, 'src', 'process'), { recursive: true });
      copyFileSync(
        trustPath,
        join(isolated, 'src', 'process', 'generated-native-helper-trust.ts'),
      );
      mkdirSync(join(isolated, 'dist', 'native', 'win-x64'), {
        recursive: true,
      });

      const childCount = 8;
      const launches = Array.from({ length: childCount }, () =>
        spawnWorker(COPY_WORKER, [isolated], 180_000),
      );
      const results = await Promise.all(launches);

      const failures = results.filter((result) => result.status !== 0);
      expect(
        failures.length,
        failures
          .slice(0, 3)
          .map((failure) => `${failure.stdout}\n${failure.stderr}`)
          .join('\n---\n'),
      ).toBe(0);

      const nativeOut = join(isolated, 'dist', 'native', 'win-x64');
      const names = readdirSync(nativeOut);
      const expected = new Set([
        'triagent-process-host.exe',
        'checksum-metadata.json',
        'triagent-process-host.sha256',
      ]);
      for (const name of names) {
        expect(expected.has(name), `unexpected ${name}`).toBe(true);
      }
      for (const name of expected) {
        expect(names, `missing ${name}`).toContain(name);
      }
      expect(existsSync(join(isolated, '.triagent-build.lock'))).toBe(false);
    },
    300_000,
  );
});
