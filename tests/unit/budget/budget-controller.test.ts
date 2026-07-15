import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BudgetController } from '../../../src/budget/budget-controller.js';
import { BudgetClock } from '../../../src/budget/budget-clock.js';
import { asAttemptId, asTaskId } from '../../../src/domain/ids.js';
import {
  createPersistenceRepositories,
  openDatabase,
  type OpenedDatabase,
  type ReadWriteDatabase,
} from '../../../src/persistence/database.js';
import { createInitialWorkflow } from '../../../src/workflow/workflow-engine.js';
import {
  FakeClock,
  FakeProcessSupervisor,
} from '../../fakes/fake-process-supervisor.js';

const temporaryDirectories: string[] = [];
const openedDatabases: OpenedDatabase[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'triagent-budget-unit-'));
  temporaryDirectories.push(directory);
  return directory;
}

function requireReadWrite(opened: OpenedDatabase): ReadWriteDatabase {
  expect(opened.mode).toBe('read-write');
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  return opened;
}

function openBudgetDatabase(): ReadWriteDatabase {
  const opened = openDatabase(join(temporaryDirectory(), 'triagent.sqlite'));
  openedDatabases.push(opened);
  return requireReadWrite(opened);
}

function seedTask(database: ReadWriteDatabase, taskIdValue = 'task-budget'): ReturnType<typeof asTaskId> {
  const taskId = asTaskId(taskIdValue);
  const repositories = createPersistenceRepositories(database);
  repositories.tasks.createProject({
    projectId: `project-${taskIdValue}`,
    rootPath: `D:\\${taskIdValue}`,
  });
  repositories.tasks.create({
    taskId,
    projectId: `project-${taskIdValue}`,
    workflowSnapshot: createInitialWorkflow(taskId),
    workflowVersion: 1,
    status: 'draft',
  });
  return taskId;
}

function createController(options: {
  readonly database: ReadWriteDatabase;
  readonly clock: FakeClock;
  readonly supervisor: FakeProcessSupervisor;
  readonly taskId: ReturnType<typeof asTaskId>;
  readonly totalActiveRuntimeMs?: number;
  readonly perAttemptTimeoutMs?: number;
  readonly maxExternalCalls?: number;
  readonly graceMs?: number;
}): BudgetController {
  return new BudgetController({
    database: options.database.connection,
    clock: new BudgetClock(options.clock),
    supervisor: options.supervisor,
    taskId: options.taskId,
    limits: {
      totalActiveRuntimeMs: options.totalActiveRuntimeMs ?? 60_000,
      perAttemptTimeoutMs: options.perAttemptTimeoutMs ?? 30_000,
      maxExternalCalls: options.maxExternalCalls ?? 10,
    },
    graceMs: options.graceMs ?? 5,
  });
}

/** Supervisor cleanup order, ignoring observation subscribe fan-out. */
function supervisorCleanupCalls(supervisor: FakeProcessSupervisor): string[] {
  return supervisor.calls
    .map((call) => call.type)
    .filter((type) => type !== 'subscribe');
}

afterEach(() => {
  for (const opened of openedDatabases.splice(0).reverse()) {
    opened.close();
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('BudgetController', () => {
  it('tracks total active runtime across closed and open intervals', async () => {
    const database = openBudgetDatabase();
    const taskId = seedTask(database);
    const clock = new FakeClock('2026-07-12T00:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const budget = createController({
      database,
      clock,
      supervisor,
      taskId,
      totalActiveRuntimeMs: 10_000,
    });

    const attemptA = asAttemptId('attempt-a');
    const attemptB = asAttemptId('attempt-b');
    budget.beginActiveInterval(attemptA);
    clock.advanceBy(1_000);
    budget.endActiveInterval(attemptA);
    budget.beginActiveInterval(attemptB);
    clock.advanceBy(500);

    expect(budget.getActiveRuntimeMs()).toBe(1_500);
  });

  it('excludes paused_after_run and awaiting_user wall time from active runtime', () => {
    const database = openBudgetDatabase();
    const taskId = seedTask(database);
    const clock = new FakeClock('2026-07-12T00:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const budget = createController({
      database,
      clock,
      supervisor,
      taskId,
      totalActiveRuntimeMs: 60_000,
    });

    const attemptId = asAttemptId('attempt-pause');
    budget.beginActiveInterval(attemptId);
    clock.advanceBy(2_000);
    budget.enterNonBillableState('paused_after_run');
    clock.advanceBy(30_000);
    budget.exitNonBillableState();
    budget.beginActiveInterval(attemptId);
    clock.advanceBy(1_000);
    budget.enterNonBillableState('awaiting_user');
    clock.advanceBy(45_000);
    budget.exitNonBillableState();
    budget.beginActiveInterval(attemptId);
    clock.advanceBy(500);

    expect(budget.getActiveRuntimeMs()).toBe(3_500);
  });

  it('reserves external calls before launch and releases only when launch never occurred', () => {
    const database = openBudgetDatabase();
    const taskId = seedTask(database);
    const clock = new FakeClock('2026-07-12T00:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const budget = createController({
      database,
      clock,
      supervisor,
      taskId,
      maxExternalCalls: 2,
    });

    const first = budget.reserveCall({
      attemptId: asAttemptId('attempt-1'),
      idempotencyKey: `${taskId}:call:1`,
    });
    expect(budget.getConsumedOrReservedCalls()).toBe(1);
    budget.releaseReservation(first.reservationId);
    expect(budget.getConsumedOrReservedCalls()).toBe(0);

    const second = budget.reserveCall({
      attemptId: asAttemptId('attempt-2'),
      idempotencyKey: `${taskId}:call:2`,
    });
    budget.markLaunched(second.reservationId);
    expect(() => budget.releaseReservation(second.reservationId)).toThrow(
      /launch already occurred|already consumed/i,
    );
    expect(budget.getConsumedOrReservedCalls()).toBe(1);
  });

  it('counts a process start against the call budget even when the process later crashes', () => {
    const database = openBudgetDatabase();
    const taskId = seedTask(database);
    const clock = new FakeClock('2026-07-12T00:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const budget = createController({
      database,
      clock,
      supervisor,
      taskId,
      maxExternalCalls: 1,
    });

    const reservation = budget.reserveCall({
      attemptId: asAttemptId('attempt-crash'),
      idempotencyKey: `${taskId}:call:crash`,
    });
    budget.markLaunched(reservation.reservationId);
    budget.recordProcessCrash(reservation.reservationId, {
      exitCode: 1,
      reason: 'process crashed before structured result',
    });

    expect(budget.getConsumedOrReservedCalls()).toBe(1);
    expect(budget.canLaunch()).toBe(false);
    expect(() =>
      budget.reserveCall({
        attemptId: asAttemptId('attempt-next'),
        idempotencyKey: `${taskId}:call:next`,
      }),
    ).toThrow(/external call budget exhausted|budget exhausted/i);
  });

  it('never launches a new Adapter call after total or call budget exhaustion', () => {
    const database = openBudgetDatabase();
    const taskId = seedTask(database);
    const clock = new FakeClock('2026-07-12T00:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const budget = createController({
      database,
      clock,
      supervisor,
      taskId,
      maxExternalCalls: 1,
      totalActiveRuntimeMs: 1_000,
    });

    const reservation = budget.reserveCall({
      attemptId: asAttemptId('attempt-only'),
      idempotencyKey: `${taskId}:call:only`,
    });
    budget.markLaunched(reservation.reservationId);
    budget.beginActiveInterval(asAttemptId('attempt-only'));
    clock.advanceBy(1_000);
    budget.endActiveInterval(asAttemptId('attempt-only'));
    budget.markExhausted('total_runtime');

    expect(budget.isExhausted()).toBe(true);
    expect(budget.canLaunch()).toBe(false);
    expect(() =>
      budget.reserveCall({
        attemptId: asAttemptId('attempt-denied'),
        idempotencyKey: `${taskId}:call:denied`,
      }),
    ).toThrow(/budget exhausted/i);
  });

  it('on per-attempt timeout persists stop intent before graceful stop then force tree cleanup', async () => {
    const database = openBudgetDatabase();
    const taskId = seedTask(database);
    const clock = new FakeClock('2026-07-12T00:00:00.000Z');
    const attemptId = asAttemptId('attempt-timeout');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 7101,
      timeline: [
        { afterMs: 0, event: { type: 'started', pid: 7101 } },
      ],
      gracefulStop: { afterMs: 2, outcome: 'failed', error: 'still running' },
      forceStop: { afterMs: 3, outcome: 'succeeded' },
    }]);
    const budget = createController({
      database,
      clock,
      supervisor,
      taskId,
      perAttemptTimeoutMs: 10,
      graceMs: 2,
    });

    const reservation = budget.reserveCall({
      attemptId,
      idempotencyKey: `${taskId}:call:timeout`,
    });
    budget.markLaunched(reservation.reservationId);
    await supervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    budget.beginActiveInterval(attemptId);
    budget.armAttemptWatch(attemptId);

    const actionBeforeTimeout = database.connection
      .prepare(
        `SELECT COUNT(*) AS count FROM pending_actions
         WHERE action_type = 'budget-stop' AND status = 'intent'`,
      )
      .get() as { readonly count: number };
    expect(actionBeforeTimeout.count).toBe(0);

    clock.advanceBy(10);

    const stopIntent = database.connection
      .prepare(
        `SELECT id, status, payload_json FROM pending_actions
         WHERE action_type = 'budget-stop' ORDER BY created_at, id LIMIT 1`,
      )
      .get() as {
        readonly id: string;
        readonly status: string;
        readonly payload_json: string;
      } | undefined;
    expect(stopIntent).toBeDefined();
    expect(stopIntent!.status).toBe('intent');
    const payload = JSON.parse(stopIntent!.payload_json) as {
      readonly attemptId: string;
      readonly reason: string;
      readonly stage: string;
    };
    expect(payload.attemptId).toBe(attemptId);
    expect(payload.reason).toBe('per_attempt_timeout');
    expect(payload.stage).toBe('stop_requested');

    const callsAfterGraceful = supervisorCleanupCalls(supervisor);
    expect(callsAfterGraceful).toEqual([
      'start',
      'request_graceful_stop',
    ]);

    clock.advanceBy(2);
    expect(supervisorCleanupCalls(supervisor)).toEqual([
      'start',
      'request_graceful_stop',
      'force_stop_tree',
    ]);

    clock.advanceBy(3);
    const completed = database.connection
      .prepare(
        `SELECT status, result_json FROM pending_actions WHERE id = ?`,
      )
      .get(stopIntent!.id) as {
        readonly status: string;
        readonly result_json: string | null;
      };
    expect(completed.status).toBe('completed');
    expect(JSON.parse(completed.result_json ?? '{}')).toMatchObject({
      attemptId,
      reason: 'per_attempt_timeout',
      forceStopIssued: true,
    });
    expect(budget.isExhausted()).toBe(true);
    expect(budget.canLaunch()).toBe(false);
  });

  it('on total-budget exhaustion during a run persists stop intent before cleanup and blocks further launches', async () => {
    const database = openBudgetDatabase();
    const taskId = seedTask(database);
    const clock = new FakeClock('2026-07-12T00:00:00.000Z');
    const attemptId = asAttemptId('attempt-total');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 7201,
      timeline: [{ afterMs: 0, event: { type: 'started', pid: 7201 } }],
      gracefulStop: { afterMs: 1, outcome: 'succeeded', exitCode: null },
      forceStop: { afterMs: 1, outcome: 'succeeded' },
    }]);
    const budget = createController({
      database,
      clock,
      supervisor,
      taskId,
      totalActiveRuntimeMs: 20,
      perAttemptTimeoutMs: 60_000,
      graceMs: 1,
    });

    const reservation = budget.reserveCall({
      attemptId,
      idempotencyKey: `${taskId}:call:total`,
    });
    budget.markLaunched(reservation.reservationId);
    await supervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    budget.beginActiveInterval(attemptId);
    budget.armAttemptWatch(attemptId);

    clock.advanceBy(20);

    const stopIntent = database.connection
      .prepare(
        `SELECT status, payload_json FROM pending_actions
         WHERE action_type = 'budget-stop' ORDER BY created_at, id LIMIT 1`,
      )
      .get() as {
        readonly status: string;
        readonly payload_json: string;
      };
    expect(stopIntent.status).toBe('intent');
    expect(JSON.parse(stopIntent.payload_json)).toMatchObject({
      attemptId,
      reason: 'total_runtime',
    });
    expect(supervisorCleanupCalls(supervisor)).toEqual([
      'start',
      'request_graceful_stop',
    ]);

    clock.advanceBy(2);
    expect(supervisorCleanupCalls(supervisor)).toContain('force_stop_tree');
    expect(budget.isExhausted()).toBe(true);
    expect(() =>
      budget.reserveCall({
        attemptId: asAttemptId('attempt-after-total'),
        idempotencyKey: `${taskId}:call:after-total`,
      }),
    ).toThrow(/budget exhausted/i);
  });

  it('is idempotent for reserve with the same idempotency key and fails closed on conflicting payload', () => {
    const database = openBudgetDatabase();
    const taskId = seedTask(database);
    const clock = new FakeClock('2026-07-12T00:00:00.000Z');
    const supervisor = new FakeProcessSupervisor(clock, []);
    const budget = createController({
      database,
      clock,
      supervisor,
      taskId,
      maxExternalCalls: 3,
    });

    const key = `${taskId}:call:idem`;
    const first = budget.reserveCall({
      attemptId: asAttemptId('attempt-idem'),
      idempotencyKey: key,
      guardDecisionId: 'guard-decision-1',
    });
    const second = budget.reserveCall({
      attemptId: asAttemptId('attempt-idem'),
      idempotencyKey: key,
      guardDecisionId: 'guard-decision-1',
    });
    expect(second.reservationId).toBe(first.reservationId);
    expect(budget.getConsumedOrReservedCalls()).toBe(1);

    expect(() =>
      budget.reserveCall({
        attemptId: asAttemptId('attempt-other'),
        idempotencyKey: key,
        guardDecisionId: 'guard-decision-2',
      }),
    ).toThrow(/idempotency|conflict|ambiguous/i);
  });

  it('rearms per-attempt and total watches after pause/awaiting so only remaining ACTIVE time triggers cleanup', async () => {
    const database = openBudgetDatabase();
    const taskId = seedTask(database, 'task-budget-rearm');
    const clock = new FakeClock('2026-07-12T00:00:00.000Z');
    const attemptId = asAttemptId('attempt-rearm');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 7401,
      timeline: [{ afterMs: 0, event: { type: 'started', pid: 7401 } }],
      gracefulStop: { afterMs: 1, outcome: 'succeeded' },
      forceStop: { afterMs: 1, outcome: 'succeeded' },
    }]);
    const budget = createController({
      database,
      clock,
      supervisor,
      taskId,
      // per-attempt 20ms active; total 50ms active
      perAttemptTimeoutMs: 20,
      totalActiveRuntimeMs: 50,
      graceMs: 1,
    });

    const reservation = budget.reserveCall({
      attemptId,
      idempotencyKey: `${taskId}:call:rearm`,
    });
    budget.markLaunched(reservation.reservationId);
    await supervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    budget.beginActiveInterval(attemptId);
    budget.armAttemptWatch(attemptId);

    // Consume 8ms of active budget, then pause far past both wall-clock deadlines.
    clock.advanceBy(8);
    expect(budget.getActiveRuntimeMs()).toBe(8);
    budget.enterNonBillableState('paused_after_run');
    clock.advanceBy(100);
    expect(budget.getActiveRuntimeMs()).toBe(8);
    expect(budget.isExhausted()).toBe(false);
    expect(supervisorCleanupCalls(supervisor)).toEqual(['start']);

    // Resume: remaining per-attempt active budget is 12ms.
    budget.exitNonBillableState();
    budget.beginActiveInterval(attemptId);
    budget.armAttemptWatch(attemptId);

    clock.advanceBy(11);
    expect(budget.getActiveRuntimeMs()).toBe(19);
    expect(budget.isExhausted()).toBe(false);
    expect(supervisorCleanupCalls(supervisor)).toEqual(['start']);

    clock.advanceBy(1);
    expect(budget.getActiveRuntimeMs()).toBe(20);
    expect(budget.isExhausted()).toBe(true);
    const stopIntent = database.connection
      .prepare(
        `SELECT status, payload_json FROM pending_actions
         WHERE action_type = 'budget-stop' ORDER BY created_at, id LIMIT 1`,
      )
      .get() as {
        readonly status: string;
        readonly payload_json: string;
      };
    expect(stopIntent.status).toBe('intent');
    expect(JSON.parse(stopIntent.payload_json)).toMatchObject({
      attemptId,
      reason: 'per_attempt_timeout',
    });
    expect(supervisorCleanupCalls(supervisor)).toEqual([
      'start',
      'request_graceful_stop',
    ]);
  });

  it('rearms total-runtime watch after awaiting_user so remaining total ACTIVE budget triggers cleanup', async () => {
    const database = openBudgetDatabase();
    const taskId = seedTask(database, 'task-budget-total-rearm');
    const clock = new FakeClock('2026-07-12T01:00:00.000Z');
    const attemptId = asAttemptId('attempt-total-rearm');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 7402,
      timeline: [{ afterMs: 0, event: { type: 'started', pid: 7402 } }],
      gracefulStop: { afterMs: 1, outcome: 'succeeded' },
      forceStop: { afterMs: 1, outcome: 'succeeded' },
    }]);
    const budget = createController({
      database,
      clock,
      supervisor,
      taskId,
      totalActiveRuntimeMs: 30,
      perAttemptTimeoutMs: 60_000,
      graceMs: 1,
    });

    const reservation = budget.reserveCall({
      attemptId,
      idempotencyKey: `${taskId}:call:total-rearm`,
    });
    budget.markLaunched(reservation.reservationId);
    await supervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    budget.beginActiveInterval(attemptId);
    budget.armAttemptWatch(attemptId);

    clock.advanceBy(10);
    budget.enterNonBillableState('awaiting_user');
    clock.advanceBy(200);
    expect(budget.getActiveRuntimeMs()).toBe(10);
    expect(budget.isExhausted()).toBe(false);

    budget.exitNonBillableState();
    budget.beginActiveInterval(attemptId);
    budget.armAttemptWatch(attemptId);

    clock.advanceBy(19);
    expect(budget.getActiveRuntimeMs()).toBe(29);
    expect(budget.isExhausted()).toBe(false);

    clock.advanceBy(1);
    expect(budget.getActiveRuntimeMs()).toBe(30);
    expect(budget.isExhausted()).toBe(true);
    const payload = database.connection
      .prepare(
        `SELECT payload_json FROM pending_actions
         WHERE action_type = 'budget-stop' ORDER BY created_at, id LIMIT 1`,
      )
      .get() as { readonly payload_json: string };
    expect(JSON.parse(payload.payload_json)).toMatchObject({
      attemptId,
      reason: 'total_runtime',
    });
    expect(supervisorCleanupCalls(supervisor)).toContain(
      'request_graceful_stop',
    );
  });

  it('does not mark budget-stop completed when forceStopTree cleanup fails; keeps accounting active for recovery', async () => {
    const database = openBudgetDatabase();
    const taskId = seedTask(database, 'task-budget-force-fail');
    const clock = new FakeClock('2026-07-12T02:00:00.000Z');
    const attemptId = asAttemptId('attempt-force-fail');
    const supervisor = new FakeProcessSupervisor(clock, [{
      pid: 7501,
      timeline: [{ afterMs: 0, event: { type: 'started', pid: 7501 } }],
      gracefulStop: { afterMs: 1, outcome: 'failed', error: 'graceful refused' },
      forceStop: { afterMs: 2, outcome: 'failed', error: 'job still occupied' },
    }]);
    const budget = createController({
      database,
      clock,
      supervisor,
      taskId,
      perAttemptTimeoutMs: 10,
      graceMs: 2,
    });

    const reservation = budget.reserveCall({
      attemptId,
      idempotencyKey: `${taskId}:call:force-fail`,
    });
    budget.markLaunched(reservation.reservationId);
    await supervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    budget.beginActiveInterval(attemptId);
    budget.armAttemptWatch(attemptId);

    clock.advanceBy(10);
    const stopIntent = database.connection
      .prepare(
        `SELECT id, status FROM pending_actions
         WHERE action_type = 'budget-stop' ORDER BY created_at, id LIMIT 1`,
      )
      .get() as { readonly id: string; readonly status: string };
    expect(stopIntent.status).toBe('intent');
    expect(supervisorCleanupCalls(supervisor)).toEqual([
      'start',
      'request_graceful_stop',
    ]);

    // Grace expires -> forceStopTree issued, but force cleanup has not finished.
    clock.advanceBy(2);
    expect(supervisorCleanupCalls(supervisor)).toEqual([
      'start',
      'request_graceful_stop',
      'force_stop_tree',
    ]);
    const mid = database.connection
      .prepare('SELECT status FROM pending_actions WHERE id = ?')
      .get(stopIntent.id) as { readonly status: string };
    expect(mid.status).toBe('intent');

    // Force cleanup fails: must NOT claim completed, must keep interval active.
    clock.advanceBy(2);
    const afterFailure = database.connection
      .prepare(
        `SELECT status, result_json, error_text FROM pending_actions WHERE id = ?`,
      )
      .get(stopIntent.id) as {
        readonly status: string;
        readonly result_json: string | null;
        readonly error_text: string | null;
      };
    expect(afterFailure.status).not.toBe('completed');
    expect(
      afterFailure.status === 'failed' || afterFailure.status === 'intent',
    ).toBe(true);
    expect(
      `${afterFailure.error_text ?? ''} ${afterFailure.result_json ?? ''}`,
    ).toMatch(/job still occupied|cleanup|force/i);

    const openIntervals = database.connection
      .prepare(
        `SELECT COUNT(*) AS count FROM budget_active_intervals
         WHERE task_id = ? AND ended_at IS NULL`,
      )
      .get(taskId) as { readonly count: number };
    expect(openIntervals.count).toBe(1);
    expect(budget.getActiveRuntimeMs()).toBeGreaterThanOrEqual(10);
    expect(budget.canLaunch()).toBe(false);
  });
});
