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
  const directory = mkdtempSync(join(tmpdir(), 'triagent-budget-recovery-'));
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

function openBudgetDatabase(path: string): ReadWriteDatabase {
  const opened = openDatabase(path);
  openedDatabases.push(opened);
  return requireReadWrite(opened);
}

function seedTask(database: ReadWriteDatabase, taskIdValue = 'task-budget-recovery'): ReturnType<typeof asTaskId> {
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

describe('Budget recovery and persistence', () => {
  it('continues active runtime and call consumption after restart from SQLite', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'triagent.sqlite');
    const firstDb = openBudgetDatabase(databasePath);
    const taskId = seedTask(firstDb);
    const firstClock = new FakeClock('2026-07-12T10:00:00.000Z');
    const firstSupervisor = new FakeProcessSupervisor(firstClock, []);
    const first = new BudgetController({
      database: firstDb.connection,
      clock: new BudgetClock(firstClock),
      supervisor: firstSupervisor,
      taskId,
      limits: {
        totalActiveRuntimeMs: 60_000,
        perAttemptTimeoutMs: 30_000,
        maxExternalCalls: 3,
      },
    });

    const attemptA = asAttemptId('attempt-recovery-a');
    const attemptB = asAttemptId('attempt-recovery-b');
    const reservationA = first.reserveCall({
      attemptId: attemptA,
      idempotencyKey: `${taskId}:call:a`,
    });
    first.markLaunched(reservationA.reservationId);
    first.beginActiveInterval(attemptA);
    firstClock.advanceBy(4_000);
    first.endActiveInterval(attemptA);

    const reservationB = first.reserveCall({
      attemptId: attemptB,
      idempotencyKey: `${taskId}:call:b`,
    });
    first.markLaunched(reservationB.reservationId);
    first.beginActiveInterval(attemptB);
    firstClock.advanceBy(1_500);
    // Crash window: open interval and consumed call remain durable without end.
    firstDb.close();
    openedDatabases.pop();

    const secondDb = openBudgetDatabase(databasePath);
    const secondClock = new FakeClock('2026-07-12T10:00:05.500Z');
    const secondSupervisor = new FakeProcessSupervisor(secondClock, []);
    const second = new BudgetController({
      database: secondDb.connection,
      clock: new BudgetClock(secondClock),
      supervisor: secondSupervisor,
      taskId,
      limits: {
        totalActiveRuntimeMs: 60_000,
        perAttemptTimeoutMs: 30_000,
        maxExternalCalls: 3,
      },
    });

    const recovered = second.recover();
    expect(recovered.consumedOrReservedCalls).toBe(2);
    expect(recovered.activeRuntimeMs).toBe(5_500);
    expect(recovered.openIntervals).toEqual([
      expect.objectContaining({ attemptId: attemptB }),
    ]);
    expect(second.getActiveRuntimeMs()).toBe(5_500);
    expect(second.getConsumedOrReservedCalls()).toBe(2);

    secondClock.advanceBy(500);
    expect(second.getActiveRuntimeMs()).toBe(6_000);

    const reservationC = second.reserveCall({
      attemptId: asAttemptId('attempt-recovery-c'),
      idempotencyKey: `${taskId}:call:c`,
    });
    expect(reservationC.status).toBe('reserved');
    expect(second.getConsumedOrReservedCalls()).toBe(3);
    expect(second.canLaunch()).toBe(true);

    expect(() =>
      second.reserveCall({
        attemptId: asAttemptId('attempt-recovery-d'),
        idempotencyKey: `${taskId}:call:d`,
      }),
    ).toThrow(/external call budget exhausted|budget exhausted/i);
  });

  it('fails closed when an open interval restart state is ambiguous', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'triagent.sqlite');
    const firstDb = openBudgetDatabase(databasePath);
    const taskId = seedTask(firstDb);
    const firstClock = new FakeClock('2026-07-12T11:00:00.000Z');
    const first = new BudgetController({
      database: firstDb.connection,
      clock: new BudgetClock(firstClock),
      supervisor: new FakeProcessSupervisor(firstClock, []),
      taskId,
      limits: {
        totalActiveRuntimeMs: 60_000,
        perAttemptTimeoutMs: 30_000,
        maxExternalCalls: 5,
      },
    });

    const attemptId = asAttemptId('attempt-ambiguous');
    const reservation = first.reserveCall({
      attemptId,
      idempotencyKey: `${taskId}:call:ambiguous`,
    });
    // Reservation without launch + open interval is ambiguous on restart.
    first.beginActiveInterval(attemptId);
    firstDb.close();
    openedDatabases.pop();

    // Corrupt durable state: interval exists, but reservation never launched.
    const corrupt = openBudgetDatabase(databasePath);
    corrupt.connection
      .prepare(
        `UPDATE budget_call_reservations
         SET status = 'reserved', launched_at = NULL
         WHERE id = ?`,
      )
      .run(reservation.reservationId);
    corrupt.close();
    openedDatabases.pop();

    const secondDb = openBudgetDatabase(databasePath);
    const secondClock = new FakeClock('2026-07-12T11:00:10.000Z');
    const second = new BudgetController({
      database: secondDb.connection,
      clock: new BudgetClock(secondClock),
      supervisor: new FakeProcessSupervisor(secondClock, []),
      taskId,
      limits: {
        totalActiveRuntimeMs: 60_000,
        perAttemptTimeoutMs: 30_000,
        maxExternalCalls: 5,
      },
    });

    expect(() => second.recover()).toThrow(/ambiguous|fail closed|inspection/i);
    expect(second.canLaunch()).toBe(false);
    expect(() =>
      second.reserveCall({
        attemptId: asAttemptId('attempt-after-ambiguous'),
        idempotencyKey: `${taskId}:call:after-ambiguous`,
      }),
    ).toThrow(/ambiguous|exhausted|fail closed|inspection/i);
  });

  it('persists stop intent before supervisor cleanup across a restart boundary', async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'triagent.sqlite');
    const firstDb = openBudgetDatabase(databasePath);
    const taskId = seedTask(firstDb);
    const attemptId = asAttemptId('attempt-stop-restart');
    const firstClock = new FakeClock('2026-07-12T12:00:00.000Z');
    const firstSupervisor = new FakeProcessSupervisor(firstClock, [{
      pid: 7301,
      timeline: [{ afterMs: 0, event: { type: 'started', pid: 7301 } }],
      gracefulStop: { afterMs: 5, outcome: 'succeeded' },
      forceStop: { afterMs: 5, outcome: 'succeeded' },
    }]);
    const first = new BudgetController({
      database: firstDb.connection,
      clock: new BudgetClock(firstClock),
      supervisor: firstSupervisor,
      taskId,
      limits: {
        totalActiveRuntimeMs: 15,
        perAttemptTimeoutMs: 60_000,
        maxExternalCalls: 3,
      },
      graceMs: 5,
    });

    const reservation = first.reserveCall({
      attemptId,
      idempotencyKey: `${taskId}:call:stop-restart`,
    });
    first.markLaunched(reservation.reservationId);
    await firstSupervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    first.beginActiveInterval(attemptId);
    first.armAttemptWatch(attemptId);
    firstClock.advanceBy(15);

    const stopBeforeRestart = firstDb.connection
      .prepare(
        `SELECT id, status, payload_json FROM pending_actions
         WHERE action_type = 'budget-stop' ORDER BY created_at, id LIMIT 1`,
      )
      .get() as {
        readonly id: string;
        readonly status: string;
        readonly payload_json: string;
      };
    expect(stopBeforeRestart.status).toBe('intent');
    expect(JSON.parse(stopBeforeRestart.payload_json)).toMatchObject({
      attemptId,
      reason: 'total_runtime',
      stage: 'stop_requested',
    });
    expect(supervisorCleanupCalls(firstSupervisor)).toEqual([
      'start',
      'request_graceful_stop',
    ]);
    firstDb.close();
    openedDatabases.pop();

    const secondDb = openBudgetDatabase(databasePath);
    const secondClock = new FakeClock('2026-07-12T12:00:00.020Z');
    const secondSupervisor = new FakeProcessSupervisor(secondClock, [{
      pid: 7301,
      timeline: [],
      gracefulStop: { afterMs: 1, outcome: 'succeeded' },
      forceStop: { afterMs: 1, outcome: 'succeeded' },
    }]);
    // Re-attach a supervised process identity for the recovered stop path.
    await secondSupervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    const second = new BudgetController({
      database: secondDb.connection,
      clock: new BudgetClock(secondClock),
      supervisor: secondSupervisor,
      taskId,
      limits: {
        totalActiveRuntimeMs: 15,
        perAttemptTimeoutMs: 60_000,
        maxExternalCalls: 3,
      },
      graceMs: 1,
    });

    const recovery = second.recover();
    expect(recovery.exhausted).toBe(true);
    expect(recovery.pendingStop).toMatchObject({
      actionId: stopBeforeRestart.id,
      attemptId,
      reason: 'total_runtime',
    });
    await second.resumePendingStop();
    expect(supervisorCleanupCalls(secondSupervisor)).toEqual([
      'start',
      'request_graceful_stop',
    ]);
    secondClock.advanceBy(1);
    expect(supervisorCleanupCalls(secondSupervisor)).toEqual([
      'start',
      'request_graceful_stop',
      'force_stop_tree',
    ]);
    // Completion is durable only after verified force-stop cleanup, not on call.
    secondClock.advanceBy(1);
    const completed = secondDb.connection
      .prepare('SELECT status, result_json FROM pending_actions WHERE id = ?')
      .get(stopBeforeRestart.id) as {
        readonly status: string;
        readonly result_json: string | null;
      };
    expect(completed.status).toBe('completed');
    expect(JSON.parse(completed.result_json ?? '{}')).toMatchObject({
      attemptId,
      reason: 'total_runtime',
      forceStopIssued: true,
    });
    expect(second.canLaunch()).toBe(false);
  });
  it('creates budget persistence tables via append-only migration 005', () => {
    const database = openBudgetDatabase(join(temporaryDirectory(), 'triagent.sqlite'));
    const tables = database.connection
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all()
      .map((row) => String((row as { readonly name: string }).name));

    expect(tables).toEqual(expect.arrayContaining([
      'budget_active_intervals',
      'budget_call_reservations',
      'budget_task_state',
    ]));
    expect(
      database.connection.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
    ).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
    ]);
  });

  it('on restart rearms remaining active budget watches from persisted intervals without duplicate cleanup', async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'triagent.sqlite');
    const firstDb = openBudgetDatabase(databasePath);
    const taskId = seedTask(firstDb, 'task-budget-rearm-restart');
    const attemptId = asAttemptId('attempt-rearm-restart');
    const firstClock = new FakeClock('2026-07-12T13:00:00.000Z');
    const firstSupervisor = new FakeProcessSupervisor(firstClock, [{
      pid: 7601,
      timeline: [{ afterMs: 0, event: { type: 'started', pid: 7601 } }],
      gracefulStop: { afterMs: 1, outcome: 'succeeded' },
      forceStop: { afterMs: 1, outcome: 'succeeded' },
    }]);
    const first = new BudgetController({
      database: firstDb.connection,
      clock: new BudgetClock(firstClock),
      supervisor: firstSupervisor,
      taskId,
      limits: {
        totalActiveRuntimeMs: 40,
        perAttemptTimeoutMs: 25,
        maxExternalCalls: 3,
      },
      graceMs: 1,
    });

    const reservation = first.reserveCall({
      attemptId,
      idempotencyKey: `${taskId}:call:rearm-restart`,
    });
    first.markLaunched(reservation.reservationId);
    await firstSupervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    first.beginActiveInterval(attemptId);
    first.armAttemptWatch(attemptId);
    firstClock.advanceBy(10);
    expect(first.getActiveRuntimeMs()).toBe(10);
    firstDb.close();
    openedDatabases.pop();

    // Restart 5ms later with the open interval still active (15ms total active so far).
    const secondDb = openBudgetDatabase(databasePath);
    const secondClock = new FakeClock('2026-07-12T13:00:00.015Z');
    const secondSupervisor = new FakeProcessSupervisor(secondClock, [{
      pid: 7601,
      timeline: [],
      gracefulStop: { afterMs: 1, outcome: 'succeeded' },
      forceStop: { afterMs: 1, outcome: 'succeeded' },
    }]);
    await secondSupervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    const second = new BudgetController({
      database: secondDb.connection,
      clock: new BudgetClock(secondClock),
      supervisor: secondSupervisor,
      taskId,
      limits: {
        totalActiveRuntimeMs: 40,
        perAttemptTimeoutMs: 25,
        maxExternalCalls: 3,
      },
      graceMs: 1,
    });

    const recovery = second.recover();
    expect(recovery.openIntervals).toEqual([
      expect.objectContaining({ attemptId }),
    ]);
    expect(recovery.activeRuntimeMs).toBe(15);
    expect(recovery.exhausted).toBe(false);
    // Remaining per-attempt active budget is 10ms (25 - 15).
    second.armAttemptWatch(attemptId);

    secondClock.advanceBy(9);
    expect(second.getActiveRuntimeMs()).toBe(24);
    expect(second.isExhausted()).toBe(false);
    expect(supervisorCleanupCalls(secondSupervisor)).toEqual(['start']);

    secondClock.advanceBy(1);
    expect(second.getActiveRuntimeMs()).toBe(25);
    expect(second.isExhausted()).toBe(true);
    const stopRows = secondDb.connection
      .prepare(
        `SELECT COUNT(*) AS count FROM pending_actions
         WHERE action_type = 'budget-stop'`,
      )
      .get() as { readonly count: number };
    expect(stopRows.count).toBe(1);
    expect(supervisorCleanupCalls(secondSupervisor)).toEqual([
      'start',
      'request_graceful_stop',
    ]);

    // Rearming again must not schedule a second cleanup.
    second.armAttemptWatch(attemptId);
    secondClock.advanceBy(5);
    const stopRowsAfterRearm = secondDb.connection
      .prepare(
        `SELECT COUNT(*) AS count FROM pending_actions
         WHERE action_type = 'budget-stop'`,
      )
      .get() as { readonly count: number };
    expect(stopRowsAfterRearm.count).toBe(1);
  });

  it('enforces persisted limits after restart even when constructor supplies larger limits', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'triagent.sqlite');
    const firstDb = openBudgetDatabase(databasePath);
    const taskId = seedTask(firstDb, 'task-budget-limits');
    const firstClock = new FakeClock('2026-07-12T14:00:00.000Z');
    const first = new BudgetController({
      database: firstDb.connection,
      clock: new BudgetClock(firstClock),
      supervisor: new FakeProcessSupervisor(firstClock, []),
      taskId,
      limits: {
        totalActiveRuntimeMs: 10,
        perAttemptTimeoutMs: 10,
        maxExternalCalls: 1,
      },
    });

    const only = first.reserveCall({
      attemptId: asAttemptId('attempt-limit-1'),
      idempotencyKey: `${taskId}:call:limit-1`,
    });
    first.markLaunched(only.reservationId);
    first.beginActiveInterval(asAttemptId('attempt-limit-1'));
    firstClock.advanceBy(4);
    first.endActiveInterval(asAttemptId('attempt-limit-1'));
    firstDb.close();
    openedDatabases.pop();

    const secondDb = openBudgetDatabase(databasePath);
    const secondClock = new FakeClock('2026-07-12T14:00:00.010Z');
    // Constructor tries to enlarge every limit — must not take effect.
    const reopenWithLarger = (): BudgetController =>
      new BudgetController({
        database: secondDb.connection,
        clock: new BudgetClock(secondClock),
        supervisor: new FakeProcessSupervisor(secondClock, []),
        taskId,
        limits: {
          totalActiveRuntimeMs: 10_000,
          perAttemptTimeoutMs: 10_000,
          maxExternalCalls: 100,
        },
      });

    let second: BudgetController;
    try {
      second = reopenWithLarger();
    } catch (error) {
      // Fail-closed on mismatch is acceptable; re-open using the original limits.
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/limit|mismatch|persisted/i);
      second = new BudgetController({
        database: secondDb.connection,
        clock: new BudgetClock(secondClock),
        supervisor: new FakeProcessSupervisor(secondClock, []),
        taskId,
        limits: {
          totalActiveRuntimeMs: 10,
          perAttemptTimeoutMs: 10,
          maxExternalCalls: 1,
        },
      });
    }

    // Whether mismatch throws or silently uses persisted limits, enforcement
    // must still honor the original maxExternalCalls=1 and total=10.
    expect(second.getConsumedOrReservedCalls()).toBe(1);
    expect(second.canLaunch()).toBe(false);
    expect(() =>
      second.reserveCall({
        attemptId: asAttemptId('attempt-limit-2'),
        idempotencyKey: `${taskId}:call:limit-2`,
      }),
    ).toThrow(/external call budget exhausted|budget exhausted|limit|mismatch|fail closed/i);

    second.beginActiveInterval(asAttemptId('attempt-limit-1'));
    secondClock.advanceBy(6);
    expect(second.getActiveRuntimeMs()).toBe(10);
    second.endActiveInterval(asAttemptId('attempt-limit-1'));
    expect(second.isExhausted() || !second.canLaunch()).toBe(true);
    expect(() =>
      second.reserveCall({
        attemptId: asAttemptId('attempt-limit-3'),
        idempotencyKey: `${taskId}:call:limit-3`,
      }),
    ).toThrow(/budget exhausted|limit|mismatch|fail closed|external call/i);
  });

  it('surfaces force-stop cleanup failure after restart so recovery can retry or require inspection', async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'triagent.sqlite');
    const firstDb = openBudgetDatabase(databasePath);
    const taskId = seedTask(firstDb, 'task-budget-force-fail-restart');
    const attemptId = asAttemptId('attempt-force-fail-restart');
    const firstClock = new FakeClock('2026-07-12T15:00:00.000Z');
    const firstSupervisor = new FakeProcessSupervisor(firstClock, [{
      pid: 7701,
      timeline: [{ afterMs: 0, event: { type: 'started', pid: 7701 } }],
      gracefulStop: { afterMs: 1, outcome: 'failed', error: 'still alive' },
      forceStop: { afterMs: 1, outcome: 'failed', error: 'tree not empty' },
    }]);
    const first = new BudgetController({
      database: firstDb.connection,
      clock: new BudgetClock(firstClock),
      supervisor: firstSupervisor,
      taskId,
      limits: {
        totalActiveRuntimeMs: 10,
        perAttemptTimeoutMs: 60_000,
        maxExternalCalls: 3,
      },
      graceMs: 1,
    });

    const reservation = first.reserveCall({
      attemptId,
      idempotencyKey: `${taskId}:call:force-fail-restart`,
    });
    first.markLaunched(reservation.reservationId);
    await firstSupervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    first.beginActiveInterval(attemptId);
    first.armAttemptWatch(attemptId);
    firstClock.advanceBy(10);
    firstClock.advanceBy(1); // grace -> force
    firstClock.advanceBy(1); // force cleanup fails
    const failedOrPending = firstDb.connection
      .prepare(
        `SELECT id, status FROM pending_actions
         WHERE action_type = 'budget-stop' ORDER BY created_at, id LIMIT 1`,
      )
      .get() as { readonly id: string; readonly status: string };
    expect(failedOrPending.status).not.toBe('completed');
    firstDb.close();
    openedDatabases.pop();

    const secondDb = openBudgetDatabase(databasePath);
    const secondClock = new FakeClock('2026-07-12T15:00:00.020Z');
    const secondSupervisor = new FakeProcessSupervisor(secondClock, [{
      pid: 7701,
      timeline: [],
      gracefulStop: { afterMs: 1, outcome: 'succeeded' },
      forceStop: { afterMs: 1, outcome: 'succeeded' },
    }]);
    await secondSupervisor.start({
      attemptId,
      executable: 'node.exe',
      args: [],
      cwd: 'D:\\project',
    });
    const second = new BudgetController({
      database: secondDb.connection,
      clock: new BudgetClock(secondClock),
      supervisor: secondSupervisor,
      taskId,
      limits: {
        totalActiveRuntimeMs: 10,
        perAttemptTimeoutMs: 60_000,
        maxExternalCalls: 3,
      },
      graceMs: 1,
    });

    const recovery = second.recover();
    expect(recovery.exhausted).toBe(true);
    expect(recovery.openIntervals.length).toBeGreaterThanOrEqual(1);
    // Recovery must expose unresolved stop so caller can retry/inspect.
    expect(
      recovery.pendingStop !== null
        || recovery.requiresInspection === true
        || recovery.cleanupUnresolved === true,
    ).toBe(true);

    if (recovery.pendingStop !== null) {
      await second.resumePendingStop();
      secondClock.advanceBy(2);
      const afterRetry = secondDb.connection
        .prepare(
          `SELECT status FROM pending_actions
           WHERE action_type = 'budget-stop'
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get() as { readonly status: string };
      // Successful retry may complete; unresolved must not claim success early.
      expect(['completed', 'intent', 'failed']).toContain(afterRetry.status);
    }
  });
});
