import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  baselineManifestChecksum,
  loadBaselineManifest,
  type BaselineManifest,
} from '../../../src/tracking/baseline-manifest.js';
import {
  GitClient,
  GitClientError,
  type GitCommandRequest,
} from '../../../src/tracking/git-client.js';
import { GitBaselineService } from '../../../src/tracking/git-baseline-service.js';
import { DiffService } from '../../../src/tracking/diff-service.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix = 'triagent-git-baseline-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function createRepository(): { repository: string; snapshots: string } {
  const root = temporaryDirectory();
  const repository = join(root, 'repo');
  const snapshots = join(root, 'snapshots');
  mkdirSync(repository);
  mkdirSync(snapshots);
  git(repository, 'init', '--initial-branch=main');
  git(repository, 'config', 'user.email', 'triagent@example.invalid');
  git(repository, 'config', 'user.name', 'TriAgent Test');
  git(repository, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repository, 'tracked.txt'), 'committed\n');
  writeFileSync(join(repository, 'rename-me.txt'), 'rename payload\n');
  writeFileSync(join(repository, 'delete-me.txt'), 'delete payload\n');
  git(repository, 'add', '.');
  git(repository, 'commit', '-m', 'initial');
  return { repository, snapshots };
}

function service(repository: string, snapshots: string): GitBaselineService {
  return new GitBaselineService({ projectRoot: repository, snapshotStore: snapshots });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Spawns several real Git processes; under parallel full-suite load cases can
// exceed the default 5s even though solo runs finish around 1.6s.
describe('Git baseline tracking', { timeout: 15_000 }, () => {
  it('captures clean and dirty task-start content without changing staged, unstaged, or untracked status', () => {
    const { repository, snapshots } = createRepository();
    writeFileSync(join(repository, 'staged.txt'), 'already staged\n');
    git(repository, 'add', 'staged.txt');
    writeFileSync(join(repository, 'tracked.txt'), 'pre-task dirty\r\n');
    writeFileSync(join(repository, 'untracked.txt'), 'pre-task untracked\n');
    writeFileSync(join(repository, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(repository, 'ignored.txt'), 'must not be captured\n');
    const beforeStatus = git(repository, 'status', '--porcelain=v2', '-z');

    const baseline = service(repository, snapshots).captureTaskBaseline({
      taskId: 'task-dirty',
      baselineId: 'baseline-task-dirty',
      createdAt: new Date('2026-07-12T00:00:00.000Z'),
    });

    expect(git(repository, 'status', '--porcelain=v2', '-z')).toBe(beforeStatus);
    expect(baseline.status).toBe('complete');
    expect(baseline.kind).toBe('task');
    expect(baseline.git.canonicalRoot).toBe(repository);
    expect(baseline.git.headSha).toMatch(/^[0-9a-f]{40,64}$/);
    expect(baseline.git.branch).toBe('main');
    expect(baseline.files.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['staged.txt', 'tracked.txt', 'untracked.txt']),
    );
    expect(baseline.files.some((entry) => entry.path === 'ignored.txt')).toBe(false);
    expect(loadBaselineManifest(snapshots, baseline.baselineId)).toMatchObject({
      status: 'loaded',
      manifest: { checksum: baseline.checksum },
    });
  });

  it('reports only changes after a dirty task baseline and emits sanitized patches for spaces and Chinese paths', () => {
    const { repository, snapshots } = createRepository();
    writeFileSync(join(repository, 'tracked.txt'), 'dirty before task\r\n');
    writeFileSync(join(repository, 'old-untracked.txt'), 'old dirty\n');
    const tracker = service(repository, snapshots);
    const task = tracker.captureTaskBaseline({
      taskId: 'task-window',
      baselineId: 'baseline-task-window',
    });

    writeFileSync(join(repository, 'tracked.txt'), 'dirty before task\r\nnew task line\r\n');
    writeFileSync(join(repository, '中文 空格.txt'), '第一行\r\n第二行\r\n');
    const changes = new DiffService(tracker).taskWindow(task.baselineId);

    expect(changes.label).toBe('task-window changes');
    expect(changes.changes.map((change) => change.path)).toEqual([
      'tracked.txt',
      '中文 空格.txt',
    ]);
    expect(changes.changes.some((change) => change.path === 'old-untracked.txt')).toBe(false);
    const patch = new DiffService(tracker).patchForFile(
      task.baselineId,
      '中文 空格.txt',
    );
    expect(patch).toContain('a/中文 空格.txt');
    expect(patch).toContain('b/中文 空格.txt');
    expect(patch).not.toContain(repository);
    expect(patch).not.toContain(snapshots);
    expect(patch).not.toMatch(/[A-Za-z]:\\/);
  });

  it('preserves hunk content that looks like patch headers', () => {
    const { repository, snapshots } = createRepository();
    writeFileSync(join(repository, 'header-like.txt'), '-- old marker\n++ old marker\n');
    const tracker = service(repository, snapshots);
    const task = tracker.captureTaskBaseline({
      taskId: 'task-header-like',
      baselineId: 'header-like-base',
    });
    writeFileSync(join(repository, 'header-like.txt'), '-- new marker\n++ new marker\n');

    const patch = new DiffService(tracker).patchForFile(task.baselineId, 'header-like.txt');

    expect(patch).toContain('--- old marker');
    expect(patch).toContain('+++ new marker');
    expect(patch.match(/^--- /gm)).toHaveLength(2);
    expect(patch.match(/^\+\+\+ /gm)).toHaveLength(2);
    expect(patch).toContain('--- a/header-like.txt');
    expect(patch).toContain('+++ b/header-like.txt');
  });

  it('detects binary, rename, delete, untracked add, type change, and avoids ambiguous rename guesses', () => {
    const { repository, snapshots } = createRepository();
    writeFileSync(join(repository, 'duplicate-a.bin'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(repository, 'duplicate-b.bin'), Buffer.from([0, 1, 2, 3]));
    git(repository, 'add', '.');
    git(repository, 'commit', '-m', 'duplicates');
    const tracker = service(repository, snapshots);
    const task = tracker.captureTaskBaseline({
      taskId: 'task-kinds',
      baselineId: 'baseline-task-kinds',
    });

    renameSync(join(repository, 'rename-me.txt'), join(repository, 'renamed.txt'));
    unlinkSync(join(repository, 'delete-me.txt'));
    writeFileSync(join(repository, 'new.bin'), Buffer.from([0, 255, 1, 2, 3]));
    writeFileSync(join(repository, 'new-untracked.txt'), 'new\n');
    unlinkSync(join(repository, 'tracked.txt'));
    mkdirSync(join(repository, 'tracked.txt'));
    writeFileSync(join(repository, 'tracked.txt', 'child.txt'), 'directory replacement\n');
    unlinkSync(join(repository, 'duplicate-a.bin'));
    unlinkSync(join(repository, 'duplicate-b.bin'));
    writeFileSync(join(repository, 'duplicate-new.bin'), Buffer.from([0, 1, 2, 3]));

    const result = new DiffService(tracker).taskWindow(task.baselineId);
    expect(result.renamed).toContainEqual(
      expect.objectContaining({ fromPath: 'rename-me.txt', path: 'renamed.txt' }),
    );
    expect(result.deleted).toContainEqual(expect.objectContaining({ path: 'delete-me.txt' }));
    expect(result.added).toContainEqual(
      expect.objectContaining({ path: 'new.bin', binary: true }),
    );
    const binaryPatch = new DiffService(tracker).patchForFile(task.baselineId, 'new.bin');
    expect(binaryPatch).toContain('GIT binary patch');
    expect(binaryPatch).not.toContain(repository);
    expect(binaryPatch).not.toContain(snapshots);
    expect(result.added).toContainEqual(expect.objectContaining({ path: 'new-untracked.txt' }));
    expect(result.typeChanged).toContainEqual(expect.objectContaining({ path: 'tracked.txt' }));
    expect(result.renamed.some((change) => change.path === 'duplicate-new.bin')).toBe(false);
    expect(result.deleted.map((change) => change.path)).toEqual(
      expect.arrayContaining(['duplicate-a.bin', 'duplicate-b.bin']),
    );
    expect(result.added).toContainEqual(expect.objectContaining({ path: 'duplicate-new.bin' }));
  });

  it('keeps task and second-attempt windows independent while exposing head-to-current', () => {
    const { repository, snapshots } = createRepository();
    const tracker = service(repository, snapshots);
    const task = tracker.captureTaskBaseline({ taskId: 'task-attempts', baselineId: 'task-base' });
    writeFileSync(join(repository, 'first.txt'), 'first attempt\n');
    const first = tracker.captureAttemptBaseline({
      taskId: 'task-attempts',
      baselineId: 'attempt-1-base',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      parentTaskBaselineId: task.baselineId,
    });
    writeFileSync(join(repository, 'first.txt'), 'first attempt\nsecond attempt delta\n');
    writeFileSync(join(repository, 'second.txt'), 'second attempt\n');
    const second = tracker.captureAttemptBaseline({
      taskId: 'task-attempts',
      baselineId: 'attempt-2-base',
      attemptId: 'attempt-2',
      attemptNumber: 2,
      parentTaskBaselineId: task.baselineId,
    });
    writeFileSync(join(repository, 'second.txt'), 'second attempt\nafter second baseline\n');

    const diffs = new DiffService(tracker);
    expect(diffs.taskWindow(task.baselineId).changes.map((change) => change.path)).toEqual([
      'first.txt',
      'second.txt',
    ]);
    expect(diffs.attemptWindow(first.baselineId).changes.map((change) => change.path)).toEqual([
      'first.txt',
      'second.txt',
    ]);
    expect(diffs.attemptWindow(second.baselineId).changes.map((change) => change.path)).toEqual([
      'second.txt',
    ]);
    expect(second.parentTaskBaselineId).toBe(task.baselineId);
    expect(second.attemptNumber).toBe(2);
    expect(diffs.headToCurrent()).toContain('first.txt');
  }, 15_000);

  it('deduplicates content blobs and rejects incomplete or checksum-corrupt manifests', () => {
    const { repository, snapshots } = createRepository();
    writeFileSync(join(repository, 'same-a.txt'), 'same content\n');
    writeFileSync(join(repository, 'same-b.txt'), 'same content\n');
    const tracker = service(repository, snapshots);
    const baseline = tracker.captureTaskBaseline({ taskId: 'task-blobs', baselineId: 'blob-base' });
    const sameEntries = baseline.files.filter((entry) => entry.path.startsWith('same-'));
    expect(sameEntries).toHaveLength(2);
    expect(sameEntries[0]?.blobHash).toBe(sameEntries[1]?.blobHash);
    const blobFiles = readdirSync(join(snapshots, 'blobs', 'sha256'));
    expect(blobFiles.filter((name) => name === sameEntries[0]?.blobHash)).toHaveLength(1);

    const incompleteDirectory = join(snapshots, 'baselines', 'incomplete');
    mkdirSync(incompleteDirectory, { recursive: true });
    writeFileSync(join(incompleteDirectory, 'manifest.json'), JSON.stringify({ status: 'building' }));
    expect(loadBaselineManifest(snapshots, 'incomplete')).toMatchObject({
      status: 'ignored',
      diagnostic: expect.stringMatching(/complete|building|marker/i),
    });

    const manifestPath = join(snapshots, 'baselines', baseline.baselineId, 'manifest.json');
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    parsed.taskId = 'tampered';
    writeFileSync(manifestPath, JSON.stringify(parsed));
    expect(loadBaselineManifest(snapshots, baseline.baselineId)).toMatchObject({
      status: 'ignored',
      diagnostic: expect.stringMatching(/checksum/i),
    });
  });

  it('rejects checksum-valid semantic corruption and cross-project, cross-task, or wrong-parent loads', () => {
    const { repository, snapshots } = createRepository();
    const tracker = service(repository, snapshots);
    const task = tracker.captureTaskBaseline({
      taskId: 'task-identity',
      baselineId: 'identity-task-base',
    });
    const attempt = tracker.captureAttemptBaseline({
      taskId: 'task-identity',
      baselineId: 'identity-attempt-base',
      attemptId: 'attempt-identity',
      attemptNumber: 1,
      parentTaskBaselineId: task.baselineId,
    });

    expect(
      tracker.loadBaseline(task.baselineId, { taskId: 'wrong-task' }),
    ).toMatchObject({ status: 'ignored', diagnostic: expect.stringMatching(/task/i) });
    expect(
      tracker.loadBaseline(attempt.baselineId, {
        taskId: 'task-identity',
        parentTaskBaselineId: 'wrong-parent',
      }),
    ).toMatchObject({ status: 'ignored', diagnostic: expect.stringMatching(/parent/i) });

    const second = createRepository();
    const otherProjectTracker = service(second.repository, snapshots);
    expect(otherProjectTracker.loadBaseline(task.baselineId)).toMatchObject({
      status: 'ignored',
      diagnostic: expect.stringMatching(/project|root/i),
    });

    const manifestPath = join(snapshots, 'baselines', attempt.baselineId, 'manifest.json');
    const markerPath = join(snapshots, 'baselines', attempt.baselineId, 'complete.marker');
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as BaselineManifest;
    const { checksum: _checksum, ...withoutChecksum } = parsed;
    const semanticallyInvalid = { ...withoutChecksum, attemptNumber: 0 };
    const checksum = baselineManifestChecksum(
      semanticallyInvalid as Omit<BaselineManifest, 'checksum'>,
    );
    writeFileSync(manifestPath, JSON.stringify({ ...semanticallyInvalid, checksum }));
    writeFileSync(markerPath, `${checksum}\n`);

    expect(
      loadBaselineManifest(snapshots, attempt.baselineId, {
        expectedProjectRoot: repository,
        taskId: 'task-identity',
        parentTaskBaselineId: task.baselineId,
      }),
    ).toMatchObject({
      status: 'ignored',
      diagnostic: expect.stringMatching(/attemptNumber|positive|semantic/i),
    });
  });

  it('rejects checksum-valid blob size, binary, and symlink-target semantic corruption', () => {
    const { repository, snapshots } = createRepository();
    writeFileSync(join(repository, 'semantic.bin'), Buffer.from([0, 1, 2, 3, 4]));
    const tracker = service(repository, snapshots);
    const baseline = tracker.captureTaskBaseline({
      taskId: 'task-blob-semantics',
      baselineId: 'blob-semantics-base',
    });
    const manifestPath = join(snapshots, 'baselines', baseline.baselineId, 'manifest.json');
    const markerPath = join(snapshots, 'baselines', baseline.baselineId, 'complete.marker');
    const original = JSON.parse(readFileSync(manifestPath, 'utf8')) as BaselineManifest;

    function writeChecksumValid(
      mutate: (manifest: Record<string, unknown>) => void,
    ): void {
      const clone = structuredClone(original) as unknown as Record<string, unknown>;
      mutate(clone);
      const { checksum: _checksum, ...withoutChecksum } = clone;
      const checksum = baselineManifestChecksum(
        withoutChecksum as Omit<BaselineManifest, 'checksum'>,
      );
      writeFileSync(manifestPath, JSON.stringify({ ...withoutChecksum, checksum }));
      writeFileSync(markerPath, `${checksum}\n`);
    }

    writeChecksumValid((manifest) => {
      const files = manifest.files as Array<Record<string, unknown>>;
      const tracked = files.find((entry) => entry.path === 'tracked.txt')!;
      tracked.size = Number(tracked.size) + 1;
    });
    expect(loadBaselineManifest(snapshots, baseline.baselineId)).toMatchObject({
      status: 'ignored',
      diagnostic: expect.stringMatching(/size|blob/i),
    });

    writeChecksumValid((manifest) => {
      const files = manifest.files as Array<Record<string, unknown>>;
      const binary = files.find((entry) => entry.path === 'semantic.bin')!;
      binary.binary = false;
    });
    expect(loadBaselineManifest(snapshots, baseline.baselineId)).toMatchObject({
      status: 'ignored',
      diagnostic: expect.stringMatching(/binary|blob/i),
    });

    writeChecksumValid((manifest) => {
      const files = manifest.files as Array<Record<string, unknown>>;
      const tracked = files.find((entry) => entry.path === 'tracked.txt')!;
      tracked.type = 'symlink';
      tracked.executable = false;
      tracked.binary = false;
      tracked.linkTarget = 'tampered-target';
      tracked.reparseEvidence = {
        kind: 'symbolic-link-or-reparse-point',
        linkTarget: 'tampered-target',
      };
    });
    expect(loadBaselineManifest(snapshots, baseline.baselineId)).toMatchObject({
      status: 'ignored',
      diagnostic: expect.stringMatching(/symlink|linkTarget|blob/i),
    });
  });

  it('fails atomically when a file remains unstable across bounded read retries', () => {
    const { repository, snapshots } = createRepository();
    writeFileSync(join(repository, 'unstable.txt'), '0\n');
    let mutations = 0;
    const tracker = new GitBaselineService({
      projectRoot: repository,
      snapshotStore: snapshots,
      maxReadAttempts: 2,
      fileReadHook(path) {
        if (path === 'unstable.txt') {
          mutations += 1;
          writeFileSync(join(repository, path), `${String(mutations)}-${'x'.repeat(mutations)}\n`);
        }
      },
    });

    expect(() =>
      tracker.captureTaskBaseline({ taskId: 'task-unstable', baselineId: 'unstable-base' }),
    ).toThrow(/unstable|changed while reading/i);
    expect(existsSync(join(snapshots, 'baselines', 'unstable-base'))).toBe(false);
    const baselinesDirectory = join(snapshots, 'baselines');
    expect(
      existsSync(baselinesDirectory)
        ? readdirSync(baselinesDirectory).some((name) => name.startsWith('.tmp-'))
        : false,
    ).toBe(false);
  });

  it('retries the whole scan when an early file changes while a later file is scanned', () => {
    const { repository, snapshots } = createRepository();
    writeFileSync(join(repository, 'a-early.txt'), 'early-v0\n');
    writeFileSync(join(repository, 'z-trigger.txt'), 'trigger\n');
    let triggerScans = 0;
    const tracker = new GitBaselineService({
      projectRoot: repository,
      snapshotStore: snapshots,
      maxScanAttempts: 2,
      fileReadHook(path) {
        if (path === 'z-trigger.txt') {
          triggerScans += 1;
          if (triggerScans === 1) {
            writeFileSync(join(repository, 'a-early.txt'), 'early-v1-after-first-scan\n');
          }
        }
      },
    });

    const baseline = tracker.captureTaskBaseline({
      taskId: 'task-whole-scan-retry',
      baselineId: 'whole-scan-retry-base',
    });

    expect(triggerScans).toBe(2);
    const early = baseline.files.find((entry) => entry.path === 'a-early.txt');
    expect(early?.blobHash).not.toBeNull();
    expect(tracker.readBlob(early!.blobHash!).toString('utf8')).toBe(
      'early-v1-after-first-scan\n',
    );
  });

  it('does not persist a complete baseline when whole-scan verification never stabilizes', () => {
    const { repository, snapshots } = createRepository();
    writeFileSync(join(repository, 'a-early.txt'), 'early-v0\n');
    writeFileSync(join(repository, 'z-trigger.txt'), 'trigger\n');
    let generation = 0;
    const tracker = new GitBaselineService({
      projectRoot: repository,
      snapshotStore: snapshots,
      maxScanAttempts: 2,
      fileReadHook(path) {
        if (path === 'z-trigger.txt') {
          generation += 1;
          writeFileSync(join(repository, 'a-early.txt'), `early-v${String(generation)}\n`);
        }
      },
    });

    expect(() =>
      tracker.captureTaskBaseline({
        taskId: 'task-whole-scan-fail',
        baselineId: 'whole-scan-fail-base',
      }),
    ).toThrow(/whole scan|working tree.*unstable|verification/i);
    expect(generation).toBe(2);
    expect(existsSync(join(snapshots, 'baselines', 'whole-scan-fail-base'))).toBe(false);
  });

  it('records deleted tracked files and symlink evidence without following links when supported', () => {
    const { repository, snapshots } = createRepository();
    unlinkSync(join(repository, 'delete-me.txt'));
    let symlinkCreated = false;
    try {
      symlinkSync('tracked.txt', join(repository, 'link-to-tracked'));
      symlinkCreated = true;
    } catch {
      // Windows may deny symlink creation without Developer Mode or privilege.
    }
    const baseline = service(repository, snapshots).captureTaskBaseline({
      taskId: 'task-links',
      baselineId: 'links-base',
    });
    expect(baseline.files).toContainEqual(
      expect.objectContaining({ path: 'delete-me.txt', missing: true }),
    );
    if (symlinkCreated) {
      expect(baseline.files).toContainEqual(
        expect.objectContaining({
          path: 'link-to-tracked',
          type: 'symlink',
          linkTarget: 'tracked.txt',
        }),
      );
    }
  });

  it('records executable evidence where the platform supports it', () => {
    const { repository, snapshots } = createRepository();
    const executable = join(repository, 'script.sh');
    writeFileSync(executable, '#!/bin/sh\necho ok\n');
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
    const baseline = service(repository, snapshots).captureTaskBaseline({
      taskId: 'task-mode',
      baselineId: 'mode-base',
    });
    expect(baseline.files.find((entry) => entry.path === 'script.sh')?.executable).toBe(
      process.platform === 'win32' ? false : true,
    );
  });

  it('rejects a snapshot store whose real junction or symlink target is inside the repository', () => {
    const { repository } = createRepository();
    const root = temporaryDirectory('triagent-store-reparse-');
    const junction = join(root, 'outside-looking-store');
    symlinkSync(repository, junction, process.platform === 'win32' ? 'junction' : 'dir');
    const snapshotsThroughReparsePoint = join(junction, 'snapshots');
    const beforeStatus = git(repository, 'status', '--porcelain=v2', '-z');

    expect(() =>
      new GitBaselineService({
        projectRoot: repository,
        snapshotStore: snapshotsThroughReparsePoint,
      }).captureTaskBaseline({
        taskId: 'task-reparse-store',
        baselineId: 'reparse-store-base',
      }),
    ).toThrow(/SnapshotStoreInsideProject|ReparseEscape|snapshot.*project/i);

    expect(git(repository, 'status', '--porcelain=v2', '-z')).toBe(beforeStatus);
    expect(existsSync(join(repository, 'snapshots'))).toBe(false);
  });
});

describe('GitClient fail-closed boundaries', () => {
  it('has no write API and rejects write commands even through runtime casts', () => {
    const { repository } = createRepository();
    const client = new GitClient(repository);
    const unsafe = client as unknown as {
      inspect(command: string, args?: readonly string[]): unknown;
      reset?: unknown;
      checkout?: unknown;
      clean?: unknown;
      commit?: unknown;
      add?: unknown;
      merge?: unknown;
      rebase?: unknown;
      push?: unknown;
    };
    expect(unsafe.reset).toBeUndefined();
    expect(unsafe.checkout).toBeUndefined();
    expect(unsafe.clean).toBeUndefined();
    expect(unsafe.commit).toBeUndefined();
    expect(unsafe.add).toBeUndefined();
    expect(unsafe.merge).toBeUndefined();
    expect(unsafe.rebase).toBeUndefined();
    expect(unsafe.push).toBeUndefined();
    for (const command of ['reset', 'checkout', 'clean', 'commit', 'add', 'merge', 'rebase', 'push']) {
      expect(() => unsafe.inspect(command)).toThrow(/read-only|not allowed/i);
    }
  });

  it('bounds the runner, clears repository-shaping Git environment case-insensitively, and fails closed', () => {
    const { repository } = createRepository();
    const original = { ...process.env };
    process.env.GIT_DIR = 'poison';
    process.env.git_work_tree = 'poison-lower';
    const requests: GitCommandRequest[] = [];
    try {
      const client = new GitClient(repository, {
        runner(request) {
          requests.push(request);
          return {
            status: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
          };
        },
      });
      expect(() => client.repositoryIdentity()).toThrow(GitClientError);
      expect(requests[0]).toMatchObject({ windowsHide: true });
      expect(requests[0]?.timeoutMs).toBeGreaterThan(0);
      expect(requests[0]?.maxBuffer).toBeGreaterThan(0);
      expect(Object.keys(requests[0]?.env ?? {}).some((key) => key.toUpperCase() === 'GIT_DIR')).toBe(false);
      expect(
        Object.keys(requests[0]?.env ?? {}).some((key) => key.toUpperCase() === 'GIT_WORK_TREE'),
      ).toBe(false);
    } finally {
      process.env = original;
    }
  });

  it('rejects malformed command output and a selected nested root', () => {
    const { repository, snapshots } = createRepository();
    const malformed = new GitClient(repository, {
      runner(request) {
        return {
          status: 0,
          stdout: Buffer.from(request.args.includes('--show-toplevel') ? 'relative/path\n' : 'x\n'),
          stderr: Buffer.alloc(0),
        };
      },
    });
    expect(() => malformed.repositoryIdentity()).toThrow(/absolute|top-level|malformed/i);

    const nested = join(repository, 'nested');
    mkdirSync(nested);
    expect(() => service(nested, snapshots).captureTaskBaseline({
      taskId: 'task-nested',
      baselineId: 'nested-base',
    })).toThrow(/top-level|canonical project root|nested/i);
  });
});
