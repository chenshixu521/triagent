import { afterEach, describe, expect, it } from 'vitest';

import { asAttemptId, asBaselineId, asTaskId } from '../../../src/domain/ids.js';
import { ActionRepository } from '../../../src/persistence/action-repository.js';
import { TaskRepository } from '../../../src/persistence/task-repository.js';
import {
  FakeClock,
  FakeProcessSupervisor,
  type FakeProcessPlan,
} from '../../fakes/fake-process-supervisor.js';
import { InterruptionService } from '../../../src/workflow/interruption-service.js';
import { PauseController } from '../../../src/workflow/pause-controller.js';
import { createInitialWorkflow } from '../../../src/workflow/workflow-engine.js';
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

function seedRunningTask(
  fixture: WorkflowFixture,
  taskId: string,
  options: {
    readonly state?: 'implementing' | 'reviewing' | 'planning' | 'master_validation';
    readonly attemptId?: string;
    readonly baselineId?: string;
  } = {},
): void {
  const tasks = new TaskRepository(fixture.database.connection);
  const id = asTaskId(taskId);
  const state = options.state ?? 'implementing';
  const attemptId = asAttemptId(options.attemptId ?? 'attempt-run');
  const baselineId = asBaselineId(options.baselineId ?? 'baseline-run');
  tasks.createProject({ projectId: `project-${taskId}`, rootPath: fixture.repository });
  const role =
    state === 'implementing'
      ? ('implementer' as const)
      : state === 'reviewing'
        ? ('reviewer' as const)
        : ('master' as const);
  tasks.create({
    taskId: id,
    projectId: `project-${taskId}`,
    workflowSnapshot: {
      ...createInitialWorkflow(id),
      state,
      activeAttemptId: attemptId,
      activeAttemptBaselineId: baselineId,
      activeAttemptRole: role,
    },
    workflowVersion: 1,
    status: state,
  });
  fixture.database.connection
    .prepare(
      `INSERT INTO requirement_versions(task_id, version, requirements, created_at)
       VALUES (?, 1, ?, ?)`,
    )
    .run(id, JSON.stringify({ requirements: 'pause/interrupt fixture' }), fixture.clock.now());
  fixture.database.connection
    .prepare(
      `INSERT INTO run_attempts(
         id, task_id, status, role, pid, process_started_at, started_at,
         baseline_id, requirement_version
       ) VALUES (?, ?, 'active', ?, 9001, ?, ?, ?, 1)`,
    )
    .run(
      attemptId,
      id,
      role,
      fixture.clock.now(),
      fixture.clock.now(),
      baselineId,
    );
}

function longRunningPlan(pid: number): FakeProcessPlan {
  return {
    pid,
    timeline: [
      { afterMs: 1, event: { type: 'started', pid } },
      // No exit until stop is requested.
    ],
    gracefulStop: { afterMs: 5, outcome: 'succeeded', exitCode: 0 },
    forceStop: { afterMs: 2, outcome: 'succeeded', exitCode: 1 },
  };
}

describe('pause-after-run controller', () => {
  it('records pause without claiming the process has stopped while it is still alive', async () => {
    const fixture = await createWorkflowFixture('pause-alive', [longRunningPlan(8101)]);
    fixtures.push(fixture);
    const taskId = asTaskId('task-pause-alive');
    const attemptId = asAttemptId('attempt-run');
    seedRunningTask(fixture, taskId, { attemptId });

    const started = await fixture.supervisor.start({
      attemptId,
      executable: 'D:\\fixtures\\fake-cli.mjs',
      args: [],
      cwd: fixture.repository,
    });
    expect(started.pid).toBe(8101);

    const pause = new PauseController({
      database: fixture.database,
      supervisor: fixture.supervisor,
      now: () => new Date(fixture.clock.now()),
      idFactory: (kind) => `${kind}-pause`,
    });

    const requested = await pause.requestPauseAfterRun(taskId);
    expect(requested).toMatchObject({
      status: 'pause_requested',
      processRunning: true,
      workflowState: 'implementing',
      pauseAfterAttempt: true,
    });

    // TUI-facing view must not lie: process still running, not paused yet.
    const view = pause.getRuntimeView(taskId);
    expect(view).toMatchObject({
      processRunning: true,
      workflowState: 'implementing',
      pauseAfterAttempt: true,
      paused: false,
    });

    // Resume is illegal until the attempt actually settles into paused_after_run.
    await expect(pause.resume(taskId)).rejects.toThrow(/paused_after_run|not paused/i);
  }, 30_000);

  it('enters paused only after supervisor settlement and stores resume_target_state once', async () => {
    const clock = new FakeClock('2026-07-12T05:00:00.000Z');
    const plan: FakeProcessPlan = {
      pid: 8201,
      timeline: [
        { afterMs: 1, event: { type: 'started', pid: 8201 } },
        {
          afterMs: 10,
          event: {
            type: 'exited',
            pid: 8201,
            exitCode: 0,
            signal: null,
            reason: 'exited',
          },
        },
      ],
    };
    const fixture = await createWorkflowFixture('pause-settle', [plan]);
    fixtures.push(fixture);
    // Replace fixture clock-driven supervisor plan already wired; use fixture.supervisor.
    const taskId = asTaskId('task-pause-settle');
    const attemptId = asAttemptId('attempt-run');
    seedRunningTask(fixture, taskId, { attemptId, state: 'implementing' });

    const started = await fixture.supervisor.start({
      attemptId,
      executable: 'D:\\fixtures\\fake-cli.mjs',
      args: [],
      cwd: fixture.repository,
    });
    // Bind persisted attempt identity to the real supervised launch.
    fixture.database.connection
      .prepare(
        `UPDATE run_attempts
         SET pid = ?, process_started_at = ?
         WHERE id = ?`,
      )
      .run(started.pid, started.startedAt, attemptId);

    let pauseIds = 0;
    const pause = new PauseController({
      database: fixture.database,
      supervisor: fixture.supervisor,
      now: () => new Date(fixture.clock.now()),
      idFactory: (kind) => {
        pauseIds += 1;
        return `${kind}-settle-${String(pauseIds)}`;
      },
    });
    await pause.requestPauseAfterRun(taskId);

    // Process still alive before exit event.
    expect(pause.getRuntimeView(taskId).processRunning).toBe(true);

    // Forged settlement while process is still alive must be denied.
    const forgedWhileAlive = await pause.onAttemptSettled(taskId, {
      attemptId,
      normalSuccessor: {
        resumeTargetState: 'reviewing',
        pendingResumeAttempt: {
          attemptId: asAttemptId('attempt-review'),
          baselineId: asBaselineId('baseline-review'),
          role: 'reviewer',
        },
      },
    });
    expect(forgedWhileAlive).toMatchObject({
      status: 'denied',
      processRunning: true,
      workflowState: 'implementing',
    });
    expect(
      new TaskRepository(fixture.database.connection).get(taskId)!.status,
    ).toBe('implementing');

    // Real supervisor settlement, then durable pause is allowed.
    fixture.clock.advanceBy(10);
    const waitResult = await fixture.supervisor.wait(attemptId);
    fixture.database.connection
      .prepare(
        `UPDATE run_attempts
         SET status = 'completed', ended_at = ?, exit_reason = 'completed', pid = ?
         WHERE id = ?`,
      )
      .run(fixture.clock.now(), waitResult.pid, attemptId);

    const attemptAfter = fixture.database.connection
      .prepare(
        `SELECT status, pid, exit_reason AS exitReason FROM run_attempts WHERE id = ?`,
      )
      .get(attemptId);
    expect(attemptAfter).toMatchObject({ status: 'completed', exitReason: 'completed' });

    const settled = await pause.onAttemptSettled(taskId, {
      attemptId,
      normalSuccessor: {
        resumeTargetState: 'reviewing',
        pendingResumeAttempt: {
          attemptId: asAttemptId('attempt-review'),
          baselineId: asBaselineId('baseline-review'),
          role: 'reviewer',
        },
      },
    });
    expect(settled, JSON.stringify(settled)).toMatchObject({
      status: 'paused',
      workflowState: 'paused_after_run',
      resumeTargetState: 'reviewing',
      processRunning: false,
    });

    const task = new TaskRepository(fixture.database.connection).get(taskId)!;
    expect(task.workflowSnapshot.state).toBe('paused_after_run');
    expect(task.workflowSnapshot.resumeTargetState).toBe('reviewing');
    expect(task.workflowSnapshot.pauseAfterAttempt).toBe(false);
    expect(task.workflowSnapshot.activeAttemptId).toBeUndefined();

    // Resume consumes resume_target_state exactly once.
    const resumed = await pause.resume(taskId);
    expect(resumed).toMatchObject({
      status: 'resumed',
      workflowState: 'reviewing',
      resumeTargetState: 'reviewing',
    });
    const after = new TaskRepository(fixture.database.connection).get(taskId)!;
    expect(after.workflowSnapshot.state).toBe('reviewing');
    expect(after.workflowSnapshot.resumeTargetState).toBeUndefined();

    await expect(pause.resume(taskId)).rejects.toThrow(
      /resume_target|already consumed|not paused|paused_after_run/i,
    );

    // Budget durability: resume records a completed intent, never a silent free restart.
    const actions = new ActionRepository(fixture.database.connection).listPending();
    expect(actions).toHaveLength(0);
    const completedResume = fixture.database.connection
      .prepare(
        `SELECT status FROM pending_actions
         WHERE task_id = ? AND action_type = 'pause-resume'`,
      )
      .get(taskId) as { readonly status: string } | undefined;
    expect(completedResume?.status).toBe('completed');

    void clock;
  });

  it('denies pause when DB is prematurely completed while supervisor.wait is still pending', async () => {
    const fixture = await createWorkflowFixture('pause-premature-db', [
      {
        pid: 8221,
        timeline: [
          { afterMs: 1, event: { type: 'started', pid: 8221 } },
          {
            afterMs: 20,
            event: {
              type: 'exited',
              pid: 8221,
              exitCode: 0,
              signal: null,
              reason: 'exited',
            },
          },
        ],
      },
    ]);
    fixtures.push(fixture);
    const taskId = asTaskId('task-pause-premature-db');
    const attemptId = asAttemptId('attempt-run');
    seedRunningTask(fixture, taskId, { attemptId });
    const started = await fixture.supervisor.start({
      attemptId,
      executable: 'D:\\fixtures\\fake-cli.mjs',
      args: [],
      cwd: fixture.repository,
    });
    fixture.database.connection
      .prepare(
        `UPDATE run_attempts
         SET pid = ?, process_started_at = ?
         WHERE id = ?`,
      )
      .run(started.pid, started.startedAt, attemptId);

    let pauseIds = 0;
    const pause = new PauseController({
      database: fixture.database,
      supervisor: fixture.supervisor,
      now: () => new Date(fixture.clock.now()),
      idFactory: (kind) => {
        pauseIds += 1;
        return `${kind}-premature-${String(pauseIds)}`;
      },
    });
    pause.noteAttemptStarted(attemptId);
    await pause.requestPauseAfterRun(taskId);

    // Incorrect/premature terminal DB row while process is still registered alive.
    fixture.database.connection
      .prepare(
        `UPDATE run_attempts
         SET status = 'completed', ended_at = ?, exit_reason = 'completed'
         WHERE id = ?`,
      )
      .run(fixture.clock.now(), attemptId);

    const denied = await pause.onAttemptSettled(taskId, {
      attemptId,
      normalSuccessor: {
        resumeTargetState: 'reviewing',
        pendingResumeAttempt: {
          attemptId: asAttemptId('attempt-review'),
          baselineId: asBaselineId('baseline-review'),
          role: 'reviewer',
        },
      },
    });
    expect(denied).toMatchObject({
      status: 'denied',
      processRunning: true,
      workflowState: 'implementing',
    });
    expect(denied.reason).toMatch(/alive|unsettled|pending|running/i);
    expect(
      new TaskRepository(fixture.database.connection).get(taskId)!.status,
    ).toBe('implementing');
    expect(
      new TaskRepository(fixture.database.connection).get(taskId)!
        .workflowSnapshot.pauseAfterAttempt,
    ).toBe(true);

    // After supervisor settles and liveness clears, pause may succeed exactly once.
    fixture.clock.advanceBy(20);
    const waitResult = await fixture.supervisor.wait(attemptId);
    fixture.database.connection
      .prepare(
        `UPDATE run_attempts SET pid = ? WHERE id = ?`,
      )
      .run(waitResult.pid, attemptId);
    pause.noteAttemptSettled(attemptId);

    const settled = await pause.onAttemptSettled(taskId, {
      attemptId,
      normalSuccessor: {
        resumeTargetState: 'reviewing',
        pendingResumeAttempt: {
          attemptId: asAttemptId('attempt-review'),
          baselineId: asBaselineId('baseline-review'),
          role: 'reviewer',
        },
      },
    });
    expect(settled).toMatchObject({
      status: 'paused',
      workflowState: 'paused_after_run',
      processRunning: false,
    });

    const again = await pause.onAttemptSettled(taskId, {
      attemptId,
      normalSuccessor: { resumeTargetState: 'reviewing' },
    });
    expect(again.status).toBe('already_paused');
  });

  it('denies forged onAttemptSettled while process is alive or attempt is nonterminal', async () => {
    const fixture = await createWorkflowFixture('pause-forged', [
      longRunningPlan(8211),
    ]);
    fixtures.push(fixture);
    const taskId = asTaskId('task-pause-forged');
    const attemptId = asAttemptId('attempt-run');
    seedRunningTask(fixture, taskId, { attemptId });
    await fixture.supervisor.start({
      attemptId,
      executable: 'D:\\fixtures\\fake-cli.mjs',
      args: [],
      cwd: fixture.repository,
    });

    const pause = new PauseController({
      database: fixture.database,
      supervisor: fixture.supervisor,
      now: () => new Date(fixture.clock.now()),
      idFactory: (kind) => `${kind}-forged`,
    });
    await pause.requestPauseAfterRun(taskId);

    const denied = await pause.onAttemptSettled(taskId, {
      attemptId,
      normalSuccessor: { resumeTargetState: 'reviewing' },
    });
    expect(denied).toMatchObject({
      status: 'denied',
      processRunning: true,
      workflowState: 'implementing',
    });
    expect(denied.reason).toMatch(/running|alive|settled|terminal|identity/i);
    expect(
      new TaskRepository(fixture.database.connection).get(taskId)!.status,
    ).toBe('implementing');
    expect(
      new TaskRepository(fixture.database.connection).get(taskId)!
        .workflowSnapshot.pauseAfterAttempt,
    ).toBe(true);
  });
});

describe('interruption cleanup service', () => {
  it('persists stop intent before side effects, cooperatively stops, then force-closes the Job', async () => {
    const fixture = await createWorkflowFixture('interrupt-happy', [
      {
        pid: 8301,
        timeline: [{ afterMs: 1, event: { type: 'started', pid: 8301 } }],
        // Cooperative stop alone is insufficient; force is required.
        gracefulStop: { afterMs: 50, outcome: 'failed', error: 'agent ignored stop' },
        forceStop: { afterMs: 2, outcome: 'succeeded', exitCode: 1 },
      },
    ]);
    fixtures.push(fixture);
    const taskId = asTaskId('task-interrupt-happy');
    const attemptId = asAttemptId('attempt-run');
    seedRunningTask(fixture, taskId, { attemptId });

    await fixture.supervisor.start({
      attemptId,
      executable: 'D:\\fixtures\\fake-cli.mjs',
      args: [],
      cwd: fixture.repository,
    });

    let treeChecks = 0;
    const interruption = new InterruptionService({
      database: fixture.database,
      supervisor: fixture.supervisor,
      tracker: fixture.tracker,
      now: () => new Date(fixture.clock.now()),
      gracePeriodMs: 10,
      idFactory: (kind) => `${kind}-int`,
      advanceClock: (ms) => fixture.clock.advanceBy(ms),
      verifyTreeGone: async () => {
        treeChecks += 1;
        // After force stop the tree is gone.
        const forceCalls = fixture.supervisor.calls.filter(
          (call) => call.type === 'force_stop_tree',
        );
        return forceCalls.length > 0
          ? { clean: true as const }
          : { clean: false as const, reason: 'process still alive' };
      },
      rescanProject: async () => ({ ok: true as const, changeCount: 0 }),
    });

    const result = await interruption.interrupt(taskId);
    expect(result).toMatchObject({
      status: 'interrupted_needs_inspection',
      cleanupComplete: true,
      exitAllowed: true,
    });

    const task = new TaskRepository(fixture.database.connection).get(taskId)!;
    expect(task.workflowSnapshot.state).toBe('interrupted_needs_inspection');
    expect(task.workflowSnapshot.resumeTargetState).toBe('implementing');
    expect(task.workflowSnapshot.stopIntent).toBeUndefined();
    expect(task.workflowSnapshot.activeAttemptId).toBeUndefined();

    const callTypes = fixture.supervisor.calls.map((call) => call.type);
    expect(callTypes).toContain('request_graceful_stop');
    expect(callTypes).toContain('force_stop_tree');
    // Stop intent must be durable before cooperative stop.
    const intentBeforeStop = fixture.database.connection
      .prepare(
        `SELECT status, action_type AS actionType FROM pending_actions
         WHERE task_id = ? AND action_type = 'process-cleanup'
         ORDER BY created_at LIMIT 1`,
      )
      .get(taskId) as { readonly status: string; readonly actionType: string };
    expect(intentBeforeStop.actionType).toBe('process-cleanup');
    expect(['intent', 'completed', 'failed']).toContain(intentBeforeStop.status);
    expect(treeChecks).toBeGreaterThan(0);
  });

  it('blocks TUI exit when tree cleanup verification fails', async () => {
    const fixture = await createWorkflowFixture('interrupt-tree-fail', [
      {
        pid: 8401,
        timeline: [{ afterMs: 1, event: { type: 'started', pid: 8401 } }],
        gracefulStop: { afterMs: 1, outcome: 'succeeded', exitCode: 0 },
        forceStop: { afterMs: 1, outcome: 'succeeded', exitCode: 1 },
      },
    ]);
    fixtures.push(fixture);
    const taskId = asTaskId('task-interrupt-tree-fail');
    const attemptId = asAttemptId('attempt-run');
    seedRunningTask(fixture, taskId, { attemptId });
    await fixture.supervisor.start({
      attemptId,
      executable: 'D:\\fixtures\\fake-cli.mjs',
      args: [],
      cwd: fixture.repository,
    });

    const interruption = new InterruptionService({
      database: fixture.database,
      supervisor: fixture.supervisor,
      tracker: fixture.tracker,
      now: () => new Date(fixture.clock.now()),
      gracePeriodMs: 5,
      idFactory: (kind) => `${kind}-tree-fail`,
      advanceClock: (ms) => fixture.clock.advanceBy(ms),
      verifyTreeGone: async () => ({
        clean: false,
        reason: 'PID identity still matched after force stop',
      }),
      rescanProject: async () => ({ ok: true as const, changeCount: 0 }),
    });

    const result = await interruption.interrupt(taskId);
    expect(result).toMatchObject({
      status: 'cleanup_failed',
      cleanupComplete: false,
      exitAllowed: false,
    });
    expect(result.reason).toMatch(/tree|PID|identity|cleanup/i);

    const task = new TaskRepository(fixture.database.connection).get(taskId)!;
    expect(task.workflowSnapshot.state).toBe('cleanup_failed');
    expect(task.workflowSnapshot.stopIntent).toBe('interrupt');
    expect(task.workflowSnapshot.activeAttemptId).toBe(attemptId);

    const exitGate = interruption.canExitTui(taskId);
    expect(exitGate.allowed).toBe(false);
    expect(exitGate.reason).toMatch(/cleanup|exit blocked/i);
  });

  it('blocks TUI exit when project rescan fails after tree cleanup', async () => {
    const fixture = await createWorkflowFixture('interrupt-rescan-fail', [
      {
        pid: 8501,
        timeline: [{ afterMs: 1, event: { type: 'started', pid: 8501 } }],
        gracefulStop: { afterMs: 1, outcome: 'succeeded', exitCode: 0 },
        forceStop: { afterMs: 1, outcome: 'succeeded', exitCode: 1 },
      },
    ]);
    fixtures.push(fixture);
    const taskId = asTaskId('task-interrupt-rescan-fail');
    const attemptId = asAttemptId('attempt-run');
    seedRunningTask(fixture, taskId, { attemptId });
    await fixture.supervisor.start({
      attemptId,
      executable: 'D:\\fixtures\\fake-cli.mjs',
      args: [],
      cwd: fixture.repository,
    });

    const interruption = new InterruptionService({
      database: fixture.database,
      supervisor: fixture.supervisor,
      tracker: fixture.tracker,
      now: () => new Date(fixture.clock.now()),
      gracePeriodMs: 5,
      idFactory: (kind) => `${kind}-rescan-fail`,
      advanceClock: (ms) => fixture.clock.advanceBy(ms),
      verifyTreeGone: async () => ({ clean: true as const }),
      rescanProject: async () => ({
        ok: false as const,
        reason: 'baseline rescan checksum mismatch',
      }),
    });

    const result = await interruption.interrupt(taskId);
    expect(result).toMatchObject({
      status: 'cleanup_failed',
      cleanupComplete: false,
      exitAllowed: false,
    });
    expect(result.reason).toMatch(/rescan|baseline/i);
    expect(interruption.canExitTui(taskId).allowed).toBe(false);
    expect(
      new TaskRepository(fixture.database.connection).get(taskId)!
        .workflowSnapshot.state,
    ).toBe('cleanup_failed');
  });

  it('is idempotent for repeated interruption and recovery attempts', async () => {
    const fixture = await createWorkflowFixture('interrupt-idempotent', [
      {
        pid: 8601,
        timeline: [{ afterMs: 1, event: { type: 'started', pid: 8601 } }],
        gracefulStop: { afterMs: 1, outcome: 'succeeded', exitCode: 0 },
        forceStop: { afterMs: 1, outcome: 'succeeded', exitCode: 1 },
      },
    ]);
    fixtures.push(fixture);
    const taskId = asTaskId('task-interrupt-idempotent');
    const attemptId = asAttemptId('attempt-run');
    seedRunningTask(fixture, taskId, { attemptId });
    await fixture.supervisor.start({
      attemptId,
      executable: 'D:\\fixtures\\fake-cli.mjs',
      args: [],
      cwd: fixture.repository,
    });

    let rescans = 0;
    const interruption = new InterruptionService({
      database: fixture.database,
      supervisor: fixture.supervisor,
      tracker: fixture.tracker,
      now: () => new Date(fixture.clock.now()),
      gracePeriodMs: 5,
      idFactory: (() => {
        let n = 0;
        return (kind: string) => {
          n += 1;
          return `${kind}-${String(n)}`;
        };
      })(),
      advanceClock: (ms) => fixture.clock.advanceBy(ms),
      verifyTreeGone: async () => ({ clean: true as const }),
      rescanProject: async () => {
        rescans += 1;
        return { ok: true as const, changeCount: 1 };
      },
    });

    const first = await interruption.interrupt(taskId);
    expect(first.status).toBe('interrupted_needs_inspection');
    const forceAfterFirst = fixture.supervisor.calls.filter(
      (call) => call.type === 'force_stop_tree',
    ).length;
    const rescansAfterFirst = rescans;
    expect(rescansAfterFirst).toBe(1);

    const second = await interruption.interrupt(taskId);
    expect(second).toMatchObject({
      status: 'interrupted_needs_inspection',
      cleanupComplete: true,
      alreadyComplete: true,
    });
    // Second call must not re-force the tree or re-rescan when already complete.
    const forceAfterSecond = fixture.supervisor.calls.filter(
      (call) => call.type === 'force_stop_tree',
    ).length;
    expect(forceAfterSecond).toBe(forceAfterFirst);
    expect(rescans).toBe(rescansAfterFirst);
  });

  it('orders crash recovery: durable stop intent survives before side effects resume', async () => {
    const fixture = await createWorkflowFixture('interrupt-crash-order', []);
    fixtures.push(fixture);
    const taskId = asTaskId('task-interrupt-crash');
    const attemptId = asAttemptId('attempt-run');
    seedRunningTask(fixture, taskId, { attemptId });

    // Simulate a crash after stop intent was persisted but before cleanup finished.
    const tasks = new TaskRepository(fixture.database.connection);
    const current = tasks.get(taskId)!;
    tasks.updateWorkflow(taskId, {
      expectedVersion: current.workflowVersion,
      status: 'interrupting',
      workflowSnapshot: {
        ...current.workflowSnapshot,
        state: 'interrupting',
        stopIntent: 'interrupt',
        resumeTargetState: 'implementing',
        activeAttemptId: attemptId,
        activeAttemptBaselineId: asBaselineId('baseline-run'),
        activeAttemptRole: 'implementer',
      },
    });
    const actions = new ActionRepository(fixture.database.connection);
    actions.recordIntent({
      actionId: 'action-cleanup-crash',
      taskId,
      idempotencyKey: `${taskId}:process-cleanup:${attemptId}`,
      type: 'process-cleanup',
      payload: {
        attemptId,
        stopIntent: 'interrupt',
        phase: 'intent_persisted',
      },
    });

    // No process plan: recovery must fail closed rather than claim complete.
    const interruption = new InterruptionService({
      database: fixture.database,
      supervisor: new FakeProcessSupervisor(fixture.clock, []),
      tracker: fixture.tracker,
      now: () => new Date(fixture.clock.now()),
      gracePeriodMs: 5,
      idFactory: (kind) => `${kind}-crash`,
      advanceClock: (ms) => fixture.clock.advanceBy(ms),
      verifyTreeGone: async () => ({
        clean: false,
        reason: 'process identity unverifiable after crash',
      }),
      rescanProject: async () => ({ ok: true as const, changeCount: 0 }),
    });

    const recovered = await interruption.resumeCleanup(taskId);
    expect(recovered).toMatchObject({
      status: 'cleanup_failed',
      cleanupComplete: false,
      exitAllowed: false,
    });
    // Original intent remains durable; no silent completion.
    expect(actions.get('action-cleanup-crash')?.status).not.toBe('completed');
    expect(interruption.canExitTui(taskId).allowed).toBe(false);
  });

  it('reopens a failed cleanup action on retry and never completes a non-intent row', async () => {
    const fixture = await createWorkflowFixture('interrupt-retry-durability', [
      {
        pid: 8701,
        timeline: [{ afterMs: 1, event: { type: 'started', pid: 8701 } }],
        gracefulStop: { afterMs: 1, outcome: 'succeeded', exitCode: 0 },
        forceStop: { afterMs: 1, outcome: 'succeeded', exitCode: 1 },
      },
    ]);
    fixtures.push(fixture);
    const taskId = asTaskId('task-interrupt-retry');
    const attemptId = asAttemptId('attempt-run');
    seedRunningTask(fixture, taskId, { attemptId });
    await fixture.supervisor.start({
      attemptId,
      executable: 'D:\\fixtures\\fake-cli.mjs',
      args: [],
      cwd: fixture.repository,
    });

    let verifyPasses = false;
    let actionIds = 0;
    const interruption = new InterruptionService({
      database: fixture.database,
      supervisor: fixture.supervisor,
      tracker: fixture.tracker,
      now: () => new Date(fixture.clock.now()),
      gracePeriodMs: 5,
      idFactory: (kind) => {
        actionIds += 1;
        return `${kind}-retry-${String(actionIds)}`;
      },
      advanceClock: (ms) => fixture.clock.advanceBy(ms),
      verifyTreeGone: async () =>
        verifyPasses
          ? { clean: true as const }
          : { clean: false as const, reason: 'still alive after first try' },
      rescanProject: async () => ({ ok: true as const, changeCount: 0 }),
    });

    const first = await interruption.interrupt(taskId);
    expect(first).toMatchObject({
      status: 'cleanup_failed',
      cleanupComplete: false,
      exitAllowed: false,
    });
    const failedAction = fixture.database.connection
      .prepare(
        `SELECT id, status, error_text AS errorText, completed_at AS completedAt
         FROM pending_actions
         WHERE task_id = ? AND action_type = 'process-cleanup'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId) as {
      readonly id: string;
      readonly status: string;
      readonly errorText: string | null;
      readonly completedAt: string | null;
    };
    expect(failedAction.status).toBe('failed');
    expect(failedAction.completedAt).not.toBeNull();

    // canExitTui blocks on latest non-completed cleanup (failed counts).
    expect(interruption.canExitTui(taskId)).toMatchObject({
      allowed: false,
    });

    verifyPasses = true;
    const second = await interruption.resumeCleanup(taskId);
    expect(second).toMatchObject({
      status: 'interrupted_needs_inspection',
      cleanupComplete: true,
      exitAllowed: true,
    });

    const after = fixture.database.connection
      .prepare(
        `SELECT id, status, payload_json AS payloadJson
         FROM pending_actions
         WHERE task_id = ? AND action_type = 'process-cleanup'
         ORDER BY created_at, id`,
      )
      .all(taskId) as Array<{
      readonly id: string;
      readonly status: string;
      readonly payloadJson: string;
    }>;
    // Either the same row was reopened failed->intent->completed, or a new
    // uniquely keyed retry action was created and completed.
    const completed = after.filter((row) => row.status === 'completed');
    expect(completed.length).toBeGreaterThanOrEqual(1);
    expect(after.every((row) => row.status !== 'intent')).toBe(true);
    const reopenOrLinked = after.some((row) => {
      const payload = JSON.parse(row.payloadJson) as {
        readonly retryCount?: number;
        readonly priorActionId?: string;
      };
      return (
        (payload.retryCount !== undefined && payload.retryCount >= 1)
        || payload.priorActionId !== undefined
        || row.id === failedAction.id
      );
    });
    expect(reopenOrLinked).toBe(true);
    expect(interruption.canExitTui(taskId).allowed).toBe(true);
  });

  it('fails closed when completeCleanup cannot mark exactly one intent action completed', async () => {
    const fixture = await createWorkflowFixture('interrupt-complete-race', [
      {
        pid: 8801,
        timeline: [{ afterMs: 1, event: { type: 'started', pid: 8801 } }],
        gracefulStop: { afterMs: 1, outcome: 'succeeded', exitCode: 0 },
        forceStop: { afterMs: 1, outcome: 'succeeded', exitCode: 1 },
      },
    ]);
    fixtures.push(fixture);
    const taskId = asTaskId('task-interrupt-complete-race');
    const attemptId = asAttemptId('attempt-run');
    seedRunningTask(fixture, taskId, { attemptId });
    await fixture.supervisor.start({
      attemptId,
      executable: 'D:\\fixtures\\fake-cli.mjs',
      args: [],
      cwd: fixture.repository,
    });

    const interruption = new InterruptionService({
      database: fixture.database,
      supervisor: fixture.supervisor,
      tracker: fixture.tracker,
      now: () => new Date(fixture.clock.now()),
      gracePeriodMs: 5,
      idFactory: (kind) => `${kind}-race`,
      advanceClock: (ms) => fixture.clock.advanceBy(ms),
      verifyTreeGone: async () => {
        // Poison the open intent so completeCleanup cannot find status=intent.
        fixture.database.connection
          .prepare(
            `UPDATE pending_actions
             SET status = 'failed', error_text = 'poisoned before complete',
                 completed_at = ?, updated_at = ?
             WHERE task_id = ? AND action_type = 'process-cleanup' AND status = 'intent'`,
          )
          .run(fixture.clock.now(), fixture.clock.now(), taskId);
        return { clean: true as const };
      },
      rescanProject: async () => ({ ok: true as const, changeCount: 0 }),
    });

    const result = await interruption.interrupt(taskId);
    expect(result).toMatchObject({
      status: 'cleanup_failed',
      cleanupComplete: false,
      exitAllowed: false,
    });
    expect(result.reason).toMatch(/intent|action|complete|cleanup/i);
    expect(
      new TaskRepository(fixture.database.connection).get(taskId)!.status,
    ).not.toBe('interrupted_needs_inspection');
    expect(interruption.canExitTui(taskId).allowed).toBe(false);
  });
});
