import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveAppPaths } from '../../../src/config/app-paths.js';
import { openDatabase } from '../../../src/persistence/database.js';
import { sha256 } from '../../../src/tracking/hash.js';
import { NonGitBaselineService } from '../../../src/tracking/non-git-baseline-service.js';
import type { BaselineTrackerPort } from '../../../src/tracking/tracking-port.js';
import { ImplementationWorkspaceRepository } from '../../../src/workspace/implementation-workspace-repository.js';
import { ImplementationWorkspaceService } from '../../../src/workspace/implementation-workspace-service.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'triagent-workspace-retention-'));
  roots.push(root);
  return root;
}

describe('Implementation workspace recovery and retention', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows may briefly lock sqlite files after close.
      }
    }
  });

  it('decides fail-closed recovery actions for every workspace status', () => {
    const app = createMultiStatusFixture();
    try {
      expect(app.service.decideWorkspaceRecovery('missing')).toMatchObject({
        action: 'none',
      });
      expect(app.service.decideWorkspaceRecovery(app.ids.ready)).toMatchObject({
        action: 'await_launch',
      });
      expect(app.service.decideWorkspaceRecovery(app.ids.runningLive, {
        processLive: true,
      })).toMatchObject({ action: 'do_not_replay' });
      expect(app.service.decideWorkspaceRecovery(app.ids.runningDead, {
        processLive: false,
      })).toMatchObject({ action: 'inspect' });
      expect(app.service.decideWorkspaceRecovery(app.ids.candidate)).toMatchObject({
        action: 'resume_review',
      });
      expect(app.service.decideWorkspaceRecovery(app.ids.approved)).toMatchObject({
        action: 'allow_promotion',
      });
      expect(app.service.decideWorkspaceRecovery(app.ids.promoting)).toMatchObject({
        action: 'do_not_replay',
      });
      expect(app.service.decideWorkspaceRecovery(app.ids.promoted)).toMatchObject({
        action: 'cleanup_eligible',
      });
      expect(app.service.decideWorkspaceRecovery(app.ids.abandoned)).toMatchObject({
        action: 'cleanup_after_retention',
      });
      expect(app.service.decideWorkspaceRecovery(app.ids.recovery)).toMatchObject({
        action: 'require_audited_cancel',
      });
    } finally {
      app.close();
    }
  });

  it('cleans promoted and expired abandoned workspaces but never recovery_required', () => {
    const app = createMultiStatusFixture();
    try {
      app.repository.setRetainedUntil({
        workspaceId: app.ids.abandoned,
        retainedUntil: '2026-07-14T00:00:00.000Z',
        nowIso: '2026-07-15T12:00:00.000Z',
      });
      app.repository.setRetainedUntil({
        workspaceId: app.ids.abandonedFuture,
        retainedUntil: '2026-07-16T00:00:00.000Z',
        nowIso: '2026-07-15T12:00:00.000Z',
      });

      const report = app.service.housekeepExpiredWorkspaces({
        nowIso: '2026-07-15T12:00:00.000Z',
      });

      expect(report.deleted).toEqual(
        expect.arrayContaining([app.ids.promoted, app.ids.abandoned]),
      );
      expect(report.deleted).not.toContain(app.ids.recovery);
      expect(report.deleted).not.toContain(app.ids.promoting);
      expect(report.deleted).not.toContain(app.ids.abandonedFuture);

      expect(app.repository.get(app.ids.recovery)?.status).toBe('recovery_required');
      expect(existsSync(app.roots.recovery)).toBe(true);
      expect(app.repository.get(app.ids.promoted)).toBeUndefined();
      expect(existsSync(app.roots.promoted)).toBe(false);
    } finally {
      app.close();
    }
  });

  it('requires audited cancel before cleanup of recovery_required', () => {
    const app = createMultiStatusFixture();
    try {
      app.service.housekeepExpiredWorkspaces({
        nowIso: '2026-07-20T00:00:00.000Z',
      });
      expect(app.repository.get(app.ids.recovery)?.status).toBe('recovery_required');

      const abandoned = app.service.abandonWorkspace({
        workspaceId: app.ids.recovery,
        nowIso: '2026-07-15T12:00:00.000Z',
        reason: 'operator audited cancel',
      });
      expect(abandoned.status).toBe('abandoned');
      expect(abandoned.retainedUntil).not.toBeNull();

      const mid = app.service.housekeepExpiredWorkspaces({
        nowIso: '2026-07-15T13:00:00.000Z',
      });
      expect(mid.deleted).not.toContain(app.ids.recovery);

      const later = app.service.housekeepExpiredWorkspaces({
        nowIso: '2026-07-17T12:00:00.000Z',
      });
      expect(later.deleted).toContain(app.ids.recovery);
      expect(app.repository.get(app.ids.recovery)).toBeUndefined();
    } finally {
      app.close();
    }
  });
});

function createMultiStatusFixture(): {
  readonly service: ImplementationWorkspaceService;
  readonly repository: ImplementationWorkspaceRepository;
  readonly close: () => void;
  readonly ids: {
    ready: string;
    runningLive: string;
    runningDead: string;
    candidate: string;
    approved: string;
    promoting: string;
    promoted: string;
    abandoned: string;
    abandonedFuture: string;
    recovery: string;
  };
  readonly roots: {
    promoted: string;
    recovery: string;
  };
} {
  const appRoot = temporaryRoot();
  const projectRoot = join(appRoot, 'project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, 'README.md'), '# r\n', 'utf8');
  const paths = resolveAppPaths({ appRootOverride: appRoot });
  const opened = openDatabase(paths.databasePath);
  if (opened.mode !== 'read-write') throw new Error('expected rw db');

  const now = '2026-07-15T00:00:00.000Z';
  opened.connection.prepare(
    `INSERT INTO projects(id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('project-1', projectRoot, now, now);
  opened.connection.prepare(
    `INSERT INTO tasks(id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at)
     VALUES (?, ?, 'implementing', 1, ?, ?, ?)`,
  ).run('task-1', 'project-1', JSON.stringify({ state: 'implementing' }), now, now);

  const ensureAttempt = (attemptId: string, baselineId: string): void => {
    opened.connection.prepare(
      `INSERT INTO run_attempts(
         id, task_id, status, role, pid, process_started_at, started_at,
         ended_at, exit_reason, baseline_id, requirement_version, conversation_id
       ) VALUES (?, 'task-1', 'pending', NULL, NULL, NULL, ?, NULL, NULL, ?, 1, NULL)`,
    ).run(attemptId, now, baselineId);
    opened.connection.prepare(
      `INSERT INTO file_baselines(
         id, task_id, attempt_id, status, manifest_json, error_text, created_at, completed_at
       ) VALUES (?, 'task-1', ?, 'complete', ?, NULL, ?, ?)`,
    ).run(baselineId, attemptId, JSON.stringify({ schemaVersion: 1, files: [] }), now, now);
  };

  const specs = [
    { key: 'ready', status: 'ready' as const },
    { key: 'runningLive', status: 'running' as const },
    { key: 'runningDead', status: 'running' as const },
    { key: 'candidate', status: 'candidate_ready' as const },
    { key: 'approved', status: 'approved' as const },
    { key: 'promoting', status: 'promoting' as const },
    { key: 'promoted', status: 'promoted' as const },
    { key: 'abandoned', status: 'abandoned' as const },
    { key: 'abandonedFuture', status: 'abandoned' as const },
    { key: 'recovery', status: 'recovery_required' as const },
  ];

  const repository = new ImplementationWorkspaceRepository(opened.connection);
  const ids: Record<string, string> = {};
  const workspaceRoots: Record<string, string> = {};
  const sourceManifestHash = sha256('workspace-retention-manifest');

  let index = 0;
  for (const spec of specs) {
    index += 1;
    const attemptId = `attempt-${index}`;
    const baselineId = `baseline-${index}`;
    ensureAttempt(attemptId, baselineId);
    const workspaceId = `workspace-${spec.key}`;
    const workspaceRoot = join(
      paths.implementationWorkspacesDirectory,
      'task-1',
      attemptId,
      'project',
    );
    mkdirSync(workspaceRoot, { recursive: true });
    writeFileSync(join(workspaceRoot, 'marker.txt'), `${spec.key}\n`, 'utf8');
    repository.create({
      workspaceId,
      taskId: 'task-1',
      attemptId,
      canonicalProjectRoot: projectRoot,
      workspaceRoot,
      sourceBaselineId: baselineId,
      sourceManifestHash,
      authorizationId: `auth-${index}`,
      authorizationExpiresAt: '2026-07-16T00:00:00.000Z',
      nowIso: now,
    });
    driveToStatus(repository, workspaceId, spec.status);
    ids[spec.key] = workspaceId;
    workspaceRoots[spec.key] = workspaceRoot;
  }

  const tracker = new NonGitBaselineService({
    projectRoot,
    snapshotStore: paths.snapshotsDirectory,
  });
  const service = new ImplementationWorkspaceService({
    database: opened.connection,
    paths,
    tracker: tracker as unknown as BaselineTrackerPort,
  });

  return {
    service,
    repository,
    close: () => opened.close(),
    ids: ids as never,
    roots: {
      promoted: workspaceRoots.promoted!,
      recovery: workspaceRoots.recovery!,
    },
  };
}

function driveToStatus(
  repository: ImplementationWorkspaceRepository,
  workspaceId: string,
  status:
    | 'ready'
    | 'running'
    | 'candidate_ready'
    | 'approved'
    | 'promoting'
    | 'promoted'
    | 'abandoned'
    | 'recovery_required',
): void {
  const path: Record<string, Array<[string, string]>> = {
    ready: [['preparing', 'ready']],
    running: [
      ['preparing', 'ready'],
      ['ready', 'running'],
    ],
    candidate_ready: [
      ['preparing', 'ready'],
      ['ready', 'running'],
      ['running', 'candidate_ready'],
    ],
    approved: [
      ['preparing', 'ready'],
      ['ready', 'running'],
      ['running', 'candidate_ready'],
      ['candidate_ready', 'under_review'],
      ['under_review', 'approved'],
    ],
    promoting: [
      ['preparing', 'ready'],
      ['ready', 'running'],
      ['running', 'candidate_ready'],
      ['candidate_ready', 'under_review'],
      ['under_review', 'approved'],
      ['approved', 'validating'],
      ['validating', 'promoting'],
    ],
    promoted: [
      ['preparing', 'ready'],
      ['ready', 'running'],
      ['running', 'candidate_ready'],
      ['candidate_ready', 'under_review'],
      ['under_review', 'approved'],
      ['approved', 'validating'],
      ['validating', 'promoting'],
      ['promoting', 'promoted'],
    ],
    abandoned: [['preparing', 'abandoned']],
    recovery_required: [['preparing', 'recovery_required']],
  };
  for (const [from, to] of path[status]!) {
    repository.transition({
      workspaceId,
      expectedStatus: from as never,
      status: to as never,
      nowIso: '2026-07-15T00:01:00.000Z',
    });
  }
}
