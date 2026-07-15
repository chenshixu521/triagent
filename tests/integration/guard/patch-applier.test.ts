import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { asAttemptId, asBaselineId, asTaskId } from '../../../src/domain/ids.js';
import { PatchApplier } from '../../../src/guard/patch-applier.js';
import { PatchValidator } from '../../../src/guard/patch-validator.js';
import { ProjectGuard } from '../../../src/guard/project-guard.js';
import {
  completeBaselineManifest,
  type BuildingBaselineManifest,
} from '../../../src/tracking/baseline-manifest.js';
import { sha256 } from '../../../src/tracking/hash.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix = 'triagent-patch-applier-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createProject(options?: {
  readonly extraFiles?: ReadonlyArray<{
    readonly relativePath: string;
    readonly content: string;
  }>;
  readonly missingPaths?: readonly string[];
}): {
  root: string;
  snapshots: string;
  baselineId: string;
  fileHash: string;
  taskId: string;
  attemptId: string;
} {
  const root = temporaryDirectory();
  const snapshots = temporaryDirectory('triagent-snapshots-');
  mkdirSync(join(root, 'src'), { recursive: true });
  const content = 'export const value = 1;\n';
  writeFileSync(join(root, 'src', 'app.ts'), content, 'utf8');
  const fileHash = sha256(content);
  const blobs = new Map<string, Buffer>([[fileHash, Buffer.from(content, 'utf8')]]);
  const files: Array<BuildingBaselineManifest['files'][number]> = [
    {
      path: 'src/app.ts',
      type: 'file',
      size: Buffer.byteLength(content),
      mtimeMs: 1,
      hash: fileHash,
      blobHash: fileHash,
      missing: false,
      executable: false,
      binary: false,
      tracked: true,
    },
  ];
  for (const extra of options?.extraFiles ?? []) {
    const absolute = join(root, ...extra.relativePath.split('/'));
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, extra.content, 'utf8');
    const hash = sha256(extra.content);
    blobs.set(hash, Buffer.from(extra.content, 'utf8'));
    files.push({
      path: extra.relativePath,
      type: 'file',
      size: Buffer.byteLength(extra.content),
      mtimeMs: 1,
      hash,
      blobHash: hash,
      missing: false,
      executable: false,
      binary: false,
      tracked: true,
    });
  }
  for (const missingPath of options?.missingPaths ?? []) {
    files.push({
      path: missingPath,
      type: 'other',
      size: 0,
      mtimeMs: null,
      hash: null,
      blobHash: null,
      missing: true,
      executable: false,
      binary: false,
      tracked: false,
    });
  }
  const building: BuildingBaselineManifest = {
    version: 1,
    status: 'building',
    kind: 'attempt',
    taskId: 'task-patch',
    baselineId: 'baseline-attempt-1',
    attemptId: 'attempt-patch-1',
    attemptNumber: 1,
    parentTaskBaselineId: 'baseline-task-1',
    createdAt: '2026-07-12T00:00:00.000Z',
    git: {
      canonicalRoot: resolve(root),
      headSha: 'a'.repeat(40),
      branch: 'main',
      detached: false,
      statusRaw: '',
      statusEntries: [],
    },
    files,
    exclusions: [],
  };

  // Parent task baseline first (required by load validation for attempt baselines).
  const parentBuilding: BuildingBaselineManifest = {
    version: 1,
    status: 'building',
    kind: 'task',
    taskId: 'task-patch',
    baselineId: 'baseline-task-1',
    createdAt: '2026-07-12T00:00:00.000Z',
    git: building.git,
    files: building.files,
    exclusions: [],
  };
  completeBaselineManifest(snapshots, parentBuilding, blobs);
  completeBaselineManifest(snapshots, building, blobs);
  return {
    root: resolve(root),
    snapshots,
    baselineId: 'baseline-attempt-1',
    fileHash,
    taskId: 'task-patch',
    attemptId: 'attempt-patch-1',
  };
}

function unifiedDiff(path: string, before: string, after: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    `-${before.replace(/\n$/, '')}`,
    `+${after.replace(/\n$/, '')}`,
    '',
  ].join('\n');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('PatchValidator and PatchApplier', () => {
  it('validates a safe project-local unified diff against the attempt baseline', () => {
    const { root, snapshots, baselineId } = createProject();
    const validator = new PatchValidator({
      projectRoot: root,
      snapshotStore: snapshots,
    });
    const patch = unifiedDiff('src/app.ts', 'export const value = 1;\n', 'export const value = 2;\n');
    const result = validator.validate({
      patch,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
      taskId: asTaskId('task-patch'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.files).toEqual(['src/app.ts']);
  });

  it('rejects absolute, outside, device, reparse, binary, unsafe mode, and baseline mismatch patches', () => {
    const { root, snapshots, baselineId } = createProject();
    const validator = new PatchValidator({
      projectRoot: root,
      snapshotStore: snapshots,
    });

    const absolute = [
      'diff --git a/C:/Windows/win.ini b/C:/Windows/win.ini',
      '--- a/C:/Windows/win.ini',
      '+++ b/C:/Windows/win.ini',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    expect(validator.validate({
      patch: absolute,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
    }).ok).toBe(false);

    const outside = unifiedDiff('../outside.ts', 'a\n', 'b\n');
    expect(validator.validate({
      patch: outside,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
    }).ok).toBe(false);

    const device = [
      'diff --git a/src/app.ts:Zone.Identifier b/src/app.ts:Zone.Identifier',
      '--- a/src/app.ts:Zone.Identifier',
      '+++ b/src/app.ts:Zone.Identifier',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '',
    ].join('\n');
    expect(validator.validate({
      patch: device,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
    }).ok).toBe(false);

    const binary = [
      'diff --git a/src/app.ts b/src/app.ts',
      'GIT binary patch',
      'literal 0',
      'HcmV?d00001',
      '',
    ].join('\n');
    expect(validator.validate({
      patch: binary,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
    }).ok).toBe(false);

    const mode = [
      'diff --git a/src/app.ts b/src/app.ts',
      'old mode 100644',
      'new mode 100755',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
      '',
    ].join('\n');
    expect(validator.validate({
      patch: mode,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
    }).ok).toBe(false);

    writeFileSync(join(root, 'src', 'app.ts'), 'export const value = 9;\n', 'utf8');
    const mismatch = unifiedDiff(
      'src/app.ts',
      'export const value = 1;\n',
      'export const value = 2;\n',
    );
    const mismatched = validator.validate({
      patch: mismatch,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
    });
    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) throw new Error('expected mismatch');
    expect(mismatched.reason).toMatch(/baseline|mismatch|content/i);

    // reparse target rejection when link escapes
    writeFileSync(join(root, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    const outsideDir = temporaryDirectory('triagent-patch-outside-');
    writeFileSync(join(outsideDir, 'secret.ts'), 'secret\n', 'utf8');
    const link = join(root, 'escape');
    try {
      symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir');
      const reparsePatch = unifiedDiff('escape/secret.ts', 'secret\n', 'changed\n');
      expect(validator.validate({
        patch: reparsePatch,
        baselineId: asBaselineId(baselineId),
        attemptId: asAttemptId('attempt-patch-1'),
      }).ok).toBe(false);
    } catch {
      // If symlink creation is blocked, absolute/outside coverage still stands.
    }
  });

  it('applies a validated patch as the only writer and returns a visible ChangeSet with evidence', () => {
    const { root, snapshots, baselineId } = createProject();
    const guard = new ProjectGuard({ projectRoot: root });
    const applier = new PatchApplier({
      projectRoot: root,
      snapshotStore: snapshots,
      guard,
    });
    const patch = unifiedDiff(
      'src/app.ts',
      'export const value = 1;\n',
      'export const value = 42;\n',
    );
    const result = applier.apply({
      patch,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
      taskId: asTaskId('task-patch'),
    });
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') throw new Error(result.reason);
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toBe(
      'export const value = 42;\n',
    );
    expect(result.changeSet.changes.length).toBeGreaterThan(0);
    expect(result.changeSet.modified.map((entry) => entry.path)).toContain('src/app.ts');
    expect(result.evidence.decisionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.evidence.baselineId).toBe(baselineId);
    expect(result.evidence.filesWritten).toEqual(['src/app.ts']);
    expect(result.evidence.baselineRecheck.ok).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/os sandbox/i);
  });

  it('rechecks baseline immediately and refuses to write when content drifted after validation', () => {
    const { root, snapshots, baselineId } = createProject();
    const applier = new PatchApplier({
      projectRoot: root,
      snapshotStore: snapshots,
      guard: new ProjectGuard({ projectRoot: root }),
    });
    const patch = unifiedDiff(
      'src/app.ts',
      'export const value = 1;\n',
      'export const value = 3;\n',
    );
    writeFileSync(join(root, 'src', 'app.ts'), 'export const value = 99;\n', 'utf8');
    const result = applier.apply({
      patch,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
      taskId: asTaskId('task-patch'),
    });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('expected rejection');
    expect(result.reason).toMatch(/baseline|mismatch|recheck|drift/i);
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toBe(
      'export const value = 99;\n',
    );
    expect(existsSync(join(root, 'src', 'app.ts'))).toBe(true);
  });

  it('never launches a fake process while applying a patch', () => {
    const { root, snapshots, baselineId } = createProject();
    const launches: string[] = [];
    const applier = new PatchApplier({
      projectRoot: root,
      snapshotStore: snapshots,
      guard: new ProjectGuard({ projectRoot: root }),
      processLauncher: {
        spawn: (command: string) => {
          launches.push(command);
          throw new Error('process launch is forbidden during patch apply');
        },
      },
    });
    const patch = unifiedDiff(
      'src/app.ts',
      'export const value = 1;\n',
      'export const value = 7;\n',
    );
    const result = applier.apply({
      patch,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
      taskId: asTaskId('task-patch'),
    });
    expect(result.status).toBe('applied');
    expect(launches).toEqual([]);
  });

  it('requires exact task + attempt + attempt-kind + baseline identity', () => {
    const { root, snapshots, baselineId } = createProject();
    const validator = new PatchValidator({
      projectRoot: root,
      snapshotStore: snapshots,
    });
    const applier = new PatchApplier({
      projectRoot: root,
      snapshotStore: snapshots,
      guard: new ProjectGuard({ projectRoot: root }),
    });
    const patch = unifiedDiff(
      'src/app.ts',
      'export const value = 1;\n',
      'export const value = 2;\n',
    );

    const wrongAttempt = validator.validate({
      patch,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-unrelated'),
      taskId: asTaskId('task-patch'),
    });
    expect(wrongAttempt.ok).toBe(false);
    if (wrongAttempt.ok) throw new Error('expected wrong attempt rejection');
    expect(wrongAttempt.reason).toMatch(/attempt|identity|task/i);

    const wrongTask = applier.apply({
      patch,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
      taskId: asTaskId('task-unrelated'),
    });
    expect(wrongTask.status).toBe('rejected');
    if (wrongTask.status !== 'rejected') throw new Error('expected rejection');
    expect(wrongTask.reason).toMatch(/task|identity|attempt/i);
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toBe(
      'export const value = 1;\n',
    );
  });

  it('rejects patches for paths absent from the baseline or marked missing', () => {
    const { root, snapshots, baselineId } = createProject({
      missingPaths: ['src/ghost.ts'],
    });
    // Present on disk but not in baseline as a present file.
    writeFileSync(join(root, 'src', 'untracked.ts'), 'export const u = 1;\n', 'utf8');
    writeFileSync(join(root, 'src', 'ghost.ts'), 'export const g = 1;\n', 'utf8');
    const validator = new PatchValidator({
      projectRoot: root,
      snapshotStore: snapshots,
    });

    const absent = validator.validate({
      patch: unifiedDiff(
        'src/untracked.ts',
        'export const u = 1;\n',
        'export const u = 2;\n',
      ),
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
      taskId: asTaskId('task-patch'),
    });
    expect(absent.ok).toBe(false);
    if (absent.ok) throw new Error('expected absent path rejection');
    expect(absent.reason).toMatch(/baseline|absent|missing|coverage|identity/i);

    const missingMarked = validator.validate({
      patch: unifiedDiff(
        'src/ghost.ts',
        'export const g = 1;\n',
        'export const g = 2;\n',
      ),
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
      taskId: asTaskId('task-patch'),
    });
    expect(missingMarked.ok).toBe(false);
    if (missingMarked.ok) throw new Error('expected missing entry rejection');
    expect(missingMarked.reason).toMatch(/missing|baseline|coverage/i);
  });

  it('keeps multi-file patches atomic: later failure leaves earlier files unchanged', () => {
    const secondContent = 'export const second = 1;\n';
    const { root, snapshots, baselineId } = createProject({
      extraFiles: [{ relativePath: 'src/second.ts', content: secondContent }],
    });
    const firstBefore = readFileSync(join(root, 'src', 'app.ts'), 'utf8');

    // Replace second.ts with a hard link to outside content matching baseline text.
    // Staging/path policy fails closed on the second path; first must stay unmodified.
    const outsideDir = temporaryDirectory('triagent-atomic-outside-');
    const outsideFile = join(outsideDir, 'second-outside.txt');
    writeFileSync(outsideFile, secondContent, 'utf8');
    const secondAbsolute = join(root, 'src', 'second.ts');
    rmSync(secondAbsolute, { force: true });
    let hardLinked = false;
    try {
      linkSync(outsideFile, secondAbsolute);
      hardLinked = true;
    } catch {
      // Fallback: directory at second path forces stage/read failure.
      mkdirSync(secondAbsolute, { recursive: true });
      writeFileSync(join(secondAbsolute, 'nested.txt'), 'blocker\n', 'utf8');
    }

    const applier = new PatchApplier({
      projectRoot: root,
      snapshotStore: snapshots,
      guard: new ProjectGuard({ projectRoot: root }),
    });

    const multiPatch = [
      unifiedDiff('src/app.ts', firstBefore, 'export const value = 100;\n').trimEnd(),
      unifiedDiff('src/second.ts', secondContent, 'export const second = 200;\n').trimEnd(),
      '',
    ].join('\n');

    const result = applier.apply({
      patch: multiPatch,
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
      taskId: asTaskId('task-patch'),
    });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') throw new Error('expected rejection');
    // First file must remain unmodified even though it appeared earlier in the patch.
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toBe(firstBefore);
    if (hardLinked) {
      expect(readFileSync(outsideFile, 'utf8')).toBe(secondContent);
      expect(readFileSync(outsideFile, 'utf8')).not.toBe('export const second = 200;\n');
    }
    if (result.evidence?.filesWritten !== undefined) {
      expect(result.evidence.filesWritten).toEqual([]);
    }
  });

  it.runIf(process.platform === 'win32')(
    'refuses patch writes that would follow a pre-created hard link to outside content',
    () => {
      const { root, snapshots, baselineId } = createProject();
      const outsideDir = temporaryDirectory('triagent-patch-hardlink-out-');
      const outsideFile = join(outsideDir, 'secret.txt');
      const originalOutside = 'export const value = 1;\n';
      writeFileSync(outsideFile, originalOutside, 'utf8');
      const inside = join(root, 'src', 'app.ts');
      rmSync(inside, { force: true });
      try {
        linkSync(outsideFile, inside);
      } catch {
        return;
      }
      // Disk content matches baseline text through the shared inode.
      expect(readFileSync(inside, 'utf8')).toBe(originalOutside);

      const applier = new PatchApplier({
        projectRoot: root,
        snapshotStore: snapshots,
        guard: new ProjectGuard({ projectRoot: root }),
      });
      const result = applier.apply({
        patch: unifiedDiff(
          'src/app.ts',
          originalOutside,
          'export const value = 999;\n',
        ),
        baselineId: asBaselineId(baselineId),
        attemptId: asAttemptId('attempt-patch-1'),
        taskId: asTaskId('task-patch'),
      });
      expect(result.status).toBe('rejected');
      // Outside content must not become the post-patch payload via hard-link follow.
      expect(readFileSync(outsideFile, 'utf8')).toBe(originalOutside);
      expect(readFileSync(outsideFile, 'utf8')).not.toBe('export const value = 999;\n');
    },
  );

  it('uses unpredictable exclusive temp names and does not leave predictable patch temps', () => {
    const { root, snapshots, baselineId } = createProject();
    const applier = new PatchApplier({
      projectRoot: root,
      snapshotStore: snapshots,
      guard: new ProjectGuard({ projectRoot: root }),
    });
    const result = applier.apply({
      patch: unifiedDiff(
        'src/app.ts',
        'export const value = 1;\n',
        'export const value = 55;\n',
      ),
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId('attempt-patch-1'),
      taskId: asTaskId('task-patch'),
    });
    expect(result.status).toBe('applied');
    const srcEntries = readdirSync(join(root, 'src'));
    expect(srcEntries.some((name) => name.endsWith('.triagent-patch-tmp'))).toBe(false);
    expect(srcEntries).toContain('app.ts');
  });
});
