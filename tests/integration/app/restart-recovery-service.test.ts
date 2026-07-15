import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  RestartRecoveryService,
  type RecoveryEffectIntent,
} from '../../../src/app/restart-recovery-service.js';
import {
  asAttemptId,
  asBaselineId,
  asTaskId,
} from '../../../src/domain/ids.js';
import { ActionRepository } from '../../../src/persistence/action-repository.js';
import { TaskRepository } from '../../../src/persistence/task-repository.js';
import { canonicalizeProjectPath } from '../../../src/project/canonical-path.js';
import { ProjectLockService } from '../../../src/project/project-lock-service.js';
import type { ReconciliationProcessEvidence } from '../../../src/workflow/reconciler.js';
import { createInitialWorkflow } from '../../../src/workflow/workflow-engine.js';
import {
  createWorkflowFixture,
  type WorkflowFixture,
} from '../workflow/workflow-test-fixture.js';

const fixtures: WorkflowFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.cleanup();
  }
});

function git(repository: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function seedTrackedFile(
  repository: string,
  relativePath: string,
  contents: string,
): void {
  const absolutePath = join(repository, relativePath);
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, contents, 'utf8');
  git(repository, 'add', relativePath);
  git(repository, 'commit', '-m', `seed ${relativePath.replaceAll('\\', '/')}`);
}

async function createRecoveryHarness(options: {
  readonly process?: ReconciliationProcessEvidence;
  readonly persistBaseline?: boolean;
} = {}) {
  const fixture = await createWorkflowFixture('restart-recovery-service', []);
  fixtures.push(fixture);
  seedTrackedFile(fixture.repository, 'src/counter.ts', 'export const counter = 0;\n');

  const taskId = asTaskId('task-restart-recovery');
  const oldAttemptId = asAttemptId('attempt-before-restart');
  const taskBaselineId = asBaselineId('baseline-task-before-restart');
  const oldBaselineId = asBaselineId('baseline-attempt-before-restart');
  const oldOwnerInstanceId = 'owner-before-restart';
  const newOwnerInstanceId = 'owner-after-restart';
  const startedAt = '2026-07-13T04:00:00.000Z';
  const tasks = new TaskRepository(fixture.database.connection);
  tasks.createProject({
    projectId: 'project-restart-recovery',
    rootPath: fixture.repository,
  });
  tasks.create({
    taskId,
    projectId: 'project-restart-recovery',
    workflowSnapshot: {
      ...createInitialWorkflow(taskId),
      state: 'interrupted_needs_inspection',
      resumeTargetState: 'implementing',
    },
    workflowVersion: 4,
    status: 'interrupted_needs_inspection',
  });
  fixture.database.connection
    .prepare(
      `INSERT INTO requirement_versions(task_id, version, requirements, created_at)
       VALUES (?, 1, ?, ?)`,
    )
    .run(taskId, JSON.stringify({ requirements: 'increment the counter safely' }), startedAt);

  fixture.tracker.captureTaskBaseline({
    taskId,
    baselineId: taskBaselineId,
    createdAt: new Date(startedAt),
  });
  const attemptBaseline = fixture.tracker.captureAttemptBaseline({
    taskId,
    baselineId: oldBaselineId,
    attemptId: oldAttemptId,
    attemptNumber: 1,
    parentTaskBaselineId: taskBaselineId,
    createdAt: new Date(startedAt),
  });
  fixture.database.connection
    .prepare(
      `INSERT INTO run_attempts(
         id, task_id, role, status, baseline_id, requirement_version,
         started_at, pid, process_started_at
       ) VALUES (?, ?, 'implementer', 'active', ?, 1, ?, 12001, ?)`,
    )
    .run(oldAttemptId, taskId, oldBaselineId, startedAt, startedAt);
  if (options.persistBaseline !== false) {
    fixture.database.connection
      .prepare(
        `INSERT INTO file_baselines(
           id, task_id, attempt_id, status, manifest_json, created_at, completed_at
         ) VALUES (?, ?, ?, 'complete', ?, ?, ?)`,
      )
      .run(
        oldBaselineId,
        taskId,
        oldAttemptId,
        JSON.stringify(attemptBaseline),
        startedAt,
        startedAt,
      );
  }

  const lockService = new ProjectLockService(fixture.opened, {
    lockIdFactory: () => 'lock-before-restart',
  });
  expect(lockService.acquire(
    taskId,
    canonicalizeProjectPath(fixture.repository),
    oldOwnerInstanceId,
    new Date(startedAt),
    10 * 60_000,
  ).status).toBe('acquired');

  writeFileSync(
    join(fixture.repository, 'src', 'counter.ts'),
    'export const counter = 1; // partial edit before restart\n',
    'utf8',
  );

  const executed: RecoveryEffectIntent[][] = [];
  const counters = new Map<string, number>();
  const processEvidence = options.process ?? {
    identity: 'matched' as const,
    terminalState: 'exited' as const,
    pid: 12_001,
    processStartedAt: startedAt,
  };
  const service = new RestartRecoveryService({
    database: fixture.database,
    tracker: fixture.tracker,
    ownerInstanceId: newOwnerInstanceId,
    now: () => new Date('2026-07-13T04:05:00.000Z'),
    inspectProcess: async () => processEvidence,
    idFactory: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, next);
      return `${kind}-restart-${String(next)}`;
    },
    executeEffects: async (effects) => {
      executed.push([...effects]);
    },
  });

  return {
    fixture,
    service,
    tasks,
    taskId,
    oldAttemptId,
    oldOwnerInstanceId,
    newOwnerInstanceId,
    executed,
  };
}

async function createPreAttemptRecoveryHarness() {
  const fixture = await createWorkflowFixture('restart-recovery-pre-attempt', []);
  fixtures.push(fixture);
  const taskId = asTaskId('task-restart-recovery-pre-attempt');
  const oldOwnerInstanceId = 'owner-before-pre-attempt-restart';
  const newOwnerInstanceId = 'owner-after-pre-attempt-restart';
  const tasks = new TaskRepository(fixture.database.connection);
  tasks.createProject({
    projectId: 'project-restart-recovery-pre-attempt',
    rootPath: fixture.repository,
  });
  tasks.create({
    taskId,
    projectId: 'project-restart-recovery-pre-attempt',
    workflowSnapshot: {
      ...createInitialWorkflow(taskId),
      state: 'awaiting_user',
      awaitingReason: 'Claude CLI is unavailable',
      allowedAwaitingActions: ['retry_environment', 'cancel'],
    },
    workflowVersion: 2,
    status: 'awaiting_user',
  });
  const lockService = new ProjectLockService(fixture.opened, {
    lockIdFactory: () => 'lock-before-pre-attempt-restart',
  });
  expect(lockService.acquire(
    taskId,
    canonicalizeProjectPath(fixture.repository),
    oldOwnerInstanceId,
    new Date('2026-07-13T04:00:00.000Z'),
    60_000,
  ).status).toBe('acquired');

  let idCounter = 0;
  const service = new RestartRecoveryService({
    database: fixture.database,
    tracker: fixture.tracker,
    ownerInstanceId: newOwnerInstanceId,
    now: () => new Date('2026-07-13T04:05:00.000Z'),
    inspectProcess: async () => {
      throw new Error('pre-attempt recovery must not inspect a process');
    },
    idFactory: (kind) => `${kind}-pre-attempt-${String(++idCounter)}`,
  });

  return {
    fixture,
    service,
    tasks,
    taskId,
  };
}

async function createGuardRejectedPendingAttemptHarness(options: {
  readonly persistGuardDecision?: boolean;
  readonly failureKind?: 'guard_disabled' | 'adapter_disabled';
} = {}) {
  const fixture = await createWorkflowFixture('restart-recovery-guard-rejected', []);
  fixtures.push(fixture);
  const taskId = asTaskId('task-restart-recovery-guard-rejected');
  const attemptId = asAttemptId('attempt-guard-rejected-before-launch');
  const baselineId = asBaselineId('baseline-guard-rejected-before-launch');
  const oldOwnerInstanceId = 'owner-before-guard-rejected-restart';
  const newOwnerInstanceId = 'owner-after-guard-rejected-restart';
  const startedAt = '2026-07-13T04:00:00.000Z';
  const adapterDisabled = options.failureKind === 'adapter_disabled';
  const failureReason = adapterDisabled
    ? 'AdapterDisabled: cannot read allowlisted packaged schema'
    : 'ProjectGuard start is not auto-allowed (disabled): verified profile missing';
  const tasks = new TaskRepository(fixture.database.connection);
  tasks.createProject({
    projectId: 'project-restart-recovery-guard-rejected',
    rootPath: fixture.repository,
  });
  tasks.create({
    taskId,
    projectId: 'project-restart-recovery-guard-rejected',
    workflowSnapshot: {
      ...createInitialWorkflow(taskId),
      state: 'awaiting_user',
      resumeTargetState: 'planning',
      awaitingReason: failureReason,
      allowedAwaitingActions: ['continue', 'cancel'],
    },
    workflowVersion: 4,
    status: 'awaiting_user',
  });
  fixture.database.connection
    .prepare(
      `INSERT INTO run_attempts(
         id, task_id, status, baseline_id, requirement_version, started_at
       ) VALUES (?, ?, 'pending', ?, 1, ?)`,
    )
    .run(attemptId, taskId, baselineId, startedAt);

  const actions = new ActionRepository(fixture.database.connection);
  actions.recordIntent({
    actionId: 'agent-run-guard-rejected',
    taskId,
    idempotencyKey: `${taskId}:agent-run-guard-rejected`,
    type: 'agent-run',
    payload: {
      schemaVersion: 1,
      attemptId,
      effect: {
        type: 'StartPlanning',
        taskId,
        attemptId,
        baselineId,
        requirementVersion: 1,
        role: 'master',
      },
      replayPolicy: 'never-auto-replay',
    },
  });
  actions.markFailed('agent-run-guard-rejected', {
    error: failureReason,
  });
  if (options.persistGuardDecision !== false) {
    actions.recordIntent({
      actionId: 'guard-decision-before-launch',
      taskId,
      idempotencyKey: `${taskId}:guard-decision-before-launch`,
      type: 'guard_decision',
      payload: {
        id: 'guard-decision-before-launch',
        mode: adapterDisabled ? 'auto_allowed' : 'disabled',
        scope: {
          kind: 'adapter_start',
          role: 'master',
          profileMode: adapterDisabled ? 'read_only' : 'disabled',
          executionScope: 'live_project',
        },
        reason: adapterDisabled
          ? 'master has exact verified read-only profile'
          : 'verified profile missing',
        attemptId,
        capabilityEvidence: {
          verified: adapterDisabled,
          profileMode: adapterDisabled ? 'read_only' : 'disabled',
        },
        role: 'master',
        userConfirmationRequired: false,
      },
    });
  }

  const lockService = new ProjectLockService(fixture.opened, {
    lockIdFactory: () => 'lock-before-guard-rejected-restart',
  });
  expect(lockService.acquire(
    taskId,
    canonicalizeProjectPath(fixture.repository),
    oldOwnerInstanceId,
    new Date(startedAt),
    60_000,
  ).status).toBe('acquired');

  let idCounter = 0;
  const service = new RestartRecoveryService({
    database: fixture.database,
    tracker: fixture.tracker,
    ownerInstanceId: newOwnerInstanceId,
    now: () => new Date('2026-07-13T04:05:00.000Z'),
    inspectProcess: async () => ({
      identity: 'unverifiable',
      terminalState: 'unknown',
      diagnostic: 'pending attempt has no durable process identity',
    }),
    idFactory: (kind) => `${kind}-guard-rejected-${String(++idCounter)}`,
  });

  return { fixture, service, tasks, taskId };
}

describe('RestartRecoveryService', () => {
  it('persists inspection evidence and continues exactly once with lock takeover and one effect group', async () => {
    const harness = await createRecoveryHarness();

    const inspected = await harness.service.inspect(harness.taskId);
    expect(inspected).toMatchObject({
      status: 'applied',
      workflowSnapshot: { state: 'awaiting_user' },
      evidence: {
        process: { identity: 'matched', terminalState: 'exited' },
        baseline: { status: 'complete' },
        changedFiles: ['src/counter.ts'],
      },
    });
    const repeatedInspect = await harness.service.inspect(harness.taskId);
    expect(repeatedInspect).toMatchObject({ status: 'already_applied' });

    const continued = await harness.service.continueAfterInspection(harness.taskId);
    expect(continued).toMatchObject({
      status: 'applied',
      workflowSnapshot: {
        state: 'implementing',
        activeAttemptRole: 'implementer',
      },
      execution: 'started',
    });
    expect(harness.executed).toHaveLength(1);
    expect(harness.executed[0]?.map((intent) => intent.effect.type)).toEqual([
      'CreateAttemptBaseline',
      'StartImplementation',
    ]);

    const activeLock = harness.fixture.database.connection
      .prepare(
        `SELECT owner_instance_id AS ownerInstanceId
         FROM project_locks WHERE task_id = ? AND released_at IS NULL`,
      )
      .get(harness.taskId);
    expect(activeLock).toEqual({ ownerInstanceId: harness.newOwnerInstanceId });
    expect(
      harness.fixture.database.connection
        .prepare(
          `SELECT action_type AS actionType, COUNT(*) AS count
           FROM pending_actions
           WHERE task_id = ? AND action_type IN ('create-attempt-baseline', 'agent-run')
           GROUP BY action_type ORDER BY action_type`,
        )
        .all(harness.taskId),
    ).toEqual([
      { actionType: 'agent-run', count: 1 },
      { actionType: 'create-attempt-baseline', count: 1 },
    ]);

    const repeatedContinue = await harness.service.continueAfterInspection(harness.taskId);
    expect(repeatedContinue).toMatchObject({ status: 'already_applied' });
    expect(harness.executed).toHaveLength(1);
    expect(
      harness.fixture.database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM pending_actions
           WHERE task_id = ? AND action_type = 'recovery-operator'`,
        )
        .get(harness.taskId),
    ).toEqual({ count: 2 });
  }, 30_000);

  it('cancels atomically, audits and deletes the old lock, and is idempotent', async () => {
    const harness = await createRecoveryHarness();
    await harness.service.inspect(harness.taskId);

    const cancelled = await harness.service.cancelAfterInspection(harness.taskId);
    expect(cancelled).toMatchObject({
      status: 'applied',
      workflowSnapshot: { state: 'cancelled' },
    });
    expect(harness.tasks.get(harness.taskId)?.status).toBe('cancelled');
    expect(
      harness.fixture.database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM project_locks
           WHERE task_id = ? AND released_at IS NULL`,
        )
        .get(harness.taskId),
    ).toEqual({ count: 0 });
    expect(
      harness.fixture.database.connection
        .prepare(
          `SELECT decision, COUNT(*) AS count
           FROM project_lock_reconciliations WHERE task_id = ? GROUP BY decision`,
        )
        .all(harness.taskId),
    ).toEqual([{ decision: 'release', count: 1 }]);

    const repeated = await harness.service.cancelAfterInspection(harness.taskId);
    expect(repeated).toMatchObject({ status: 'already_applied' });
    expect(
      harness.fixture.database.connection
        .prepare(
          `SELECT COUNT(*) AS count
           FROM project_lock_reconciliations WHERE task_id = ?`,
        )
        .get(harness.taskId),
    ).toEqual({ count: 1 });
  }, 30_000);

  it('cancels and audits a stale lock before any run attempt without fabricating an attempt ID', async () => {
    const harness = await createPreAttemptRecoveryHarness();

    const cancelled = await harness.service.cancelAfterInspection(harness.taskId);
    expect(cancelled).toMatchObject({
      status: 'applied',
      workflowSnapshot: { state: 'cancelled' },
      evidence: {
        process: { identity: 'not_applicable' },
        baseline: { status: 'missing' },
      },
    });
    expect(harness.tasks.get(harness.taskId)?.status).toBe('cancelled');
    expect(
      harness.fixture.database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM project_locks
           WHERE task_id = ? AND released_at IS NULL`,
        )
        .get(harness.taskId),
    ).toEqual({ count: 0 });
    expect(
      harness.fixture.database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM project_lock_reconciliations
           WHERE task_id = ? AND decision = 'release'`,
        )
        .get(harness.taskId),
    ).toEqual({ count: 1 });

    const operator = harness.fixture.database.connection
      .prepare(
        `SELECT payload_json AS payloadJson FROM pending_actions
         WHERE task_id = ? AND action_type = 'recovery-operator'`,
      )
      .get(harness.taskId) as { readonly payloadJson: string };
    const payload = JSON.parse(operator.payloadJson) as Record<string, unknown>;
    expect(payload.recoveryEpisodeKey).toBe('pre-attempt');
    expect(payload).not.toHaveProperty('episodeAttemptId');

    const repeated = await harness.service.cancelAfterInspection(harness.taskId);
    expect(repeated).toMatchObject({ status: 'already_applied' });
    expect(
      harness.fixture.database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM project_lock_reconciliations
           WHERE task_id = ?`,
        )
        .get(harness.taskId),
    ).toEqual({ count: 1 });
  }, 30_000);

  it('cancels a pending attempt only when a persisted disabled guard decision proves launch was rejected before process start', async () => {
    const harness = await createGuardRejectedPendingAttemptHarness();

    const cancelled = await harness.service.cancelAfterInspection(harness.taskId);

    expect(cancelled).toMatchObject({
      status: 'applied',
      workflowSnapshot: { state: 'cancelled' },
    });
    expect(harness.tasks.get(harness.taskId)?.status).toBe('cancelled');
    expect(
      harness.fixture.database.connection
        .prepare(
          `SELECT COUNT(*) AS count FROM project_locks
           WHERE task_id = ? AND released_at IS NULL`,
        )
        .get(harness.taskId),
    ).toEqual({ count: 0 });
  }, 30_000);

  it('cancels a pending attempt when an auto-allowed guard is followed by a typed AdapterDisabled prelaunch failure', async () => {
    const harness = await createGuardRejectedPendingAttemptHarness({
      failureKind: 'adapter_disabled',
    });

    const cancelled = await harness.service.cancelAfterInspection(harness.taskId);

    expect(cancelled).toMatchObject({
      status: 'applied',
      workflowSnapshot: { state: 'cancelled' },
    });
    expect(harness.tasks.get(harness.taskId)?.status).toBe('cancelled');
  }, 30_000);

  it('keeps an otherwise identical pending attempt blocked without durable disabled guard evidence', async () => {
    const harness = await createGuardRejectedPendingAttemptHarness({
      persistGuardDecision: false,
    });

    const cancelled = await harness.service.cancelAfterInspection(harness.taskId);

    expect(cancelled).toMatchObject({
      status: 'blocked',
      reason: 'recovery blocked: the prior attempt has no durable process identity',
    });
    expect(harness.tasks.get(harness.taskId)?.status).toBe('awaiting_user');
  }, 30_000);

  it.each([
    {
      identity: 'matched' as const,
      terminalState: 'running' as const,
      pid: 12_001,
      processStartedAt: '2026-07-13T04:00:00.000Z',
    },
    {
      identity: 'unverifiable' as const,
      terminalState: 'unknown' as const,
      diagnostic: 'process identity probe unavailable',
    },
  ])('keeps recovery blocked while the old process is not proven exited: %o', async (process) => {
    const harness = await createRecoveryHarness({ process });
    await harness.service.inspect(harness.taskId);

    const continued = await harness.service.continueAfterInspection(harness.taskId);
    const cancelled = await harness.service.cancelAfterInspection(harness.taskId);

    expect(continued).toMatchObject({ status: 'blocked' });
    expect(cancelled).toMatchObject({ status: 'blocked' });
    expect(harness.tasks.get(harness.taskId)?.status).toBe('awaiting_user');
    expect(harness.executed).toHaveLength(0);
    expect(
      harness.fixture.database.connection
        .prepare(
          `SELECT owner_instance_id AS ownerInstanceId
           FROM project_locks WHERE task_id = ? AND released_at IS NULL`,
        )
        .get(harness.taskId),
    ).toEqual({ ownerInstanceId: harness.oldOwnerInstanceId });
  }, 30_000);

  it('does not continue when the durable attempt baseline is incomplete', async () => {
    const harness = await createRecoveryHarness({ persistBaseline: false });
    await harness.service.inspect(harness.taskId);

    const continued = await harness.service.continueAfterInspection(harness.taskId);

    expect(continued).toMatchObject({
      status: 'blocked',
      reason: expect.stringMatching(/baseline/i),
    });
    expect(harness.tasks.get(harness.taskId)?.status).toBe('awaiting_user');
    expect(harness.executed).toHaveLength(0);
  }, 30_000);
});
