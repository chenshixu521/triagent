import type { AttemptId } from '../domain/ids.js';
import type {
  ProcessEventListener,
  ProcessEventUnsubscribe,
  ProcessStartRequest,
  ProcessSupervisorEvent,
  ProcessSupervisorPort,
  ProcessWaitResult,
  SupervisedProcess,
} from '../process/process-supervisor-port.js';
import type { AgentEvent } from '../agents/agent-adapter.js';
import type {
  AgentWorkerManager,
  NormalizedWorkerEvent,
} from './agent-worker-manager.js';

/**
 * Main-process {@link ProcessSupervisorPort} that proxies stop/wait/subscribe
 * through Worker IPC to the Worker's real ProcessSupervisor/ProcessHost.
 *
 * BudgetController and workflow code keep the stable domain port contract.
 * The Worker owns the OS ProcessSupervisor; this proxy never spawns helpers
 * itself and never silently replays stop intents.
 *
 * Mapping:
 * - requestGracefulStop → stop_run mode=graceful
 * - forceStopTree → stop_run mode=force
 * - subscribe ← worker agent events (cleanup_*, process_exited, process_started)
 * - wait ← run_exited (or process_exited if already observed)
 * - start is owned by the Worker (start_run); calling start on the proxy fails
 */
export class WorkerProcessSupervisorProxy implements ProcessSupervisorPort {
  readonly #manager: AgentWorkerManager;
  readonly #listeners = new Map<AttemptId, Set<ProcessEventListener>>();
  readonly #waiters = new Map<
    AttemptId,
    {
      readonly promise: Promise<ProcessWaitResult>;
      resolve: (result: ProcessWaitResult) => void;
      settled: boolean;
    }
  >();
  readonly #startedPids = new Map<AttemptId, number>();
  #unsubscribeManager: (() => void) | undefined;

  public constructor(manager: AgentWorkerManager) {
    this.#manager = manager;
    // Attach once; fan-out filters by attemptId.
    this.#unsubscribeManager = manager.addProcessEventObserver(
      (attemptId, event) => {
        this.#onWorkerProcessEvent(attemptId, event);
      },
    );
  }

  public dispose(): void {
    this.#unsubscribeManager?.();
    this.#unsubscribeManager = undefined;
    this.#listeners.clear();
    this.#waiters.clear();
    this.#startedPids.clear();
  }

  public subscribe(
    attemptId: AttemptId,
    listener: ProcessEventListener,
  ): ProcessEventUnsubscribe {
    const set = this.#listeners.get(attemptId) ?? new Set();
    set.add(listener);
    this.#listeners.set(attemptId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(attemptId);
    };
  }

  public async start(_request: ProcessStartRequest): Promise<SupervisedProcess> {
    throw new Error(
      'WorkerProcessSupervisorProxy.start is not supported; Worker owns start_run',
    );
  }

  public async requestGracefulStop(attemptId: AttemptId): Promise<void> {
    this.#ensureWaiter(attemptId);
    await this.#manager.stopRun(attemptId, 'graceful');
  }

  public async forceStopTree(attemptId: AttemptId): Promise<void> {
    this.#ensureWaiter(attemptId);
    await this.#manager.stopRun(attemptId, 'force');
  }

  public wait(attemptId: AttemptId): Promise<ProcessWaitResult> {
    return this.#ensureWaiter(attemptId).promise;
  }

  /**
   * Observe a normalized worker event from outside when the manager does not
   * yet expose addProcessEventObserver (tests may call this directly).
   */
  public acceptNormalizedEvent(normalized: NormalizedWorkerEvent): void {
    this.#onWorkerProcessEvent(normalized.attemptId, normalized.event);
  }

  /**
   * Observe run_exited from the manager so wait() can settle even if process
   * events were missed under backpressure (terminal events are never dropped).
   */
  public acceptRunExited(payload: {
    readonly attemptId: AttemptId;
    readonly status: 'succeeded' | 'failed' | 'timed_out' | 'stopped';
    readonly exitCode?: number | null;
    readonly signal?: string | null;
    readonly endedAt?: string;
  }): void {
    const waiter = this.#ensureWaiter(payload.attemptId);
    if (waiter.settled) return;
    const reason =
      payload.status === 'timed_out'
        ? 'timed_out'
        : payload.status === 'stopped'
          ? 'force_stop'
          : 'exited';
    waiter.settled = true;
    waiter.resolve({
      attemptId: payload.attemptId,
      pid: this.#startedPids.get(payload.attemptId) ?? 0,
      exitCode: payload.exitCode ?? null,
      signal: payload.signal ?? null,
      reason,
      endedAt: payload.endedAt ?? new Date().toISOString(),
    });
  }

  #ensureWaiter(attemptId: AttemptId): {
    readonly promise: Promise<ProcessWaitResult>;
    resolve: (result: ProcessWaitResult) => void;
    settled: boolean;
  } {
    const existing = this.#waiters.get(attemptId);
    if (existing !== undefined) return existing;
    let resolve!: (result: ProcessWaitResult) => void;
    const promise = new Promise<ProcessWaitResult>((res) => {
      resolve = res;
    });
    const entry = { promise, resolve, settled: false };
    this.#waiters.set(attemptId, entry);
    return entry;
  }

  #onWorkerProcessEvent(attemptId: AttemptId, event: AgentEvent): void {
    const mapped = mapAgentEventToSupervisorEvent(attemptId, event);
    if (mapped === undefined) return;

    if (mapped.type === 'started') {
      this.#startedPids.set(attemptId, mapped.pid);
    }

    this.#fanOut(attemptId, mapped);

    if (mapped.type === 'exited') {
      const waiter = this.#ensureWaiter(attemptId);
      if (!waiter.settled) {
        waiter.settled = true;
        waiter.resolve({
          attemptId,
          pid: mapped.pid,
          exitCode: mapped.exitCode,
          signal: mapped.signal,
          reason: mapped.reason,
          endedAt: mapped.occurredAt,
        });
      }
    }
  }

  #fanOut(attemptId: AttemptId, event: ProcessSupervisorEvent): void {
    const failures: unknown[] = [];
    for (const listener of this.#listeners.get(attemptId) ?? []) {
      try {
        listener(event);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        'multiple worker process supervisor proxy listeners failed',
      );
    }
  }
}

function mapAgentEventToSupervisorEvent(
  attemptId: AttemptId,
  event: AgentEvent,
): ProcessSupervisorEvent | undefined {
  switch (event.type) {
    case 'process_started':
      return {
        type: 'started',
        attemptId,
        pid: event.pid,
        occurredAt: event.occurredAt,
      };
    case 'cleanup_succeeded':
      return {
        type: 'cleanup_succeeded',
        attemptId,
        operation: event.operation,
        occurredAt: event.occurredAt,
      };
    case 'cleanup_failed':
      return {
        type: 'cleanup_failed',
        attemptId,
        operation: event.operation,
        error: event.error,
        occurredAt: event.occurredAt,
      };
    case 'process_exited':
      return {
        type: 'exited',
        attemptId,
        pid: event.pid,
        exitCode: event.exitCode,
        signal: event.signal,
        reason: event.reason,
        occurredAt: event.occurredAt,
      };
    case 'descendant_started':
      return {
        type: 'descendant_started',
        attemptId,
        pid: event.pid,
        parentPid: event.parentPid,
        occurredAt: event.occurredAt,
      };
    case 'stderr':
      return {
        type: 'stderr',
        attemptId,
        chunk: event.chunk,
        occurredAt: event.occurredAt,
      };
    case 'output':
      return {
        type: 'stdout',
        attemptId,
        chunk: event.text,
        occurredAt: new Date().toISOString(),
      };
    default:
      return undefined;
  }
}
