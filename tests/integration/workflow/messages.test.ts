import { afterEach, describe, expect, it } from 'vitest';

import { asAttemptId, asTaskId } from '../../../src/domain/ids.js';
import { ActionRepository } from '../../../src/persistence/action-repository.js';
import { TaskRepository } from '../../../src/persistence/task-repository.js';
import { createInitialWorkflow } from '../../../src/workflow/workflow-engine.js';
import { MessageQueue } from '../../../src/workflow/message-queue.js';
import { ReworkService } from '../../../src/workflow/rework-service.js';
import {
  createWorkflowFixture,
  type WorkflowFixture,
} from './workflow-test-fixture.js';

const fixtures: WorkflowFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0).reverse()) {
    await fixture.cleanup();
  }
});

function seedTask(
  fixture: WorkflowFixture,
  taskId: string,
  overrides: {
    readonly state?: 'implementing' | 'planning' | 'reviewing' | 'awaiting_user';
    readonly requirementVersion?: number;
    readonly activeAttemptId?: string;
  } = {},
): void {
  const tasks = new TaskRepository(fixture.database.connection);
  const id = asTaskId(taskId);
  // Projects root_path is unique; reuse an existing project row when seeding
  // multiple tasks against the same fixture repository.
  const existingProject = fixture.database.connection
    .prepare('SELECT id FROM projects WHERE root_path = ?')
    .get(fixture.repository) as { readonly id: string } | undefined;
  const projectId = existingProject?.id ?? `project-${taskId}`;
  if (existingProject === undefined) {
    tasks.createProject({ projectId, rootPath: fixture.repository });
  }
  const state = overrides.state ?? 'implementing';
  const snapshot = {
    ...createInitialWorkflow(id),
    state,
    requirementVersion: overrides.requirementVersion ?? 1,
    ...(state === 'implementing' || state === 'planning' || state === 'reviewing'
      ? {
          activeAttemptId: asAttemptId(overrides.activeAttemptId ?? 'attempt-active'),
          activeAttemptBaselineId: 'baseline-active',
          activeAttemptRole:
            state === 'implementing'
              ? ('implementer' as const)
              : state === 'reviewing'
                ? ('reviewer' as const)
                : ('master' as const),
        }
      : {}),
  };
  tasks.create({
    taskId: id,
    projectId,
    workflowSnapshot: snapshot as ReturnType<typeof createInitialWorkflow>,
    workflowVersion: 1,
    status: state,
  });
  fixture.database.connection
    .prepare(
      `INSERT INTO requirement_versions(task_id, version, requirements, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      id,
      overrides.requirementVersion ?? 1,
      JSON.stringify({
        requirements: 'Original scope',
        plan: 'Original plan',
        acceptanceCriteria: ['pass tests'],
        approved: true,
      }),
      fixture.clock.now(),
    );
}

function messageRow(
  fixture: WorkflowFixture,
  messageId: string,
): {
  readonly id: string;
  readonly status: string;
  readonly result_json: string | null;
  readonly error_text: string | null;
  readonly delivered_at: string | null;
} {
  return fixture.database.connection
    .prepare(
      `SELECT id, status, result_json, error_text, delivered_at
       FROM user_messages WHERE id = ?`,
    )
    .get(messageId) as {
    readonly id: string;
    readonly status: string;
    readonly result_json: string | null;
    readonly error_text: string | null;
    readonly delivered_at: string | null;
  };
}

describe('durable user message lifecycle', () => {
  it('persists queued -> delivered -> acknowledged -> applied atomically and idempotently', async () => {
    const fixture = await createWorkflowFixture('messages-lifecycle', []);
    fixtures.push(fixture);
    const taskId = asTaskId('task-msg-lifecycle');
    seedTask(fixture, taskId, { activeAttemptId: 'attempt-1' });
    const queue = new MessageQueue({
      database: fixture.database,
      now: () => new Date(fixture.clock.now()),
      idFactory: () => 'message-1',
    });

    const enqueued = queue.enqueue({
      taskId,
      body: 'Operational note: keep the existing plan',
      attemptId: asAttemptId('attempt-1'),
      kind: 'operational',
    });
    expect(enqueued.state).toBe('queued');
    expect(messageRow(fixture, enqueued.messageId).status).toBe('queued');

    const delivered = queue.markDelivered(enqueued.messageId, {
      attemptId: asAttemptId('attempt-1'),
    });
    expect(delivered.state).toBe('delivered');
    expect(messageRow(fixture, enqueued.messageId).status).toBe('delivered');
    expect(messageRow(fixture, enqueued.messageId).delivered_at).not.toBeNull();

    // Delivery must not imply acknowledgement or application.
    const afterDeliver = JSON.parse(messageRow(fixture, enqueued.messageId).result_json ?? '{}') as {
      readonly state?: string;
    };
    expect(afterDeliver.state).toBe('delivered');

    const acknowledged = queue.markAcknowledged(enqueued.messageId);
    expect(acknowledged.state).toBe('acknowledged');
    expect(messageRow(fixture, enqueued.messageId).status).toBe('delivered');
    expect(
      JSON.parse(messageRow(fixture, enqueued.messageId).result_json ?? '{}'),
    ).toMatchObject({ state: 'acknowledged' });

    const applied = queue.markApplied(enqueued.messageId, {
      appliedAt: fixture.clock.now(),
      requirementVersion: 1,
    });
    expect(applied.state).toBe('applied');
    expect(
      JSON.parse(messageRow(fixture, enqueued.messageId).result_json ?? '{}'),
    ).toMatchObject({ state: 'applied', requirementVersion: 1 });

    // Idempotent replay of each transition (no-ops once applied).
    expect(queue.markDelivered(enqueued.messageId).state).toBe('applied');
    expect(queue.markAcknowledged(enqueued.messageId).state).toBe('applied');
    expect(
      queue.markApplied(enqueued.messageId, {
        appliedAt: fixture.clock.now(),
        requirementVersion: 1,
      }).state,
    ).toBe('applied');
  }, 30_000);

  it('records explicit failed, dead-letter, and retry-safe failure states without silent resend', async () => {
    const fixture = await createWorkflowFixture('messages-failure', []);
    fixtures.push(fixture);
    const taskId = asTaskId('task-msg-fail');
    seedTask(fixture, taskId);
    const queue = new MessageQueue({
      database: fixture.database,
      now: () => new Date(fixture.clock.now()),
      idFactory: (() => {
        let n = 0;
        return () => {
          n += 1;
          return `message-fail-${String(n)}`;
        };
      })(),
    });

    const retryable = queue.enqueue({
      taskId,
      body: 'retry me later',
      attemptId: asAttemptId('attempt-active'),
      kind: 'operational',
    });
    const failed = queue.markFailed(retryable.messageId, {
      error: 'temporary channel error',
      failureKind: 'retry_safe',
    });
    expect(failed.state).toBe('failed');
    expect(failed.failureKind).toBe('retry_safe');
    expect(messageRow(fixture, retryable.messageId).status).toBe('failed');
    expect(
      JSON.parse(messageRow(fixture, retryable.messageId).result_json ?? '{}'),
    ).toMatchObject({ state: 'failed', failureKind: 'retry_safe' });

    // Retry-safe failure may re-queue once with a durable intent, never silently.
    const retried = queue.retryFailed(retryable.messageId, {
      actionId: 'action-retry-1',
      idempotencyKey: `${taskId}:message-retry:${retryable.messageId}`,
    });
    expect(retried.state).toBe('queued');
    const actions = new ActionRepository(fixture.database.connection);
    expect(actions.get('action-retry-1')?.status).toBe('completed');

    // Second retry with the same idempotency key is a no-op success.
    expect(
      queue.retryFailed(retryable.messageId, {
        actionId: 'action-retry-1',
        idempotencyKey: `${taskId}:message-retry:${retryable.messageId}`,
      }).state,
    ).toBe('queued');

    const dead = queue.enqueue({
      taskId,
      body: 'poison message',
      attemptId: asAttemptId('attempt-active'),
      kind: 'operational',
    });
    const deadLetter = queue.markFailed(dead.messageId, {
      error: 'permanent rejection',
      failureKind: 'dead_letter',
    });
    expect(deadLetter.state).toBe('failed');
    expect(deadLetter.failureKind).toBe('dead_letter');
    expect(() =>
      queue.retryFailed(dead.messageId, {
        actionId: 'action-retry-dead',
        idempotencyKey: `${taskId}:message-retry:${dead.messageId}`,
      }),
    ).toThrow(/dead.?letter|not retryable/i);
  });

  it('keeps unsupported real-time input queued until a verified safe point', async () => {
    const fixture = await createWorkflowFixture('messages-safe-point', []);
    fixtures.push(fixture);
    const taskId = asTaskId('task-msg-safe');
    seedTask(fixture, taskId, { state: 'implementing', activeAttemptId: 'attempt-run' });
    const queue = new MessageQueue({
      database: fixture.database,
      now: () => new Date(fixture.clock.now()),
      idFactory: () => 'message-safe',
      realTimeInputSupported: false,
    });

    const enqueued = queue.enqueue({
      taskId,
      body: 'Apply after this attempt finishes',
      attemptId: asAttemptId('attempt-run'),
      kind: 'operational',
    });
    expect(enqueued.state).toBe('queued');

    // Delivery is refused while the attempt is still running without real-time input.
    expect(() =>
      queue.deliverWhenSupported(enqueued.messageId, {
        attemptRunning: true,
        realTimeInputSupported: false,
      }),
    ).toThrow(/safe point|real.?time|queued/i);
    expect(messageRow(fixture, enqueued.messageId).status).toBe('queued');

    // Safe point: attempt settled — delivery is allowed.
    const delivered = queue.deliverWhenSupported(enqueued.messageId, {
      attemptRunning: false,
      realTimeInputSupported: false,
    });
    expect(delivered.state).toBe('delivered');
    expect(messageRow(fixture, enqueued.messageId).status).toBe('delivered');
  });

  it('creates a new requirement version for scope changes, invalidates reviews, and is replay-safe', async () => {
    const fixture = await createWorkflowFixture('messages-rework', []);
    fixtures.push(fixture);
    const taskId = asTaskId('task-msg-rework');
    seedTask(fixture, taskId, {
      state: 'reviewing',
      activeAttemptId: 'attempt-review',
    });
    for (const attempt of [
      { id: 'attempt-old-review', role: 'reviewer' },
      { id: 'attempt-old-master', role: 'master' },
    ] as const) {
      fixture.database.connection
        .prepare(
          `INSERT INTO run_attempts(
             id, task_id, status, role, pid, process_started_at, started_at,
             ended_at, exit_reason, baseline_id, requirement_version
           ) VALUES (?, ?, 'completed', ?, 7001, ?, ?, ?, 'completed', ?, 1)`,
        )
        .run(
          attempt.id,
          taskId,
          attempt.role,
          fixture.clock.now(),
          fixture.clock.now(),
          fixture.clock.now(),
          `baseline-${attempt.id}`,
        );
    }
    fixture.database.connection
      .prepare(
        `INSERT INTO reviews(
           id, task_id, attempt_id, reviewer_role, verdict, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'review-old-1',
        taskId,
        'attempt-old-review',
        'reviewer',
        'approved',
        JSON.stringify({
          bundleHash: 'a'.repeat(64),
          requirementVersion: 1,
          evidence: { trusted: true },
        }),
        fixture.clock.now(),
      );
    fixture.database.connection
      .prepare(
        `INSERT INTO reviews(
           id, task_id, attempt_id, reviewer_role, verdict, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'review-old-2',
        taskId,
        'attempt-old-master',
        'master',
        'approved',
        JSON.stringify({
          bundleHash: 'b'.repeat(64),
          requirementVersion: 1,
          evidence: { trusted: true },
        }),
        fixture.clock.now(),
      );

    const queue = new MessageQueue({
      database: fixture.database,
      now: () => new Date(fixture.clock.now()),
      idFactory: () => 'message-scope',
    });
    const rework = new ReworkService({
      database: fixture.database,
      messageQueue: queue,
      now: () => new Date(fixture.clock.now()),
      idFactory: (kind) => `${kind}-1`,
    });

    const message = queue.enqueue({
      taskId,
      body: 'Change acceptance criteria to require coverage above 90%',
      attemptId: asAttemptId('attempt-review'),
      kind: 'scope_change',
      scopeChange: {
        requirements: 'Coverage must exceed 90%',
        plan: 'Add coverage gate',
        acceptanceCriteria: ['coverage > 90%'],
      },
    });
    queue.markDelivered(message.messageId, { attemptId: asAttemptId('attempt-review') });
    queue.markAcknowledged(message.messageId);

    const first = rework.applyMessage(message.messageId, {
      planningAttemptId: asAttemptId('attempt-planning-1'),
      planningBaselineId: 'baseline-planning-1',
    });
    expect(first).toMatchObject({
      status: 'applied',
      requirementVersion: 2,
      returnedToPlanning: true,
      reviewsInvalidated: 2,
    });

    const task = new TaskRepository(fixture.database.connection).get(taskId)!;
    expect(task.workflowSnapshot.state).toBe('planning');
    expect(task.workflowSnapshot.requirementVersion).toBe(2);

    const versions = fixture.database.connection
      .prepare(
        'SELECT version FROM requirement_versions WHERE task_id = ? ORDER BY version',
      )
      .all(taskId) as Array<{ readonly version: number }>;
    expect(versions.map((row) => row.version)).toEqual([1, 2]);

    const reviews = fixture.database.connection
      .prepare('SELECT id, verdict FROM reviews WHERE task_id = ? ORDER BY id')
      .all(taskId) as Array<{ readonly id: string; readonly verdict: string }>;
    expect(reviews).toEqual([
      { id: 'review-old-1', verdict: 'invalid' },
      { id: 'review-old-2', verdict: 'invalid' },
    ]);

    const appliedMessage = queue.get(message.messageId);
    expect(appliedMessage?.state).toBe('applied');

    // Replay is idempotent: same message does not bump version again.
    const replay = rework.applyMessage(message.messageId, {
      planningAttemptId: asAttemptId('attempt-planning-1'),
      planningBaselineId: 'baseline-planning-1',
    });
    expect(replay).toMatchObject({
      status: 'already_applied',
      requirementVersion: 2,
    });
    expect(
      new TaskRepository(fixture.database.connection).get(taskId)!
        .workflowSnapshot.requirementVersion,
    ).toBe(2);
  });

  it('does not bump requirement version for non-scope operational messages', async () => {
    const fixture = await createWorkflowFixture('messages-ops', []);
    fixtures.push(fixture);
    const taskId = asTaskId('task-msg-ops');
    seedTask(fixture, taskId, { state: 'implementing' });
    const queue = new MessageQueue({
      database: fixture.database,
      now: () => new Date(fixture.clock.now()),
      idFactory: () => 'message-ops',
    });
    const rework = new ReworkService({
      database: fixture.database,
      messageQueue: queue,
      now: () => new Date(fixture.clock.now()),
      idFactory: (kind) => `${kind}-ops`,
    });

    const message = queue.enqueue({
      taskId,
      body: 'Please prefer smaller commits in the summary',
      attemptId: asAttemptId('attempt-active'),
      kind: 'operational',
    });
    queue.markDelivered(message.messageId);
    queue.markAcknowledged(message.messageId);
    const result = rework.applyMessage(message.messageId);
    expect(result).toMatchObject({
      status: 'applied',
      requirementVersion: 1,
      returnedToPlanning: false,
      reviewsInvalidated: 0,
    });
    expect(
      new TaskRepository(fixture.database.connection).get(taskId)!
        .workflowSnapshot.requirementVersion,
    ).toBe(1);
    expect(
      fixture.database.connection
        .prepare('SELECT COUNT(*) AS count FROM requirement_versions WHERE task_id = ?')
        .get(taskId),
    ).toEqual({ count: 1 });
  });

  it('blocks stale attempts from advancing after a requirement version bump', async () => {
    const fixture = await createWorkflowFixture('messages-stale', []);
    fixtures.push(fixture);
    const taskId = asTaskId('task-msg-stale');
    seedTask(fixture, taskId, { state: 'implementing', activeAttemptId: 'attempt-stale' });
    fixture.database.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, status, role, pid, process_started_at, started_at,
           baseline_id, requirement_version
         ) VALUES (?, ?, 'active', 'implementer', 7002, ?, ?, 'baseline-stale', 1)`,
      )
      .run(
        'attempt-stale',
        taskId,
        fixture.clock.now(),
        fixture.clock.now(),
      );
    const queue = new MessageQueue({
      database: fixture.database,
      now: () => new Date(fixture.clock.now()),
      idFactory: () => 'message-stale',
    });
    const rework = new ReworkService({
      database: fixture.database,
      messageQueue: queue,
      now: () => new Date(fixture.clock.now()),
      idFactory: (kind) => `${kind}-stale`,
    });

    const message = queue.enqueue({
      taskId,
      body: 'Rewrite the approved plan around API v2',
      attemptId: asAttemptId('attempt-stale'),
      kind: 'scope_change',
      scopeChange: {
        requirements: 'Use API v2',
        plan: 'Migrate clients to v2',
        acceptanceCriteria: ['v2 only'],
      },
    });
    queue.markDelivered(message.messageId);
    queue.markAcknowledged(message.messageId);
    rework.applyMessage(message.messageId, {
      planningAttemptId: asAttemptId('attempt-planning-stale'),
      planningBaselineId: 'baseline-planning-stale',
    });

    // Persist the new planning attempt at requirement version 2 (authoritative).
    fixture.database.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, status, started_at, baseline_id, requirement_version
         ) VALUES (?, ?, 'pending', ?, 'baseline-planning-stale', 2)`,
      )
      .run('attempt-planning-stale', taskId, fixture.clock.now());

    const gate = rework.assertAttemptMayAdvance({
      taskId,
      attemptId: asAttemptId('attempt-stale'),
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/stale|requirement version/i);

    const currentGate = rework.assertAttemptMayAdvance({
      taskId,
      attemptId: asAttemptId('attempt-planning-stale'),
    });
    expect(currentGate.allowed).toBe(true);
  });

  it('refuses applyMessage unless the durable state is acknowledged (bypass regressions)', async () => {
    const fixture = await createWorkflowFixture('messages-apply-gate', []);
    fixtures.push(fixture);
    const taskId = asTaskId('task-msg-apply-gate');
    seedTask(fixture, taskId);
    let n = 0;
    const queue = new MessageQueue({
      database: fixture.database,
      now: () => new Date(fixture.clock.now()),
      idFactory: () => {
        n += 1;
        return `message-apply-gate-${String(n)}`;
      },
    });
    const rework = new ReworkService({
      database: fixture.database,
      messageQueue: queue,
      now: () => new Date(fixture.clock.now()),
      idFactory: (kind) => `${kind}-apply-gate-${String(n)}`,
    });

    const queued = queue.enqueue({
      taskId,
      body: 'queued only',
      attemptId: asAttemptId('attempt-active'),
      kind: 'operational',
    });
    expect(() => rework.applyMessage(queued.messageId)).toThrow(
      /acknowledged|cannot apply/i,
    );
    expect(queue.get(queued.messageId)?.state).toBe('queued');

    const delivered = queue.enqueue({
      taskId,
      body: 'delivered only',
      attemptId: asAttemptId('attempt-active'),
      kind: 'operational',
    });
    queue.markDelivered(delivered.messageId);
    expect(() => rework.applyMessage(delivered.messageId)).toThrow(
      /acknowledged|cannot apply/i,
    );
    expect(queue.get(delivered.messageId)?.state).toBe('delivered');

    const failed = queue.enqueue({
      taskId,
      body: 'failed only',
      attemptId: asAttemptId('attempt-active'),
      kind: 'operational',
    });
    queue.markFailed(failed.messageId, {
      error: 'channel closed',
      failureKind: 'retry_safe',
    });
    expect(() => rework.applyMessage(failed.messageId)).toThrow(
      /acknowledged|cannot apply|failed/i,
    );

    const dead = queue.enqueue({
      taskId,
      body: 'dead letter',
      attemptId: asAttemptId('attempt-active'),
      kind: 'operational',
    });
    queue.markFailed(dead.messageId, {
      error: 'permanent',
      failureKind: 'dead_letter',
    });
    expect(() => rework.applyMessage(dead.messageId)).toThrow(
      /acknowledged|cannot apply|dead|failed/i,
    );

    // Happy path: acknowledged -> applied is allowed and already_applied is idempotent.
    const ok = queue.enqueue({
      taskId,
      body: 'ready to apply',
      attemptId: asAttemptId('attempt-active'),
      kind: 'operational',
    });
    queue.markDelivered(ok.messageId);
    queue.markAcknowledged(ok.messageId);
    expect(rework.applyMessage(ok.messageId).status).toBe('applied');
    expect(rework.applyMessage(ok.messageId).status).toBe('already_applied');
    expect(
      new TaskRepository(fixture.database.connection).get(taskId)!
        .workflowSnapshot.requirementVersion,
    ).toBe(1);
  });

  it('rejects forged attemptRequirementVersion claims; only DB requirement_version is authority', async () => {
    const fixture = await createWorkflowFixture('messages-forged-version', []);
    fixtures.push(fixture);
    const taskId = asTaskId('task-msg-forged');
    // Task snapshot is on requirement version 2.
    seedTask(fixture, taskId, {
      state: 'planning',
      requirementVersion: 2,
      activeAttemptId: 'attempt-forged',
    });
    // Attempt row is still bound to requirement version 1 (stale).
    fixture.database.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, status, role, pid, process_started_at, started_at,
           baseline_id, requirement_version
         ) VALUES (?, ?, 'active', 'master', 7003, ?, ?, 'baseline-forged', 1)`,
      )
      .run('attempt-forged', taskId, fixture.clock.now(), fixture.clock.now());

    const rework = new ReworkService({
      database: fixture.database,
      messageQueue: new MessageQueue({
        database: fixture.database,
        now: () => new Date(fixture.clock.now()),
      }),
      now: () => new Date(fixture.clock.now()),
    });

    // Caller cannot forge current version; only the attempt row is consulted.
    const gate = rework.assertAttemptMayAdvance({
      taskId,
      attemptId: asAttemptId('attempt-forged'),
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toMatch(/stale|requirement version/i);
    expect(gate.currentRequirementVersion).toBe(2);

    expect(
      rework.assertAttemptMayAdvance({
        taskId,
        attemptId: asAttemptId('missing-attempt'),
      }).allowed,
    ).toBe(false);

    // Wrong-task attempt is rejected.
    const otherTask = asTaskId('task-other-forged');
    seedTask(fixture, otherTask, {
      requirementVersion: 2,
      activeAttemptId: 'attempt-other-task',
    });
    fixture.database.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, status, role, pid, process_started_at, started_at,
           baseline_id, requirement_version
         ) VALUES (?, ?, 'active', 'implementer', 7004, ?, ?, 'baseline-other', 2)`,
      )
      .run(
        'attempt-other-task',
        otherTask,
        fixture.clock.now(),
        fixture.clock.now(),
      );
    expect(
      rework.assertAttemptMayAdvance({
        taskId,
        attemptId: asAttemptId('attempt-other-task'),
      }).allowed,
    ).toBe(false);

    // Terminal/completed attempts cannot advance even when version matches.
    fixture.database.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, status, role, pid, process_started_at, started_at,
           ended_at, exit_reason, baseline_id, requirement_version
         ) VALUES (?, ?, 'completed', 'master', 7005, ?, ?, ?, 'completed', 'baseline-done', 2)`,
      )
      .run(
        'attempt-terminal',
        taskId,
        fixture.clock.now(),
        fixture.clock.now(),
        fixture.clock.now(),
      );
    const terminal = rework.assertAttemptMayAdvance({
      taskId,
      attemptId: asAttemptId('attempt-terminal'),
    });
    expect(terminal.allowed).toBe(false);
    expect(terminal.reason).toMatch(/terminal|completed|invalid|killed/i);
  });
});
