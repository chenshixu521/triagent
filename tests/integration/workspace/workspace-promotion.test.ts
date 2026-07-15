import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveAppPaths } from '../../../src/config/app-paths.js';
import { PatchApplier } from '../../../src/guard/patch-applier.js';
import { ProjectGuard } from '../../../src/guard/project-guard.js';
import { openDatabase } from '../../../src/persistence/database.js';
import { sha256 } from '../../../src/tracking/hash.js';
import { ImplementationWorkspaceRepository } from '../../../src/workspace/implementation-workspace-repository.js';
import { buildWorkspaceCandidateChangeSet } from '../../../src/workspace/workspace-change-set.js';
import {
  hashCanonicalManifest,
  WorkspacePromotionService,
} from '../../../src/workspace/workspace-promotion-service.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'triagent-promotion-'));
  roots.push(root);
  return root;
}

function seed(database: DatabaseSync, projectRoot: string): void {
  const now = '2026-07-15T00:00:00.000Z';
  database.prepare(
    `INSERT INTO projects(id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('project-1', projectRoot, now, now);
  database.prepare(
    `INSERT INTO tasks(id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at)
     VALUES (?, ?, 'implementing', 1, ?, ?, ?)`,
  ).run('task-1', 'project-1', JSON.stringify({ state: 'implementing' }), now, now);
  database.prepare(
    `INSERT INTO run_attempts(
       id, task_id, status, role, pid, process_started_at, started_at,
       ended_at, exit_reason, baseline_id, requirement_version, conversation_id
     ) VALUES (?, ?, 'pending', NULL, NULL, NULL, ?, NULL, NULL, ?, 1, NULL)`,
  ).run('attempt-1', 'task-1', now, 'baseline-1');
  database.prepare(
    `INSERT INTO file_baselines(
       id, task_id, attempt_id, status, manifest_json, error_text, created_at, completed_at
     ) VALUES (?, ?, ?, 'complete', ?, NULL, ?, ?)`,
  ).run(
    'baseline-1',
    'task-1',
    'attempt-1',
    JSON.stringify({ schemaVersion: 1, files: [] }),
    now,
    now,
  );
}

function textFile(path: string, content: string) {
  const buffer = Buffer.from(content, 'utf8');
  const hash = sha256(buffer);
  return {
    path,
    type: 'file' as const,
    size: buffer.length,
    hash,
    blobHash: hash,
    binary: false as const,
    content: buffer,
  };
}

function fingerprint(path: string, content: string) {
  const buffer = Buffer.from(content, 'utf8');
  return {
    path,
    hash: sha256(buffer),
    size: buffer.length,
  };
}

function advanceToApproved(repository: ImplementationWorkspaceRepository): void {
  for (const [from, to] of [
    ['preparing', 'ready'],
    ['ready', 'running'],
    ['running', 'candidate_ready'],
    ['candidate_ready', 'under_review'],
    ['under_review', 'approved'],
  ] as const) {
    repository.transition({
      workspaceId: 'workspace-1',
      expectedStatus: from,
      status: to,
      nowIso: '2026-07-15T00:01:00.000Z',
    });
  }
}

function createPromotionFixture(options?: {
  readonly files?: ReadonlyArray<{ readonly path: string; readonly content: string }>;
}): {
  readonly appRoot: string;
  readonly projectRoot: string;
  readonly snapshots: string;
  readonly repository: ImplementationWorkspaceRepository;
  readonly connection: DatabaseSync;
  readonly close: () => void;
  readonly sourceFiles: ReturnType<typeof fingerprint>[];
} {
  const appRoot = temporaryRoot();
  const projectRoot = join(appRoot, 'project');
  const snapshots = join(appRoot, 'snapshots');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(snapshots, { recursive: true });
  const files = options?.files ?? [
    { path: 'a.txt', content: 'A\n' },
    { path: 'unrelated.txt', content: 'U\n' },
  ];
  const sourceFiles = files.map((file) => {
    writeFileSync(join(projectRoot, ...file.path.split('/')), file.content, 'utf8');
    return fingerprint(file.path, file.content);
  });

  const paths = resolveAppPaths({ appRootOverride: appRoot });
  const opened = openDatabase(paths.databasePath);
  if (opened.mode !== 'read-write') {
    throw new Error(`expected read-write database, got ${opened.mode}`);
  }
  seed(opened.connection, projectRoot);
  const repository = new ImplementationWorkspaceRepository(opened.connection);
  const workspaceRoot = join(
    paths.implementationWorkspacesDirectory,
    'task-1',
    'attempt-1',
    'project',
  );
  mkdirSync(workspaceRoot, { recursive: true });
  const sourceManifestHash = hashCanonicalManifest(sourceFiles);
  repository.create({
    workspaceId: 'workspace-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    canonicalProjectRoot: projectRoot,
    workspaceRoot,
    sourceBaselineId: 'baseline-1',
    sourceManifestHash,
    authorizationId: 'auth-1',
    authorizationExpiresAt: '2026-07-15T01:00:00.000Z',
    nowIso: '2026-07-15T00:00:00.000Z',
  });
  advanceToApproved(repository);

  return {
    appRoot,
    projectRoot,
    snapshots,
    repository,
    connection: opened.connection,
    close: () => opened.close(),
    sourceFiles,
  };
}

function makeService(
  fixture: ReturnType<typeof createPromotionFixture>,
): WorkspacePromotionService {
  return new WorkspacePromotionService({
    repository: fixture.repository,
    canonicalProjectRoot: fixture.projectRoot,
    snapshotStore: fixture.snapshots,
    patchApplier: new PatchApplier({
      projectRoot: fixture.projectRoot,
      snapshotStore: fixture.snapshots,
      guard: new ProjectGuard({ projectRoot: fixture.projectRoot }),
    }),
  });
}

describe('WorkspacePromotionService', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks promotion when the full canonical manifest drifts, including unrelated paths', () => {
    const fixture = createPromotionFixture();
    try {
      const sourceManifestHash = hashCanonicalManifest(fixture.sourceFiles);
      const changeSet = buildWorkspaceCandidateChangeSet({
        taskId: 'task-1',
        attemptId: 'attempt-1',
        workspaceId: 'workspace-1',
        sourceBaselineId: 'baseline-1',
        sourceManifestHash,
        candidateManifestHash: 'b'.repeat(64),
        sourceFiles: [textFile('a.txt', 'A\n')],
        candidateFiles: [textFile('a.txt', 'A-changed\n')],
      });

      let applyCalls = 0;
      const service = new WorkspacePromotionService({
        repository: fixture.repository,
        canonicalProjectRoot: fixture.projectRoot,
        snapshotStore: fixture.snapshots,
        patchApplier: {
          apply() {
            applyCalls += 1;
            return { status: 'rejected', reason: 'should not run' };
          },
        } as never,
      });

      writeFileSync(join(fixture.projectRoot, 'unrelated.txt'), 'U-changed\n');
      const drifted = service.promote({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        baselineId: 'baseline-1',
        sourceManifestHash,
        changeSet,
        expectedCanonicalFiles: fixture.sourceFiles,
        currentCanonicalFiles: [
          fingerprint('a.txt', 'A\n'),
          fingerprint('unrelated.txt', 'U-changed\n'),
        ],
        nowIso: '2026-07-15T00:02:00.000Z',
        expectedLockOwner: 'owner-1',
        actualLockOwner: 'owner-1',
      });
      expect(drifted).toMatchObject({
        ok: false,
        code: 'promotion_blocked_original_drift',
      });
      expect(applyCalls).toBe(0);

      // Restore unrelated content for lock-mismatch check.
      writeFileSync(join(fixture.projectRoot, 'unrelated.txt'), 'U\n');
      const lockMismatch = service.promote({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        baselineId: 'baseline-1',
        sourceManifestHash,
        changeSet,
        expectedCanonicalFiles: fixture.sourceFiles,
        currentCanonicalFiles: fixture.sourceFiles,
        nowIso: '2026-07-15T00:03:00.000Z',
        expectedLockOwner: 'owner-1',
        actualLockOwner: 'other-owner',
      });
      expect(lockMismatch).toMatchObject({
        ok: false,
        code: 'promotion_blocked_lock_mismatch',
      });
      expect(applyCalls).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('promotes add/modify/delete through PatchApplier and verifies post-apply equality', () => {
    const fixture = createPromotionFixture({
      files: [
        { path: 'keep.txt', content: 'same\n' },
        { path: 'edit.txt', content: 'before\n' },
        { path: 'gone.txt', content: 'delete-me\n' },
      ],
    });
    try {
      const sourceManifestHash = hashCanonicalManifest(fixture.sourceFiles);
      const changeSet = buildWorkspaceCandidateChangeSet({
        taskId: 'task-1',
        attemptId: 'attempt-1',
        workspaceId: 'workspace-1',
        sourceBaselineId: 'baseline-1',
        sourceManifestHash,
        candidateManifestHash: 'c'.repeat(64),
        sourceFiles: [
          textFile('keep.txt', 'same\n'),
          textFile('edit.txt', 'before\n'),
          textFile('gone.txt', 'delete-me\n'),
        ],
        candidateFiles: [
          textFile('keep.txt', 'same\n'),
          textFile('edit.txt', 'after\n'),
          textFile('new.txt', 'added\n'),
        ],
      });

      const service = makeService(fixture);
      const result = service.promote({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        baselineId: 'baseline-promote-1',
        sourceManifestHash,
        changeSet,
        expectedCanonicalFiles: fixture.sourceFiles,
        currentCanonicalFiles: fixture.sourceFiles,
        nowIso: '2026-07-15T00:05:00.000Z',
        expectedLockOwner: 'owner-1',
        actualLockOwner: 'owner-1',
      });

      if (!result.ok) {
        throw new Error(`promote failed: ${result.code}: ${result.reason}`);
      }
      expect(result).toMatchObject({
        ok: true,
        postApplyVerified: true,
        promotedChangeSetHash: changeSet.changeSetHash,
      });
      expect(result.patchResult).not.toBeNull();
      expect([...(result.patchResult?.evidence.filesWritten ?? [])].sort()).toEqual([
        'edit.txt',
        'gone.txt',
        'new.txt',
      ]);

      expect(readFileSync(join(fixture.projectRoot, 'edit.txt'), 'utf8')).toBe('after\n');
      expect(readFileSync(join(fixture.projectRoot, 'new.txt'), 'utf8')).toBe('added\n');
      expect(existsSync(join(fixture.projectRoot, 'gone.txt'))).toBe(false);
      expect(readFileSync(join(fixture.projectRoot, 'keep.txt'), 'utf8')).toBe('same\n');

      const workspace = fixture.repository.get('workspace-1');
      expect(workspace?.status).toBe('promoted');
      expect(workspace?.changeSetHash).toBe(changeSet.changeSetHash);
    } finally {
      fixture.close();
    }
  });

  it('promotes safe text rename as delete+add', () => {
    const fixture = createPromotionFixture({
      files: [{ path: 'old-name.txt', content: 'rename-body\n' }],
    });
    try {
      const sourceManifestHash = hashCanonicalManifest(fixture.sourceFiles);
      const changeSet = buildWorkspaceCandidateChangeSet({
        taskId: 'task-1',
        attemptId: 'attempt-1',
        workspaceId: 'workspace-1',
        sourceBaselineId: 'baseline-1',
        sourceManifestHash,
        candidateManifestHash: 'd'.repeat(64),
        sourceFiles: [textFile('old-name.txt', 'rename-body\n')],
        candidateFiles: [textFile('new-name.txt', 'rename-body\n')],
      });
      const service = makeService(fixture);
      const result = service.promote({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        baselineId: 'baseline-rename-1',
        sourceManifestHash,
        changeSet,
        expectedCanonicalFiles: fixture.sourceFiles,
        currentCanonicalFiles: fixture.sourceFiles,
        nowIso: '2026-07-15T00:06:00.000Z',
      });
      if (!result.ok) {
        throw new Error(`rename promote failed: ${result.code}: ${result.reason}`);
      }
      expect(existsSync(join(fixture.projectRoot, 'old-name.txt'))).toBe(false);
      expect(readFileSync(join(fixture.projectRoot, 'new-name.txt'), 'utf8')).toBe(
        'rename-body\n',
      );
    } finally {
      fixture.close();
    }
  });

  it('blocks when reviewed change-set hash is tampered', () => {
    const fixture = createPromotionFixture({
      files: [{ path: 'a.txt', content: 'A\n' }],
    });
    try {
      const sourceManifestHash = hashCanonicalManifest(fixture.sourceFiles);
      const changeSet = buildWorkspaceCandidateChangeSet({
        taskId: 'task-1',
        attemptId: 'attempt-1',
        workspaceId: 'workspace-1',
        sourceBaselineId: 'baseline-1',
        sourceManifestHash,
        candidateManifestHash: 'e'.repeat(64),
        sourceFiles: [textFile('a.txt', 'A\n')],
        candidateFiles: [textFile('a.txt', 'B\n')],
      });
      const tampered = {
        ...changeSet,
        changeSetHash: 'f'.repeat(64),
      };
      const service = makeService(fixture);
      const result = service.promote({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        baselineId: 'baseline-tamper-1',
        sourceManifestHash,
        changeSet: tampered,
        expectedCanonicalFiles: fixture.sourceFiles,
        currentCanonicalFiles: fixture.sourceFiles,
        nowIso: '2026-07-15T00:07:00.000Z',
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'promotion_blocked_change_set',
      });
      expect(readFileSync(join(fixture.projectRoot, 'a.txt'), 'utf8')).toBe('A\n');
    } finally {
      fixture.close();
    }
  });

  it('blocks add when the target already collides on disk', () => {
    const fixture = createPromotionFixture({
      files: [
        { path: 'a.txt', content: 'A\n' },
        { path: 'new.txt', content: 'already-here\n' },
      ],
    });
    try {
      // Build change-set as if source lacked new.txt (add) while disk has it.
      const sourceManifestHash = hashCanonicalManifest([
        fingerprint('a.txt', 'A\n'),
      ]);
      // Workspace was created with both files; re-create identity for this case.
      // Use expected/current that match each other (no global drift) but include collision.
      const changeSet = buildWorkspaceCandidateChangeSet({
        taskId: 'task-1',
        attemptId: 'attempt-1',
        workspaceId: 'workspace-1',
        sourceBaselineId: 'baseline-1',
        sourceManifestHash: hashCanonicalManifest(fixture.sourceFiles),
        candidateManifestHash: 'a'.repeat(64),
        sourceFiles: [textFile('a.txt', 'A\n')],
        candidateFiles: [
          textFile('a.txt', 'A\n'),
          textFile('extra.txt', 'x\n'),
        ],
      });
      // Manually create collision for extra.txt
      writeFileSync(join(fixture.projectRoot, 'extra.txt'), 'collision\n', 'utf8');
      const current = [
        ...fixture.sourceFiles,
        fingerprint('extra.txt', 'collision\n'),
      ];
      const service = makeService(fixture);
      const result = service.promote({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        baselineId: 'baseline-collide-1',
        sourceManifestHash: hashCanonicalManifest(fixture.sourceFiles),
        changeSet,
        // Force no global drift by equating expected to current (path-level add check still fires)
        expectedCanonicalFiles: current,
        currentCanonicalFiles: current,
        nowIso: '2026-07-15T00:08:00.000Z',
      });
      expect(result).toMatchObject({
        ok: false,
        code: 'promotion_blocked_original_drift',
      });
      expect(result.ok === false && result.reason).toMatch(/already exists/i);
      void sourceManifestHash;
    } finally {
      fixture.close();
    }
  });

  it('marks empty change-set promoted without PatchApplier writes', () => {
    const fixture = createPromotionFixture({
      files: [{ path: 'a.txt', content: 'A\n' }],
    });
    try {
      const sourceManifestHash = hashCanonicalManifest(fixture.sourceFiles);
      const changeSet = buildWorkspaceCandidateChangeSet({
        taskId: 'task-1',
        attemptId: 'attempt-1',
        workspaceId: 'workspace-1',
        sourceBaselineId: 'baseline-1',
        sourceManifestHash,
        candidateManifestHash: sourceManifestHash,
        sourceFiles: [textFile('a.txt', 'A\n')],
        candidateFiles: [textFile('a.txt', 'A\n')],
      });
      expect(changeSet.entries).toEqual([]);
      let applyCalls = 0;
      const service = new WorkspacePromotionService({
        repository: fixture.repository,
        canonicalProjectRoot: fixture.projectRoot,
        snapshotStore: fixture.snapshots,
        patchApplier: {
          apply() {
            applyCalls += 1;
            return { status: 'rejected', reason: 'should not run' };
          },
        } as never,
      });
      const result = service.promote({
        workspaceId: 'workspace-1',
        taskId: 'task-1',
        attemptId: 'attempt-1',
        baselineId: 'baseline-empty-1',
        sourceManifestHash,
        changeSet,
        expectedCanonicalFiles: fixture.sourceFiles,
        currentCanonicalFiles: fixture.sourceFiles,
        nowIso: '2026-07-15T00:09:00.000Z',
      });
      expect(result).toMatchObject({
        ok: true,
        emptyChangeSet: true,
        postApplyVerified: true,
      });
      expect(applyCalls).toBe(0);
      expect(fixture.repository.get('workspace-1')?.status).toBe('promoted');
    } finally {
      fixture.close();
    }
  });
});
