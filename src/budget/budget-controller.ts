import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { AttemptId, TaskId } from '../domain/ids.js';
import { ActionRepository } from '../persistence/action-repository.js';
import { serializeJsonValue } from '../persistence/json-value.js';
import type {
  ProcessSupervisorEvent,
  ProcessSupervisorPort,
} from '../process/process-supervisor-port.js';
import { BudgetClock } from './budget-clock.js';
import {
  BudgetRepository,
  type BudgetExhaustionReason,
  type BudgetLimits,
  type NonBillableState,
} from './budget-repository.js';

export interface BudgetControllerOptions {
  readonly database: DatabaseSync;
  readonly clock: BudgetClock;
  readonly supervisor: ProcessSupervisorPort;
  readonly taskId: TaskId;
  readonly limits: BudgetLimits;
  readonly graceMs?: number;
}

export interface CallReservationResult {
  readonly reservationId: string;
  readonly attemptId: AttemptId;
  readonly status: 'reserved';
  readonly idempotencyKey: string;
}

export interface BudgetRecoverySnapshot {
  readonly activeRuntimeMs: number;
  readonly consumedOrReservedCalls: number;
  readonly openIntervals: readonly {
    readonly id: string;
    readonly attemptId: AttemptId;
    readonly startedAt: string;
  }[];
  readonly exhausted: boolean;
  readonly exhaustedReason: BudgetExhaustionReason | null;
  readonly failClosed: boolean;
  readonly pendingStop: {
    readonly actionId: string;
    readonly attemptId: AttemptId;
    readonly reason: BudgetExhaustionReason;
  } | null;
  /** True when a budget-stop failed or process tree may still be alive. */
  readonly cleanupUnresolved: boolean;
  /** True when operator inspection is required before further launches. */
  readonly requiresInspection: boolean;
}

type StopReason = Extract<
  BudgetExhaustionReason,
  'total_runtime' | 'per_attempt_timeout'
>;

interface PendingStopPayload {
  readonly schemaVersion: 1;
  readonly attemptId: AttemptId;
  readonly reason: StopReason;
  readonly stage: 'stop_requested' | 'force_requested' | 'completed' | 'cleanup_failed';
  readonly graceMs: number;
  readonly replayPolicy: 'never-auto-replay';
}

/**
 * Persisted runtime and external-call budget controller.
 *
 * Call accounting: reserve before launch; release only if launch never occurred;
 * process start consumes the call even if the process later crashes.
 *
 * Timeout cleanup order is durable and exact:
 * 1) persist budget-stop intent
 * 2) requestGracefulStop
 * 3) after grace, forceStopTree
 * 4) close interval / mark completed only after verified tree termination
 * Never starts a new Adapter call after exhaustion.
 *
 * Active-time watches exclude paused_after_run / awaiting_user wall time and
 * rearm from remaining active budget on resume/restart.
 */
export class BudgetController {
  readonly #database: DatabaseSync;
  readonly #clock: BudgetClock;
  readonly #supervisor: ProcessSupervisorPort;
  readonly #taskId: TaskId;
  readonly #limits: BudgetLimits;
  readonly #graceMs: number;
  readonly #repository: BudgetRepository;
  readonly #actions: ActionRepository;
  #failClosed = false;
  /** Generation token per attempt so stale one-shot timers no-op after rearm/cancel. */
  readonly #watchGeneration = new Map<string, number>();
  readonly #stopInFlight = new Set<string>();
  readonly #stopFinalized = new Set<string>();
  readonly #stopUnsubscribes = new Map<string, () => void>();

  public constructor(options: BudgetControllerOptions) {
    this.#database = options.database;
    this.#clock = options.clock;
    this.#supervisor = options.supervisor;
    this.#taskId = options.taskId;
    this.#graceMs = options.graceMs ?? 5_000;
    if (!Number.isSafeInteger(this.#graceMs) || this.#graceMs < 0) {
      throw new Error('graceMs must be a non-negative safe integer');
    }
    this.#repository = new BudgetRepository(options.database);
    this.#actions = new ActionRepository(options.database);
    // Canonical limits are those persisted for the task. Mismatch fails closed.
    const state = this.#repository.ensureTaskState(
      this.#taskId,
      options.limits,
      this.#clock.now(),
    );
    this.#limits = state.limits;
    this.#failClosed =
      state.failClosed || state.exhaustedReason === 'ambiguous_restart';
  }

  public getActiveRuntimeMs(): number {
    if (this.#failClosed) {
      // Still report durable closed+open accounting for diagnostics when possible.
    }
    const closed = this.#repository.closedRuntimeMs(this.#taskId);
    if (this.#isNonBillable()) {
      return closed;
    }
    let openMs = 0;
    const now = this.#clock.now();
    for (const interval of this.#repository.listOpenIntervals(this.#taskId)) {
      openMs += this.#clock.elapsedBetween(interval.startedAt, now);
    }
    return closed + openMs;
  }

  public getConsumedOrReservedCalls(): number {
    return this.#repository.countActiveCalls(this.#taskId);
  }

  public isExhausted(): boolean {
    if (this.#failClosed) return true;
    const state = this.#repository.getTaskState(this.#taskId);
    return state !== undefined && state.exhaustedReason !== null;
  }

  public canLaunch(): boolean {
    // Call-count saturation blocks new reservations, but an already-reserved
    // (not yet launched) call may still launch. Exhaustion / fail-closed block
    // every further launch path.
    if (this.#failClosed) return false;
    const state = this.#repository.getTaskState(this.#taskId);
    if (state === undefined) return false;
    if (
      state.exhaustedReason === 'total_runtime'
      || state.exhaustedReason === 'per_attempt_timeout'
      || state.exhaustedReason === 'external_call_count'
      || state.exhaustedReason === 'ambiguous_restart'
    ) {
      return false;
    }
    if (this.getActiveRuntimeMs() >= this.#limits.totalActiveRuntimeMs) {
      return false;
    }
    const activeCalls = this.getConsumedOrReservedCalls();
    if (activeCalls < this.#limits.maxExternalCalls) {
      return true;
    }
    const hasUnlaunchedReservation = this.#repository
      .listReservations(this.#taskId)
      .some((entry) => entry.status === 'reserved');
    return hasUnlaunchedReservation;
  }

  public beginActiveInterval(attemptId: AttemptId): void {
    this.#assertWritable();
    if (this.#isNonBillable()) {
      return;
    }
    const open = this.#repository
      .listOpenIntervals(this.#taskId)
      .find((interval) => interval.attemptId === attemptId);
    if (open !== undefined) {
      return;
    }
    this.#repository.beginInterval(this.#taskId, attemptId, this.#clock.now());
  }

  public endActiveInterval(attemptId: AttemptId): void {
    this.#assertWritable();
    const open = this.#repository
      .listOpenIntervals(this.#taskId)
      .find((interval) => interval.attemptId === attemptId);
    if (open === undefined) {
      return;
    }
    const endedAt = this.#clock.now();
    const durationMs = this.#clock.elapsedBetween(open.startedAt, endedAt);
    this.#repository.endOpenInterval(
      this.#taskId,
      attemptId,
      endedAt,
      durationMs,
    );
    if (this.getActiveRuntimeMs() >= this.#limits.totalActiveRuntimeMs) {
      this.markExhausted('total_runtime');
    }
  }

  public enterNonBillableState(state: NonBillableState): void {
    this.#assertWritable();
    const now = this.#clock.now();
    for (const interval of this.#repository.listOpenIntervals(this.#taskId)) {
      const durationMs = this.#clock.elapsedBetween(interval.startedAt, now);
      this.#repository.endOpenInterval(
        this.#taskId,
        interval.attemptId,
        now,
        durationMs,
      );
    }
    // Cancel armed wall-clock watches; only active time counts.
    this.#cancelAllWatches();
    this.#repository.setNonBillableState(this.#taskId, state, now, now);
  }

  public exitNonBillableState(): void {
    this.#assertWritable();
    const now = this.#clock.now();
    this.#repository.setNonBillableState(this.#taskId, null, null, now);
  }

  public reserveCall(input: {
    readonly attemptId: AttemptId;
    readonly idempotencyKey: string;
    readonly guardDecisionId?: string;
  }): CallReservationResult {
    if (this.#failClosed) {
      throw new Error(
        'budget is fail-closed due to ambiguous restart state; inspection required',
      );
    }
    if (this.isExhausted()) {
      throw new Error('budget exhausted: cannot reserve a new Adapter call');
    }

    return this.#repository.withTransaction(() => {
      const existing = this.#repository.findReservationByIdempotency(
        this.#taskId,
        input.idempotencyKey,
      );
      if (existing !== undefined) {
        if (
          existing.attemptId !== input.attemptId
          || (existing.guardDecisionId ?? undefined) !== input.guardDecisionId
        ) {
          throw new Error(
            `idempotency conflict for budget reservation: ${input.idempotencyKey}`,
          );
        }
        if (existing.status === 'released') {
          throw new Error(
            `idempotency key already released and cannot be reused: ${input.idempotencyKey}`,
          );
        }
        return {
          reservationId: existing.reservationId,
          attemptId: existing.attemptId,
          status: 'reserved' as const,
          idempotencyKey: existing.idempotencyKey,
        };
      }

      if (this.getConsumedOrReservedCalls() >= this.#limits.maxExternalCalls) {
        this.markExhausted('external_call_count');
        throw new Error('external call budget exhausted');
      }
      if (this.getActiveRuntimeMs() >= this.#limits.totalActiveRuntimeMs) {
        this.markExhausted('total_runtime');
        throw new Error('budget exhausted: total active runtime limit reached');
      }

      const reservation = this.#repository.insertReservation({
        taskId: this.#taskId,
        attemptId: input.attemptId,
        idempotencyKey: input.idempotencyKey,
        ...(input.guardDecisionId === undefined
          ? {}
          : { guardDecisionId: input.guardDecisionId }),
        reservedAt: this.#clock.now(),
      });
      return {
        reservationId: reservation.reservationId,
        attemptId: reservation.attemptId,
        status: 'reserved' as const,
        idempotencyKey: reservation.idempotencyKey,
      };
    });
  }

  public releaseReservation(reservationId: string): void {
    this.#assertWritable();
    const reservation = this.#repository.getReservation(reservationId);
    if (reservation === undefined) {
      throw new Error(`budget reservation not found: ${reservationId}`);
    }
    if (reservation.status === 'launched' || reservation.status === 'consumed') {
      throw new Error(
        `budget reservation cannot be released after launch already occurred: ${reservationId}`,
      );
    }
    if (reservation.status === 'released') {
      return;
    }
    this.#repository.releaseReservation(reservationId, this.#clock.now());
  }

  public markLaunched(reservationId: string): void {
    this.#assertWritable();
    const reservation = this.#repository.getReservation(reservationId);
    if (reservation === undefined) {
      throw new Error(`budget reservation not found: ${reservationId}`);
    }
    if (reservation.status === 'launched' || reservation.status === 'consumed') {
      return;
    }
    if (reservation.status !== 'reserved') {
      throw new Error(`budget reservation is not launchable: ${reservationId}`);
    }
    this.#repository.markLaunched(reservationId, this.#clock.now());
  }

  public recordProcessCrash(
    reservationId: string,
    details: { readonly exitCode: number | null; readonly reason: string },
  ): void {
    this.#assertWritable();
    const reservation = this.#repository.getReservation(reservationId);
    if (reservation === undefined) {
      throw new Error(`budget reservation not found: ${reservationId}`);
    }
    if (reservation.status === 'reserved') {
      this.#repository.markLaunched(reservationId, this.#clock.now());
    }
    if (reservation.status !== 'consumed') {
      this.#repository.consumeReservation(
        reservationId,
        this.#clock.now(),
        details.reason,
      );
    }
    if (this.getConsumedOrReservedCalls() >= this.#limits.maxExternalCalls) {
      this.markExhausted('external_call_count');
    }
  }

  public markExhausted(reason: BudgetExhaustionReason): void {
    this.#repository.setExhausted(this.#taskId, reason, this.#clock.now());
    if (reason === 'ambiguous_restart') {
      this.#failClosed = true;
    }
  }

  /**
   * Arm (or rearm) active-time watches for an attempt.
   * Schedules only the remaining ACTIVE budget; paused/awaiting wall time is excluded.
   * Safe to call after resume/restart; cancels any prior one-shot for the attempt.
   */
  public armAttemptWatch(attemptId: AttemptId): void {
    this.#assertWritable();
    if (this.#isNonBillable()) {
      return;
    }
    if (this.#stopInFlight.has(attemptId) || this.#stopFinalized.has(attemptId)) {
      return;
    }
    if (this.isExhausted()) {
      return;
    }

    const generation = (this.#watchGeneration.get(attemptId) ?? 0) + 1;
    this.#watchGeneration.set(attemptId, generation);

    const remainingAttempt = this.#remainingAttemptActiveMs(attemptId);
    const remainingTotal = this.#remainingTotalActiveMs();

    if (remainingAttempt <= 0) {
      this.#onPerAttemptTimeout(attemptId);
      return;
    }
    if (remainingTotal <= 0) {
      this.#onTotalRuntimeExhausted(attemptId);
      return;
    }

    this.#clock.schedule(remainingAttempt, () => {
      if (this.#watchGeneration.get(attemptId) !== generation) {
        return;
      }
      this.#onPerAttemptTimeout(attemptId);
    });

    this.#clock.schedule(remainingTotal, () => {
      if (this.#watchGeneration.get(attemptId) !== generation) {
        return;
      }
      this.#onTotalRuntimeExhausted(attemptId);
    });
  }

  public recover(): BudgetRecoverySnapshot {
    const state = this.#repository.getTaskState(this.#taskId);
    if (state === undefined) {
      throw new Error(`budget task state missing for recovery: ${this.#taskId}`);
    }

    const openIntervals = this.#repository.listOpenIntervals(this.#taskId);
    const reservations = this.#repository.listReservations(this.#taskId);

    for (const interval of openIntervals) {
      const matching = reservations.filter(
        (entry) => entry.attemptId === interval.attemptId,
      );
      const hasLaunchEvidence = matching.some(
        (entry) => entry.status === 'launched' || entry.status === 'consumed',
      );
      if (!hasLaunchEvidence) {
        this.#failClosed = true;
        this.#repository.setFailClosed(this.#taskId, this.#clock.now());
        throw new Error(
          `ambiguous budget restart state for attempt ${interval.attemptId}: open interval without launch evidence; fail closed`,
        );
      }
    }

    const activeRuntimeMs = this.getActiveRuntimeMs();
    const consumedOrReservedCalls = this.getConsumedOrReservedCalls();
    if (activeRuntimeMs >= this.#limits.totalActiveRuntimeMs) {
      this.markExhausted('total_runtime');
    }
    if (consumedOrReservedCalls >= this.#limits.maxExternalCalls) {
      this.markExhausted('external_call_count');
    }

    const pendingStop = this.#findPendingStop();
    const failedStop = this.#findFailedStop();
    const refreshed = this.#repository.getTaskState(this.#taskId)!;
    const exhausted =
      refreshed.exhaustedReason !== null || this.#failClosed;
    // Unresolved cleanup: failed stop, still-pending stop, or exhausted with an
    // open interval (process tree may still be alive — never claim completed).
    const cleanupUnresolved =
      failedStop !== null
      || pendingStop !== null
      || (exhausted && openIntervals.length > 0);
    const requiresInspection =
      this.#failClosed
      || failedStop !== null
      || (exhausted && openIntervals.length > 0 && pendingStop === null);

    return {
      activeRuntimeMs,
      consumedOrReservedCalls,
      openIntervals: openIntervals.map((interval) => ({
        id: interval.id,
        attemptId: interval.attemptId,
        startedAt: interval.startedAt,
      })),
      exhausted,
      exhaustedReason: refreshed.exhaustedReason,
      failClosed: this.#failClosed,
      pendingStop,
      cleanupUnresolved,
      requiresInspection,
    };
  }

  public async resumePendingStop(): Promise<void> {
    const pending = this.#findPendingStop();
    if (pending === null) {
      return;
    }
    // Clear in-flight so recovery can re-issue the durable stop sequence.
    this.#stopInFlight.delete(pending.attemptId);
    this.#stopFinalized.delete(pending.attemptId);
    this.#detachStopSubscription(pending.attemptId);
    // Re-issue durable stop sequence. Grace/force completion is driven by the
    // injected clock (tests) or real time (production ProcessHost binding).
    this.#issueStopSequence(
      pending.actionId,
      pending.attemptId,
      pending.reason as StopReason,
    );
  }

  #remainingAttemptActiveMs(attemptId: AttemptId): number {
    return Math.max(
      0,
      this.#limits.perAttemptTimeoutMs - this.#attemptActiveRuntimeMs(attemptId),
    );
  }

  #remainingTotalActiveMs(): number {
    return Math.max(
      0,
      this.#limits.totalActiveRuntimeMs - this.getActiveRuntimeMs(),
    );
  }

  #attemptActiveRuntimeMs(attemptId: AttemptId): number {
    let total = 0;
    const now = this.#clock.now();
    for (const interval of this.#repository.listIntervals(this.#taskId)) {
      if (interval.attemptId !== attemptId) {
        continue;
      }
      if (interval.durationMs !== null) {
        total += interval.durationMs;
      } else {
        total += this.#clock.elapsedBetween(interval.startedAt, now);
      }
    }
    return total;
  }

  #cancelAllWatches(): void {
    for (const attemptId of this.#watchGeneration.keys()) {
      const next = (this.#watchGeneration.get(attemptId) ?? 0) + 1;
      this.#watchGeneration.set(attemptId, next);
    }
  }

  #cancelWatch(attemptId: AttemptId): void {
    const next = (this.#watchGeneration.get(attemptId) ?? 0) + 1;
    this.#watchGeneration.set(attemptId, next);
  }

  #onPerAttemptTimeout(attemptId: AttemptId): void {
    if (this.#isNonBillable()) {
      return;
    }
    const openInterval = this.#repository
      .listOpenIntervals(this.#taskId)
      .find((interval) => interval.attemptId === attemptId);
    if (openInterval === undefined) {
      return;
    }
    const elapsed = this.#attemptActiveRuntimeMs(attemptId);
    if (elapsed < this.#limits.perAttemptTimeoutMs) {
      // Active time still remaining (e.g. stale timer); rearm remaining budget.
      this.armAttemptWatch(attemptId);
      return;
    }
    this.#beginStop(attemptId, 'per_attempt_timeout');
  }

  #onTotalRuntimeExhausted(attemptId: AttemptId): void {
    if (this.#isNonBillable()) {
      return;
    }
    if (this.getActiveRuntimeMs() < this.#limits.totalActiveRuntimeMs) {
      this.armAttemptWatch(attemptId);
      return;
    }
    this.#beginStop(attemptId, 'total_runtime');
  }

  #beginStop(attemptId: AttemptId, reason: StopReason): void {
    if (this.#stopInFlight.has(attemptId) || this.#failClosed) {
      return;
    }
    if (this.#stopFinalized.has(attemptId)) {
      return;
    }
    this.#stopInFlight.add(attemptId);
    this.#cancelWatch(attemptId);
    this.markExhausted(reason);

    const existing = this.#findPendingStopForAttempt(attemptId, reason);
    const actionId = existing?.actionId ?? randomUUID();
    if (existing === undefined) {
      const payload: PendingStopPayload = {
        schemaVersion: 1,
        attemptId,
        reason,
        stage: 'stop_requested',
        graceMs: this.#graceMs,
        replayPolicy: 'never-auto-replay',
      };
      // Persist stop intent BEFORE any supervisor cleanup call.
      this.#actions.recordIntent({
        actionId,
        taskId: this.#taskId,
        idempotencyKey: `${this.#taskId}:budget-stop:${attemptId}:${reason}`,
        type: 'budget-stop',
        payload,
      });
    }

    this.#issueStopSequence(actionId, attemptId, reason);
  }

  #issueStopSequence(
    actionId: string,
    attemptId: AttemptId,
    reason: StopReason,
  ): void {
    this.#stopInFlight.add(attemptId);
    // Attach outcome listener before any supervisor call so we never miss events.
    this.#attachStopSubscription(actionId, attemptId, reason);

    // Exact order after durable intent: graceful stop, then force tree after grace.
    // Always issue force after grace (supervisor may no-op if already dead).
    // Do NOT close intervals or mark completed until cleanup outcome is verified.
    void this.#supervisor.requestGracefulStop(attemptId);

    this.#clock.schedule(this.#graceMs, () => {
      void this.#supervisor.forceStopTree(attemptId);
    });
  }

  #attachStopSubscription(
    actionId: string,
    attemptId: AttemptId,
    reason: StopReason,
  ): void {
    this.#detachStopSubscription(attemptId);
    const unsubscribe = this.#supervisor.subscribe(attemptId, (event) => {
      this.#onSupervisorStopEvent(actionId, attemptId, reason, event);
    });
    this.#stopUnsubscribes.set(attemptId, unsubscribe);
  }

  #detachStopSubscription(attemptId: AttemptId): void {
    const existing = this.#stopUnsubscribes.get(attemptId);
    if (existing !== undefined) {
      existing();
      this.#stopUnsubscribes.delete(attemptId);
    }
  }

  #onSupervisorStopEvent(
    actionId: string,
    attemptId: AttemptId,
    reason: StopReason,
    event: ProcessSupervisorEvent,
  ): void {
    if (this.#stopFinalized.has(attemptId)) {
      return;
    }

    if (
      event.type === 'cleanup_failed'
      && event.operation === 'force_stop_tree'
    ) {
      this.#finalizeStopFailure(actionId, attemptId, reason, event.error);
      return;
    }

    // Verified termination: process exited (graceful or force) or force cleanup succeeded.
    if (
      event.type === 'exited'
      || (
        event.type === 'cleanup_succeeded'
        && event.operation === 'force_stop_tree'
      )
    ) {
      this.#finalizeStopSuccess(actionId, attemptId, reason);
    }
  }

  #finalizeStopSuccess(
    actionId: string,
    attemptId: AttemptId,
    reason: StopReason,
  ): void {
    if (this.#stopFinalized.has(attemptId)) {
      return;
    }
    this.#stopFinalized.add(attemptId);
    this.#detachStopSubscription(attemptId);

    const open = this.#repository
      .listOpenIntervals(this.#taskId)
      .find((interval) => interval.attemptId === attemptId);
    if (open !== undefined) {
      const endedAt = this.#clock.now();
      const durationMs = this.#clock.elapsedBetween(open.startedAt, endedAt);
      this.#repository.endOpenInterval(
        this.#taskId,
        attemptId,
        endedAt,
        durationMs,
      );
    }

    const existing = this.#actions.get(actionId);
    if (existing?.status === 'intent') {
      this.#actions.markCompleted(actionId, {
        result: {
          attemptId,
          reason,
          forceStopIssued: true,
          stage: 'completed',
          completedAt: this.#clock.now(),
        },
      });
    }
    this.#stopInFlight.delete(attemptId);
  }

  #finalizeStopFailure(
    actionId: string,
    attemptId: AttemptId,
    reason: StopReason,
    error: string,
  ): void {
    if (this.#stopFinalized.has(attemptId)) {
      return;
    }
    // Do not mark finalized permanently in a way that blocks recovery retry:
    // keep stopInFlight cleared so resumePendingStop can re-issue after we
    // re-open the intent path. Interval stays open (conservative accounting).
    this.#detachStopSubscription(attemptId);
    this.#stopInFlight.delete(attemptId);

    const existing = this.#actions.get(actionId);
    if (existing?.status === 'intent') {
      // Persist failed cleanup so recovery sees unresolved termination.
      // Keep interval open — process may still be alive.
      this.#actions.markFailed(actionId, {
        error,
        result: {
          attemptId,
          reason,
          forceStopIssued: true,
          stage: 'cleanup_failed',
          failedAt: this.#clock.now(),
          error,
        },
      });
    }
  }

  #findPendingStop(): BudgetRecoverySnapshot['pendingStop'] {
    const rows = this.#database
      .prepare(
        `SELECT id, payload_json FROM pending_actions
         WHERE task_id = ? AND action_type = 'budget-stop' AND status = 'intent'
         ORDER BY created_at, id`,
      )
      .all(this.#taskId) as unknown as readonly {
        readonly id: string;
        readonly payload_json: string;
      }[];
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const payload = JSON.parse(row.payload_json) as PendingStopPayload;
    return {
      actionId: row.id,
      attemptId: payload.attemptId,
      reason: payload.reason,
    };
  }

  #findFailedStop(): {
    readonly actionId: string;
    readonly attemptId: AttemptId;
    readonly reason: StopReason;
    readonly error: string | null;
  } | null {
    const rows = this.#database
      .prepare(
        `SELECT id, payload_json, error_text FROM pending_actions
         WHERE task_id = ? AND action_type = 'budget-stop' AND status = 'failed'
         ORDER BY created_at DESC, id DESC`,
      )
      .all(this.#taskId) as unknown as readonly {
        readonly id: string;
        readonly payload_json: string;
        readonly error_text: string | null;
      }[];
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const payload = JSON.parse(row.payload_json) as PendingStopPayload;
    return {
      actionId: row.id,
      attemptId: payload.attemptId,
      reason: payload.reason,
      error: row.error_text,
    };
  }

  #findPendingStopForAttempt(
    attemptId: AttemptId,
    reason: StopReason,
  ): { readonly actionId: string } | undefined {
    const rows = this.#database
      .prepare(
        `SELECT id, payload_json FROM pending_actions
         WHERE task_id = ? AND action_type = 'budget-stop' AND status = 'intent'
         ORDER BY created_at, id`,
      )
      .all(this.#taskId) as unknown as readonly {
        readonly id: string;
        readonly payload_json: string;
      }[];
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as PendingStopPayload;
      if (payload.attemptId === attemptId && payload.reason === reason) {
        return { actionId: row.id };
      }
    }
    return undefined;
  }

  #isNonBillable(): boolean {
    const state = this.#repository.getTaskState(this.#taskId);
    return state?.nonBillableState !== null && state?.nonBillableState !== undefined;
  }

  #assertWritable(): void {
    if (this.#failClosed) {
      throw new Error(
        'budget is fail-closed due to ambiguous restart state; inspection required',
      );
    }
  }
}

export function serializeBudgetDecisionEvidence(input: {
  readonly reservationId: string;
  readonly attemptId: AttemptId;
  readonly guardDecisionId?: string;
}): string {
  return serializeJsonValue({
    reservationId: input.reservationId,
    attemptId: input.attemptId,
    ...(input.guardDecisionId === undefined
      ? {}
      : { guardDecisionId: input.guardDecisionId }),
  });
}
