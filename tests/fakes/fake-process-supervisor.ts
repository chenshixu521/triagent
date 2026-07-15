import type { AttemptId } from '../../src/domain/ids.js';
import type {
  ProcessCleanupOperation,
  ProcessEventListener,
  ProcessEventUnsubscribe,
  ProcessExitReason,
  ProcessStartRequest,
  ProcessSupervisorEvent,
  ProcessSupervisorPort,
  ProcessWaitResult,
  SupervisedProcess,
} from '../../src/process/process-supervisor-port.js';
import { validateProcessStdinPayload } from '../../src/process/process-supervisor-port.js';

interface ScheduledAction {
  readonly atMs: number;
  readonly order: number;
  readonly action: () => void;
}

export class FakeClock {
  readonly #epochMs: number;
  #elapsedMs = 0;
  #nextOrder = 0;
  readonly #scheduled: ScheduledAction[] = [];

  public constructor(startedAt: string) {
    const epochMs = Date.parse(startedAt);
    if (!Number.isFinite(epochMs)) {
      throw new Error('fake clock requires a valid ISO timestamp');
    }
    this.#epochMs = epochMs;
  }

  public now(): string {
    return new Date(this.#epochMs + this.#elapsedMs).toISOString();
  }

  public schedule(afterMs: number, action: () => void): void {
    if (!Number.isSafeInteger(afterMs) || afterMs < 0) {
      throw new Error('fake clock delay must be a non-negative safe integer');
    }
    this.#scheduled.push({
      atMs: this.#elapsedMs + afterMs,
      order: this.#nextOrder,
      action,
    });
    this.#nextOrder += 1;
  }

  public advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new Error('fake clock advance must be a non-negative safe integer');
    }
    const targetMs = this.#elapsedMs + milliseconds;
    for (;;) {
      this.#scheduled.sort(
        (left, right) => left.atMs - right.atMs || left.order - right.order,
      );
      const next = this.#scheduled[0];
      if (next === undefined || next.atMs > targetMs) break;
      this.#scheduled.shift();
      this.#elapsedMs = next.atMs;
      next.action();
    }
    this.#elapsedMs = targetMs;
  }
}

type PlannedProcessEvent =
  | { readonly type: 'started'; readonly pid: number }
  | { readonly type: 'stdout'; readonly chunk: string }
  | { readonly type: 'stderr'; readonly chunk: string }
  | {
      readonly type: 'descendant_started';
      readonly pid: number;
      readonly parentPid: number;
    }
  | {
      readonly type: 'cleanup_succeeded';
      readonly operation: ProcessCleanupOperation;
    }
  | {
      readonly type: 'cleanup_failed';
      readonly operation: ProcessCleanupOperation;
      readonly error: string;
    }
  | {
      readonly type: 'exited';
      readonly pid: number;
      readonly exitCode: number | null;
      readonly signal: string | null;
      readonly reason: ProcessExitReason;
    };

export interface FakeTimelineEntry {
  readonly afterMs: number;
  readonly event: PlannedProcessEvent;
}

export interface FakeCleanupPlan {
  readonly afterMs: number;
  readonly outcome: 'succeeded' | 'failed';
  readonly exitCode?: number | null;
  readonly error?: string;
}

export interface FakeProcessPlan {
  readonly pid: number;
  readonly timeline: readonly FakeTimelineEntry[];
  readonly gracefulStop?: FakeCleanupPlan;
  readonly forceStop?: FakeCleanupPlan;
}

export type FakeSupervisorCall =
  | {
      readonly type: 'subscribe';
      readonly attemptId: AttemptId;
    }
  | {
      readonly type: 'start';
      readonly request: ProcessStartRequest;
    }
  | {
      readonly type: 'wait';
      readonly attemptId: AttemptId;
    }
  | {
      readonly type: 'request_graceful_stop';
      readonly attemptId: AttemptId;
    }
  | {
      readonly type: 'force_stop_tree';
      readonly attemptId: AttemptId;
    };

interface ActiveFakeProcess {
  readonly plan: FakeProcessPlan;
  readonly wait: Promise<ProcessWaitResult>;
  readonly resolveWait: (result: ProcessWaitResult) => void;
  readonly livePids: Set<number>;
  settled: boolean;
}

function rethrowListenerFailures(failures: readonly unknown[]): void {
  if (failures.length === 0) return;
  if (failures.length === 1) throw failures[0];
  throw new AggregateError(
    failures,
    'multiple process supervisor event listeners failed',
  );
}

export class FakeProcessSupervisor implements ProcessSupervisorPort {
  readonly #listeners = new Map<AttemptId, Set<ProcessEventListener>>();
  readonly #active = new Map<AttemptId, ActiveFakeProcess>();
  readonly #plans: FakeProcessPlan[];
  readonly calls: FakeSupervisorCall[] = [];

  public constructor(
    private readonly clock: FakeClock,
    plans: readonly FakeProcessPlan[],
  ) {
    this.#plans = [...plans];
  }

  public subscribe(
    attemptId: AttemptId,
    listener: ProcessEventListener,
  ): ProcessEventUnsubscribe {
    this.calls.push({ type: 'subscribe', attemptId });
    const listeners = this.#listeners.get(attemptId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(attemptId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(attemptId);
    };
  }

  public async start(request: ProcessStartRequest): Promise<SupervisedProcess> {
    // Validate stdin before recording a start call so oversized payloads
    // fail closed with zero observed start (matches production semantics).
    const stdin = request.stdin === undefined
      ? undefined
      : validateProcessStdinPayload(request.stdin);
    const normalized: ProcessStartRequest = stdin === undefined
      ? request
      : { ...request, stdin };

    if (this.#active.has(request.attemptId)) {
      throw new Error(`attempt is already supervised: ${request.attemptId}`);
    }
    const plan = this.#plans.shift();
    if (plan === undefined) {
      throw new Error('no fake process plan remains');
    }
    if (!Number.isSafeInteger(plan.pid) || plan.pid <= 0) {
      throw new Error('fake process pid must be a positive safe integer');
    }

    this.calls.push({ type: 'start', request: normalized });

    let resolveWait!: (result: ProcessWaitResult) => void;
    const wait = new Promise<ProcessWaitResult>((resolve) => {
      resolveWait = resolve;
    });
    this.#active.set(request.attemptId, {
      plan,
      wait,
      resolveWait,
      livePids: new Set([plan.pid]),
      settled: false,
    });

    for (const entry of plan.timeline) {
      this.clock.schedule(entry.afterMs, () => {
        this.#emit(request.attemptId, entry.event);
      });
    }

    return {
      attemptId: request.attemptId,
      pid: plan.pid,
      startedAt: this.clock.now(),
    };
  }

  public async requestGracefulStop(attemptId: AttemptId): Promise<void> {
    this.calls.push({ type: 'request_graceful_stop', attemptId });
    this.#scheduleCleanup(attemptId, 'graceful_stop');
  }

  public async forceStopTree(attemptId: AttemptId): Promise<void> {
    this.calls.push({ type: 'force_stop_tree', attemptId });
    this.#scheduleCleanup(attemptId, 'force_stop_tree');
  }

  public wait(attemptId: AttemptId): Promise<ProcessWaitResult> {
    this.calls.push({ type: 'wait', attemptId });
    const active = this.#active.get(attemptId);
    if (active === undefined) {
      return Promise.reject(
        new Error(`attempt is not supervised: ${attemptId}`),
      );
    }
    return active.wait;
  }

  public activeAttemptIds(): readonly AttemptId[] {
    return [...this.#active.entries()]
      .filter(([, active]) => active.livePids.size > 0)
      .map(([attemptId]) => attemptId);
  }

  public activeProcessIds(attemptId?: AttemptId): readonly number[] {
    const active = attemptId === undefined
      ? [...this.#active.values()]
      : (() => {
          const value = this.#active.get(attemptId);
          return value === undefined ? [] : [value];
        })();
    return [...new Set(active.flatMap((run) => [...run.livePids]))]
      .sort((left, right) => left - right);
  }

  #scheduleCleanup(
    attemptId: AttemptId,
    operation: ProcessCleanupOperation,
  ): void {
    const active = this.#active.get(attemptId);
    if (active === undefined) {
      throw new Error(`attempt is not supervised: ${attemptId}`);
    }
    if (active.settled) return;
    const plan = operation === 'graceful_stop'
      ? active.plan.gracefulStop
      : active.plan.forceStop;
    if (plan === undefined) {
      throw new Error(`no fake ${operation} plan for attempt: ${attemptId}`);
    }
    this.clock.schedule(plan.afterMs, () => {
      if (plan.outcome === 'failed') {
        this.#emit(attemptId, {
          type: 'cleanup_failed',
          operation,
          error: plan.error ?? 'fake cleanup failed',
        });
        return;
      }
      const listenerFailures: unknown[] = [];
      try {
        this.#emit(attemptId, { type: 'cleanup_succeeded', operation });
      } catch (error) {
        listenerFailures.push(error);
      }
      try {
        this.#emit(attemptId, {
          type: 'exited',
          pid: active.plan.pid,
          exitCode: plan.exitCode ?? null,
          signal: operation === 'force_stop_tree' ? 'SIGKILL' : null,
          reason: operation === 'force_stop_tree' ? 'force_stop' : 'graceful_stop',
        });
      } catch (error) {
        listenerFailures.push(error);
      }
      rethrowListenerFailures(listenerFailures);
    });
  }

  #emit(attemptId: AttemptId, planned: PlannedProcessEvent): void {
    const active = this.#active.get(attemptId);
    if (active === undefined || active.settled) return;
    const event = {
      ...planned,
      attemptId,
      occurredAt: this.clock.now(),
    } as ProcessSupervisorEvent;
    if (event.type === 'started') {
      active.livePids.add(event.pid);
    }
    if (event.type === 'descendant_started') {
      active.livePids.add(event.parentPid);
      active.livePids.add(event.pid);
    }
    if (event.type === 'exited') {
      if (event.reason === 'force_stop' || event.reason === 'graceful_stop') {
        active.livePids.clear();
      } else {
        active.livePids.delete(event.pid);
      }
      active.settled = true;
      active.resolveWait({
        attemptId,
        pid: event.pid,
        exitCode: event.exitCode,
        signal: event.signal,
        reason: event.reason,
        endedAt: event.occurredAt,
      });
    }
    const listenerFailures: unknown[] = [];
    for (const listener of this.#listeners.get(attemptId) ?? []) {
      try {
        listener(event);
      } catch (error) {
        listenerFailures.push(error);
      }
    }
    rethrowListenerFailures(listenerFailures);
  }
}
