import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { AttemptId, TaskId } from '../domain/ids.js';
import {
  withTransaction,
  type AsyncCallbackGuard,
} from '../persistence/transaction.js';

export type BudgetExhaustionReason =
  | 'total_runtime'
  | 'per_attempt_timeout'
  | 'external_call_count'
  | 'ambiguous_restart';

export type NonBillableState = 'paused_after_run' | 'awaiting_user';

export type CallReservationStatus =
  | 'reserved'
  | 'launched'
  | 'released'
  | 'consumed';

export interface BudgetLimits {
  readonly totalActiveRuntimeMs: number;
  readonly perAttemptTimeoutMs: number;
  readonly maxExternalCalls: number;
}

export interface BudgetTaskState {
  readonly taskId: TaskId;
  readonly totalActiveRuntimeMs: number;
  readonly limits: BudgetLimits;
  readonly exhaustedReason: BudgetExhaustionReason | null;
  readonly nonBillableState: NonBillableState | null;
  readonly nonBillableEnteredAt: string | null;
  readonly failClosed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BudgetActiveInterval {
  readonly id: string;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
}

export interface BudgetCallReservation {
  readonly reservationId: string;
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly idempotencyKey: string;
  readonly guardDecisionId: string | null;
  readonly status: CallReservationStatus;
  readonly reservedAt: string;
  readonly launchedAt: string | null;
  readonly releasedAt: string | null;
  readonly consumedAt: string | null;
  readonly crashReason: string | null;
}

interface TaskStateRow {
  readonly task_id: string;
  readonly total_active_runtime_ms: number;
  readonly total_active_runtime_limit_ms: number;
  readonly per_attempt_timeout_ms: number;
  readonly max_external_calls: number;
  readonly exhausted_reason: string | null;
  readonly non_billable_state: string | null;
  readonly non_billable_entered_at: string | null;
  readonly fail_closed: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface IntervalRow {
  readonly id: string;
  readonly task_id: string;
  readonly attempt_id: string;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly duration_ms: number | null;
}

interface ReservationRow {
  readonly id: string;
  readonly task_id: string;
  readonly attempt_id: string;
  readonly idempotency_key: string;
  readonly guard_decision_id: string | null;
  readonly status: string;
  readonly reserved_at: string;
  readonly launched_at: string | null;
  readonly released_at: string | null;
  readonly consumed_at: string | null;
  readonly crash_reason: string | null;
}

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(`${field} must be non-empty`);
  }
  return trimmed;
}

function positiveLimit(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function taskStateFromRow(row: TaskStateRow): BudgetTaskState {
  return {
    taskId: row.task_id as TaskId,
    totalActiveRuntimeMs: row.total_active_runtime_ms,
    limits: {
      totalActiveRuntimeMs: row.total_active_runtime_limit_ms,
      perAttemptTimeoutMs: row.per_attempt_timeout_ms,
      maxExternalCalls: row.max_external_calls,
    },
    exhaustedReason: row.exhausted_reason as BudgetExhaustionReason | null,
    nonBillableState: row.non_billable_state as NonBillableState | null,
    nonBillableEnteredAt: row.non_billable_entered_at,
    failClosed: row.fail_closed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function intervalFromRow(row: IntervalRow): BudgetActiveInterval {
  return {
    id: row.id,
    taskId: row.task_id as TaskId,
    attemptId: row.attempt_id as AttemptId,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
  };
}

function reservationFromRow(row: ReservationRow): BudgetCallReservation {
  return {
    reservationId: row.id,
    taskId: row.task_id as TaskId,
    attemptId: row.attempt_id as AttemptId,
    idempotencyKey: row.idempotency_key,
    guardDecisionId: row.guard_decision_id,
    status: row.status as CallReservationStatus,
    reservedAt: row.reserved_at,
    launchedAt: row.launched_at,
    releasedAt: row.released_at,
    consumedAt: row.consumed_at,
    crashReason: row.crash_reason,
  };
}

export class BudgetRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public ensureTaskState(
    taskId: TaskId,
    limits: BudgetLimits,
    now: string,
  ): BudgetTaskState {
    positiveLimit(limits.totalActiveRuntimeMs, 'totalActiveRuntimeMs');
    positiveLimit(limits.perAttemptTimeoutMs, 'perAttemptTimeoutMs');
    positiveLimit(limits.maxExternalCalls, 'maxExternalCalls');

    const existing = this.getTaskState(taskId);
    if (existing !== undefined) {
      // Canonical limits are immutable for a task. Mismatch fails closed —
      // never silently enlarge, shrink, or drift enforcement.
      if (
        existing.limits.totalActiveRuntimeMs !== limits.totalActiveRuntimeMs
        || existing.limits.perAttemptTimeoutMs !== limits.perAttemptTimeoutMs
        || existing.limits.maxExternalCalls !== limits.maxExternalCalls
      ) {
        throw new Error(
          `persisted budget limits mismatch for task ${taskId}: `
            + `stored total=${existing.limits.totalActiveRuntimeMs}/`
            + `perAttempt=${existing.limits.perAttemptTimeoutMs}/`
            + `maxCalls=${existing.limits.maxExternalCalls} vs `
            + `supplied total=${limits.totalActiveRuntimeMs}/`
            + `perAttempt=${limits.perAttemptTimeoutMs}/`
            + `maxCalls=${limits.maxExternalCalls}`,
        );
      }
      return existing;
    }
    this.database
      .prepare(
        `INSERT INTO budget_task_state(
           task_id, total_active_runtime_ms,
           total_active_runtime_limit_ms, per_attempt_timeout_ms, max_external_calls,
           created_at, updated_at
         ) VALUES (?, 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        taskId,
        limits.totalActiveRuntimeMs,
        limits.perAttemptTimeoutMs,
        limits.maxExternalCalls,
        now,
        now,
      );
    return this.getTaskState(taskId)!;
  }

  public getTaskState(taskId: TaskId): BudgetTaskState | undefined {
    const row = this.database
      .prepare(
        `SELECT task_id, total_active_runtime_ms, total_active_runtime_limit_ms,
                per_attempt_timeout_ms, max_external_calls, exhausted_reason,
                non_billable_state, non_billable_entered_at, fail_closed,
                created_at, updated_at
         FROM budget_task_state WHERE task_id = ?`,
      )
      .get(taskId) as unknown as TaskStateRow | undefined;
    return row === undefined ? undefined : taskStateFromRow(row);
  }

  public setExhausted(
    taskId: TaskId,
    reason: BudgetExhaustionReason,
    now: string,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE budget_task_state
         SET exhausted_reason = COALESCE(exhausted_reason, ?),
             fail_closed = CASE WHEN ? = 'ambiguous_restart' THEN 1 ELSE fail_closed END,
             updated_at = ?
         WHERE task_id = ?`,
      )
      .run(reason, reason, now, taskId);
    if (result.changes !== 1) {
      throw new Error(`budget task state not found: ${taskId}`);
    }
  }

  public setFailClosed(taskId: TaskId, now: string): void {
    const result = this.database
      .prepare(
        `UPDATE budget_task_state
         SET fail_closed = 1,
             exhausted_reason = COALESCE(exhausted_reason, 'ambiguous_restart'),
             updated_at = ?
         WHERE task_id = ?`,
      )
      .run(now, taskId);
    if (result.changes !== 1) {
      throw new Error(`budget task state not found: ${taskId}`);
    }
  }

  public setNonBillableState(
    taskId: TaskId,
    state: NonBillableState | null,
    enteredAt: string | null,
    now: string,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE budget_task_state
         SET non_billable_state = ?,
             non_billable_entered_at = ?,
             updated_at = ?
         WHERE task_id = ?`,
      )
      .run(state, enteredAt, now, taskId);
    if (result.changes !== 1) {
      throw new Error(`budget task state not found: ${taskId}`);
    }
  }

  public beginInterval(
    taskId: TaskId,
    attemptId: AttemptId,
    startedAt: string,
  ): BudgetActiveInterval {
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO budget_active_intervals(
           id, task_id, attempt_id, started_at, ended_at, duration_ms
         ) VALUES (?, ?, ?, ?, NULL, NULL)`,
      )
      .run(id, taskId, attemptId, startedAt);
    return {
      id,
      taskId,
      attemptId,
      startedAt,
      endedAt: null,
      durationMs: null,
    };
  }

  public endOpenInterval(
    taskId: TaskId,
    attemptId: AttemptId,
    endedAt: string,
    durationMs: number,
  ): BudgetActiveInterval | undefined {
    const open = this.database
      .prepare(
        `SELECT id, task_id, attempt_id, started_at, ended_at, duration_ms
         FROM budget_active_intervals
         WHERE task_id = ? AND attempt_id = ? AND ended_at IS NULL
         ORDER BY started_at DESC, id DESC
         LIMIT 1`,
      )
      .get(taskId, attemptId) as unknown as IntervalRow | undefined;
    if (open === undefined) {
      return undefined;
    }
    this.database
      .prepare(
        `UPDATE budget_active_intervals
         SET ended_at = ?, duration_ms = ?
         WHERE id = ? AND ended_at IS NULL`,
      )
      .run(endedAt, durationMs, open.id);
    this.database
      .prepare(
        `UPDATE budget_task_state
         SET total_active_runtime_ms = total_active_runtime_ms + ?,
             updated_at = ?
         WHERE task_id = ?`,
      )
      .run(durationMs, endedAt, taskId);
    return {
      id: open.id,
      taskId,
      attemptId,
      startedAt: open.started_at,
      endedAt,
      durationMs,
    };
  }

  public listIntervals(taskId: TaskId): readonly BudgetActiveInterval[] {
    const rows = this.database
      .prepare(
        `SELECT id, task_id, attempt_id, started_at, ended_at, duration_ms
         FROM budget_active_intervals
         WHERE task_id = ?
         ORDER BY started_at, id`,
      )
      .all(taskId) as unknown as IntervalRow[];
    return rows.map(intervalFromRow);
  }

  public listOpenIntervals(taskId: TaskId): readonly BudgetActiveInterval[] {
    const rows = this.database
      .prepare(
        `SELECT id, task_id, attempt_id, started_at, ended_at, duration_ms
         FROM budget_active_intervals
         WHERE task_id = ? AND ended_at IS NULL
         ORDER BY started_at, id`,
      )
      .all(taskId) as unknown as IntervalRow[];
    return rows.map(intervalFromRow);
  }

  public closedRuntimeMs(taskId: TaskId): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(SUM(duration_ms), 0) AS total
         FROM budget_active_intervals
         WHERE task_id = ? AND duration_ms IS NOT NULL`,
      )
      .get(taskId) as { readonly total: number };
    return Number(row.total);
  }

  public findReservationByIdempotency(
    taskId: TaskId,
    idempotencyKey: string,
  ): BudgetCallReservation | undefined {
    const row = this.database
      .prepare(
        `SELECT id, task_id, attempt_id, idempotency_key, guard_decision_id,
                status, reserved_at, launched_at, released_at, consumed_at, crash_reason
         FROM budget_call_reservations
         WHERE task_id = ? AND idempotency_key = ?`,
      )
      .get(taskId, idempotencyKey) as unknown as ReservationRow | undefined;
    return row === undefined ? undefined : reservationFromRow(row);
  }

  public getReservation(reservationId: string): BudgetCallReservation | undefined {
    const row = this.database
      .prepare(
        `SELECT id, task_id, attempt_id, idempotency_key, guard_decision_id,
                status, reserved_at, launched_at, released_at, consumed_at, crash_reason
         FROM budget_call_reservations
         WHERE id = ?`,
      )
      .get(reservationId) as unknown as ReservationRow | undefined;
    return row === undefined ? undefined : reservationFromRow(row);
  }

  public insertReservation(input: {
    readonly taskId: TaskId;
    readonly attemptId: AttemptId;
    readonly idempotencyKey: string;
    readonly guardDecisionId?: string;
    readonly reservedAt: string;
  }): BudgetCallReservation {
    const id = randomUUID();
    this.database
      .prepare(
        `INSERT INTO budget_call_reservations(
           id, task_id, attempt_id, idempotency_key, guard_decision_id,
           status, reserved_at, launched_at, released_at, consumed_at, crash_reason
         ) VALUES (?, ?, ?, ?, ?, 'reserved', ?, NULL, NULL, NULL, NULL)`,
      )
      .run(
        id,
        input.taskId,
        input.attemptId,
        nonEmpty(input.idempotencyKey, 'idempotency key'),
        input.guardDecisionId ?? null,
        input.reservedAt,
      );
    return this.getReservation(id)!;
  }

  public markLaunched(reservationId: string, launchedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE budget_call_reservations
         SET status = 'launched', launched_at = ?
         WHERE id = ? AND status = 'reserved'`,
      )
      .run(launchedAt, reservationId);
    if (result.changes !== 1) {
      throw new Error(`budget reservation cannot be launched: ${reservationId}`);
    }
  }

  public releaseReservation(reservationId: string, releasedAt: string): void {
    const result = this.database
      .prepare(
        `UPDATE budget_call_reservations
         SET status = 'released', released_at = ?
         WHERE id = ? AND status = 'reserved'`,
      )
      .run(releasedAt, reservationId);
    if (result.changes !== 1) {
      throw new Error(
        `budget reservation cannot be released after launch already occurred: ${reservationId}`,
      );
    }
  }

  public consumeReservation(
    reservationId: string,
    consumedAt: string,
    crashReason?: string,
  ): void {
    const result = this.database
      .prepare(
        `UPDATE budget_call_reservations
         SET status = 'consumed',
             consumed_at = ?,
             crash_reason = COALESCE(?, crash_reason)
         WHERE id = ? AND status IN ('launched', 'consumed')`,
      )
      .run(consumedAt, crashReason ?? null, reservationId);
    if (result.changes !== 1) {
      throw new Error(`budget reservation cannot be consumed: ${reservationId}`);
    }
  }

  public countActiveCalls(taskId: TaskId): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM budget_call_reservations
         WHERE task_id = ? AND status IN ('reserved', 'launched', 'consumed')`,
      )
      .get(taskId) as { readonly count: number };
    return Number(row.count);
  }

  public listReservations(taskId: TaskId): readonly BudgetCallReservation[] {
    const rows = this.database
      .prepare(
        `SELECT id, task_id, attempt_id, idempotency_key, guard_decision_id,
                status, reserved_at, launched_at, released_at, consumed_at, crash_reason
         FROM budget_call_reservations
         WHERE task_id = ?
         ORDER BY reserved_at, id`,
      )
      .all(taskId) as unknown as ReservationRow[];
    return rows.map(reservationFromRow);
  }

  public withTransaction<Result>(
    operation: () => Result,
    ...asyncGuard: AsyncCallbackGuard<Result>
  ): Result {
    return withTransaction(this.database, operation, ...asyncGuard);
  }
}
