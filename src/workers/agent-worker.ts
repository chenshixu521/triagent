/**
 * Agent Worker thread entrypoint.
 *
 * Owns Adapter parsing and ProcessSupervisorPort communication so a parser
 * crash cannot take down the main TUI / SQLite writer process.
 *
 * Task 11 injects a deterministic in-thread fake supervisor. Task 12 binds
 * the same port to ProcessHost without changing the IPC contract.
 */
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

import type {
  AgentAdapter,
  AgentEvent,
  AgentRequest,
} from '../agents/agent-adapter.js';
import { SupervisedExecutionHandle } from '../agents/execution-handle.js';
import {
  asAttemptId,
  asBaselineId,
  asConversationId,
  type AttemptId,
} from '../domain/ids.js';
import type { AgentKind } from '../domain/task.js';
import {
  resolveProcessHostExecutable,
} from '../process/process-host-client.js';
import { ProcessSupervisor } from '../process/process-supervisor.js';
import type {
  ProcessCleanupOperation,
  ProcessEventListener,
  ProcessExitReason,
  ProcessStartRequest,
  ProcessSupervisorEvent,
  ProcessSupervisorPort,
  ProcessWaitResult,
  SupervisedProcess,
} from '../process/process-supervisor-port.js';
import {
  displayPriorityForAgentEvent,
  encodeWorkerIpcMessage,
  parseWorkerIpcMessage,
  redactBoundedError,
  type MainToWorkerMessage,
  type StartRunMessage,
  type WorkerToMainMessage,
} from './worker-protocol.js';
import { WorkerHeartbeatMonitor } from './worker-heartbeat.js';

export interface WorkerFakeTimelineEntry {
  readonly afterMs: number;
  readonly event:
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
}

export interface WorkerFakeProcessPlan {
  readonly pid: number;
  readonly timeline: readonly WorkerFakeTimelineEntry[];
  readonly gracefulStop?: {
    readonly afterMs: number;
    readonly outcome: 'succeeded' | 'failed';
    readonly exitCode?: number | null;
    readonly error?: string;
  };
  readonly forceStop?: {
    readonly afterMs: number;
    readonly outcome: 'succeeded' | 'failed';
    readonly exitCode?: number | null;
    readonly error?: string;
  };
}

export interface AgentWorkerData {
  readonly workerId: string;
  readonly heartbeatIntervalMs?: number;
  readonly useCrashingParser?: boolean;
  readonly crashingParserPath?: string;
  readonly fakePlans?: readonly WorkerFakeProcessPlan[];
  readonly fakeClockStart?: string;
}

class WorkerFakeClock {
  readonly #epochMs: number;
  #elapsedMs = 0;
  #nextOrder = 0;
  readonly #scheduled: Array<{
    readonly atMs: number;
    readonly order: number;
    readonly action: () => void;
  }> = [];

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
    this.#scheduled.push({
      atMs: this.#elapsedMs + afterMs,
      order: this.#nextOrder,
      action,
    });
    this.#nextOrder += 1;
  }

  public advanceBy(milliseconds: number): void {
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

interface ActiveFakeProcess {
  readonly plan: WorkerFakeProcessPlan;
  readonly wait: Promise<ProcessWaitResult>;
  readonly resolveWait: (result: ProcessWaitResult) => void;
  settled: boolean;
}

/** Deterministic ProcessSupervisorPort for Task 11 (no OS process spawn). */
class WorkerFakeSupervisor implements ProcessSupervisorPort {
  readonly #listeners = new Map<AttemptId, Set<ProcessEventListener>>();
  readonly #active = new Map<AttemptId, ActiveFakeProcess>();
  readonly #plans: WorkerFakeProcessPlan[];
  readonly #clock: WorkerFakeClock;

  public constructor(
    clock: WorkerFakeClock,
    plans: readonly WorkerFakeProcessPlan[],
  ) {
    this.#clock = clock;
    this.#plans = [...plans];
  }

  public subscribe(
    attemptId: AttemptId,
    listener: ProcessEventListener,
  ): () => void {
    const listeners = this.#listeners.get(attemptId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(attemptId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(attemptId);
    };
  }

  public async start(request: ProcessStartRequest): Promise<SupervisedProcess> {
    if (this.#active.has(request.attemptId)) {
      throw new Error(`attempt is already supervised: ${request.attemptId}`);
    }
    const plan = this.#plans.shift();
    if (plan === undefined) {
      throw new Error('no fake process plan remains');
    }
    let resolveWait!: (result: ProcessWaitResult) => void;
    const wait = new Promise<ProcessWaitResult>((resolve) => {
      resolveWait = resolve;
    });
    this.#active.set(request.attemptId, {
      plan,
      wait,
      resolveWait,
      settled: false,
    });
    for (const entry of plan.timeline) {
      this.#clock.schedule(entry.afterMs, () => {
        this.#emit(request.attemptId, entry.event);
      });
    }
    return {
      attemptId: request.attemptId,
      pid: plan.pid,
      startedAt: this.#clock.now(),
    };
  }

  public async requestGracefulStop(attemptId: AttemptId): Promise<void> {
    this.#scheduleCleanup(attemptId, 'graceful_stop');
  }

  public async forceStopTree(attemptId: AttemptId): Promise<void> {
    this.#scheduleCleanup(attemptId, 'force_stop_tree');
  }

  public wait(attemptId: AttemptId): Promise<ProcessWaitResult> {
    const active = this.#active.get(attemptId);
    if (active === undefined) {
      return Promise.reject(new Error(`attempt is not supervised: ${attemptId}`));
    }
    return active.wait;
  }

  public advanceClock(ms: number): void {
    this.#clock.advanceBy(ms);
  }

  #scheduleCleanup(
    attemptId: AttemptId,
    operation: ProcessCleanupOperation,
  ): void {
    const active = this.#active.get(attemptId);
    if (active === undefined || active.settled) return;
    const plan = operation === 'graceful_stop'
      ? active.plan.gracefulStop
      : active.plan.forceStop;
    if (plan === undefined) {
      // Default: immediate successful cleanup for stop tests.
      this.#emit(attemptId, { type: 'cleanup_succeeded', operation });
      this.#emit(attemptId, {
        type: 'exited',
        pid: active.plan.pid,
        exitCode: null,
        signal: operation === 'force_stop_tree' ? 'SIGKILL' : null,
        reason: operation === 'force_stop_tree' ? 'force_stop' : 'graceful_stop',
      });
      return;
    }
    this.#clock.schedule(plan.afterMs, () => {
      if (plan.outcome === 'failed') {
        this.#emit(attemptId, {
          type: 'cleanup_failed',
          operation,
          error: plan.error ?? 'fake cleanup failed',
        });
        return;
      }
      this.#emit(attemptId, { type: 'cleanup_succeeded', operation });
      this.#emit(attemptId, {
        type: 'exited',
        pid: active.plan.pid,
        exitCode: plan.exitCode ?? null,
        signal: operation === 'force_stop_tree' ? 'SIGKILL' : null,
        reason: operation === 'force_stop_tree' ? 'force_stop' : 'graceful_stop',
      });
    });
  }

  #emit(
    attemptId: AttemptId,
    planned: WorkerFakeTimelineEntry['event'],
  ): void {
    const active = this.#active.get(attemptId);
    if (active === undefined || active.settled) return;
    const event = {
      ...planned,
      attemptId,
      occurredAt: this.#clock.now(),
    } as ProcessSupervisorEvent;
    if (event.type === 'exited') {
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
    for (const listener of this.#listeners.get(attemptId) ?? []) {
      try {
        listener(event);
      } catch {
        // Listener failures must not prevent terminal wait settling.
      }
    }
  }
}

function post(message: WorkerToMainMessage): void {
  encodeWorkerIpcMessage(message);
  parentPort?.postMessage(message);
}

function nowIso(): string {
  return new Date().toISOString();
}

function loadCrashingParser(
  path: string,
): (line: string) => AgentEvent | null {
  const require = createRequire(import.meta.url);
  const mod = require(path) as {
    parseEvent?: (line: string) => AgentEvent | null;
    default?: (line: string) => AgentEvent | null;
  };
  const parser = mod.parseEvent ?? mod.default;
  if (typeof parser !== 'function') {
    throw new Error('crashing parser module must export parseEvent');
  }
  return parser;
}

/** Must match tests/fixtures/workers/crashing-parser.mjs and worker isolation tests. */
export const CRASH_TRIGGER_MARKER = 'CRASH_TRIGGER_MARKER_T11_9f3c2a1b';

function defaultCrashPlan(attemptId: string): WorkerFakeProcessPlan {
  return {
    pid: 42_001,
    timeline: [
      { afterMs: 1, event: { type: 'started', pid: 42_001 } },
      {
        afterMs: 5,
        event: {
          type: 'stdout',
          chunk: `${JSON.stringify({
            type: 'output',
            attemptId,
            text: 'worker partial output before crash',
          })}\n`,
        },
      },
      {
        afterMs: 20,
        event: {
          type: 'stdout',
          // Unique crash-trigger line: must be persisted to durable JSONL before
          // the crashing parser runs (and may never become a parsed AgentEvent).
          chunk: `${JSON.stringify({
            type: 'result',
            attemptId,
            crashTrigger: CRASH_TRIGGER_MARKER,
            authorization: 'Bearer sk-live-secret-should-redact',
            output: {
              status: 'completed',
              summary: 'must not auto-apply after worker crash',
              marker: CRASH_TRIGGER_MARKER,
            },
          })}\n`,
        },
      },
      {
        afterMs: 30,
        event: {
          type: 'exited',
          pid: 42_001,
          exitCode: 0,
          signal: null,
          reason: 'exited',
        },
      },
    ],
  };
}

class WorkerRunController {
  readonly #workerId: string;
  readonly #heartbeat: WorkerHeartbeatMonitor;
  readonly #data: AgentWorkerData;
  #activeAttemptId: AttemptId | undefined;
  #supervisor: ProcessSupervisorPort | undefined;
  #fakeSupervisor: WorkerFakeSupervisor | undefined;
  #processSupervisor: ProcessSupervisor | undefined;
  #clockTimer: ReturnType<typeof setInterval> | undefined;
  #settled = false;
  #messageHandler: ((raw: unknown) => void) | undefined;

  public constructor(data: AgentWorkerData) {
    this.#workerId = data.workerId;
    this.#data = data;
    this.#heartbeat = new WorkerHeartbeatMonitor({
      intervalMs: data.heartbeatIntervalMs ?? 200,
      timeoutMs: (data.heartbeatIntervalMs ?? 200) * 5,
      onBeat: (sequence, sentAt) => {
        post({
          type: 'heartbeat',
          workerId: this.#workerId,
          ...(this.#activeAttemptId === undefined
            ? {}
            : { attemptId: this.#activeAttemptId }),
          sequence,
          sentAt,
        });
      },
    });
  }

  public start(): void {
    if (parentPort === null) {
      throw new Error('agent-worker must run inside a Worker thread');
    }
    this.#messageHandler = (raw: unknown) => {
      void this.#onMessage(raw);
    };
    parentPort.on('message', this.#messageHandler);
    this.#heartbeat.startBeating();
  }

  public stop(): void {
    this.#heartbeat.stop();
    this.#clearClock();
    if (parentPort !== null && this.#messageHandler !== undefined) {
      parentPort.off('message', this.#messageHandler);
    }
    this.#messageHandler = undefined;
    this.#activeAttemptId = undefined;
    this.#supervisor = undefined;
    this.#fakeSupervisor = undefined;
    void this.#processSupervisor?.dispose().catch(() => undefined);
    this.#processSupervisor = undefined;
  }

  async #onMessage(raw: unknown): Promise<void> {
    const parsed = parseWorkerIpcMessage(raw, 'main_to_worker');
    if (!parsed.ok) {
      post({
        type: 'worker_failed',
        workerId: this.#workerId,
        ...(this.#activeAttemptId === undefined
          ? {}
          : { attemptId: this.#activeAttemptId }),
        reasonCode: parsed.reasonCode === 'oversized_message'
          ? 'oversized_message'
          : 'protocol_violation',
        message: parsed.message,
        occurredAt: nowIso(),
        fatal: parsed.reasonCode === 'oversized_message',
      });
      return;
    }
    const message = parsed.message as MainToWorkerMessage;
    try {
      switch (message.type) {
        case 'start_run':
          await this.#startRun(message);
          return;
        case 'stop_run':
          await this.#stopRun(asAttemptId(message.attemptId), message.mode);
          return;
        case 'deliver_message':
          return;
      }
    } catch (error) {
      this.#failRun(
        this.#activeAttemptId,
        'unhandled_error',
        redactBoundedError(error),
        true,
      );
    }
  }

  async #startRun(message: StartRunMessage): Promise<void> {
    if (this.#activeAttemptId !== undefined && !this.#settled) {
      post({
        type: 'worker_failed',
        workerId: this.#workerId,
        attemptId: this.#activeAttemptId,
        reasonCode: 'protocol_violation',
        message: 'worker already has an active run',
        occurredAt: nowIso(),
        fatal: false,
      });
      return;
    }

    this.#settled = false;
    const attemptId = asAttemptId(message.attemptId);
    this.#activeAttemptId = attemptId;

    this.#clearClock();
    void this.#processSupervisor?.dispose().catch(() => undefined);
    this.#processSupervisor = undefined;
    this.#fakeSupervisor = undefined;

    if (message.supervisorMode === 'process_host') {
      const helperPath = message.processHostPath ?? resolveProcessHostExecutable();
      this.#processSupervisor = new ProcessSupervisor({ helperPath });
      this.#supervisor = this.#processSupervisor;
    } else {
      const clock = new WorkerFakeClock(
        this.#data.fakeClockStart ?? '2026-07-12T12:00:00.000Z',
      );
      const plans = this.#data.fakePlans ?? [defaultCrashPlan(message.attemptId)];
      this.#fakeSupervisor = new WorkerFakeSupervisor(clock, plans);
      this.#supervisor = this.#fakeSupervisor;
      this.#clockTimer = setInterval(() => {
        this.#fakeSupervisor?.advanceClock(5);
      }, 5);
      if (typeof this.#clockTimer.unref === 'function') {
        this.#clockTimer.unref();
      }
    }

    const useCrash = message.useCrashingParser === true
      || this.#data.useCrashingParser === true;
    const adapter = useCrash
      ? this.#createCrashingAdapter(message, this.#supervisor)
      : this.#createPassthroughAdapter(message, this.#supervisor);

    const request: AgentRequest = {
      attemptId,
      baselineId: asBaselineId(message.baselineId),
      requirementVersion: message.requirementVersion,
      role: message.role,
      projectRoot: message.projectRoot,
      prompt: message.prompt,
      ...(message.timeoutMs === undefined ? {} : { timeoutMs: message.timeoutMs }),
    };

    const handle = message.conversationId === undefined
      ? await adapter.start(request)
      : await adapter.resume(asConversationId(message.conversationId), request);

    try {
      for await (const event of handle.events()) {
        if (this.#activeAttemptId !== attemptId) break;
        this.#emitEvent(event);
      }
      const result = await handle.wait();
      if (this.#activeAttemptId === attemptId && !this.#settled) {
        this.#settled = true;
        post({
          type: 'run_exited',
          attemptId,
          status: result.status,
          exitCode: result.exitCode,
          signal: result.signal ?? null,
          ...(result.error === undefined ? {} : { error: result.error }),
          endedAt: nowIso(),
        });
      }
    } catch (error) {
      this.#failRun(attemptId, 'unhandled_error', redactBoundedError(error), true);
    } finally {
      this.#clearClock();
    }
  }

  /**
   * Emit durable raw evidence for every stdout line BEFORE Adapter parsing.
   * Parser crashes must not erase the crash-triggering line from main's JSONL.
   */
  #parseAfterRawEvidence(
    attemptId: AttemptId,
    parse: (line: string) => AgentEvent | null,
  ): (line: string) => AgentEvent | null {
    return (line: string) => {
      post({
        type: 'raw_output',
        attemptId,
        stream: 'stdout',
        chunk: line,
        occurredAt: nowIso(),
      });
      return parse(line);
    };
  }

  #createPassthroughAdapter(
    message: StartRunMessage,
    supervisor: ProcessSupervisorPort,
  ): AgentAdapter {
    const kind = message.agentKind as AgentKind;
    const capabilities = {
      fixedSessionId: false,
      resume: false,
      structuredOutput: true,
      streamJson: true,
      realTimeInput: false,
      nativeSandbox: false,
      nativePermissionRules: false,
      budgetLimit: false,
      turnLimit: false,
      timeLimit: false,
      nonGitProjects: true,
      writeModes: Object.freeze(['workspace-write' as const]),
    };
    const parseJsonLine = (line: string): AgentEvent | null => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed.attemptId !== 'string') return null;
        const attemptId = asAttemptId(parsed.attemptId);
        if (parsed.type === 'output' && typeof parsed.text === 'string') {
          return { type: 'output', attemptId, text: parsed.text };
        }
        if (parsed.type === 'result') {
          return {
            type: 'result',
            attemptId,
            output: (parsed.output ?? null) as never,
          };
        }
        return null;
      } catch {
        return null;
      }
    };
    const parseAfterRaw = this.#parseAfterRawEvidence.bind(this);
    return {
      kind,
      async checkAvailability() {
        return { status: 'available', version: 'worker-fake' };
      },
      async discoverCapabilities() {
        return capabilities;
      },
      parseEvent(line: string): AgentEvent | null {
        return parseJsonLine(line);
      },
      async start(request: AgentRequest) {
        const handle = new SupervisedExecutionHandle({
          attemptId: request.attemptId,
          capabilities,
          supervisor,
          parseEvent: parseAfterRaw(request.attemptId, parseJsonLine),
        });
        await supervisor.start({
          attemptId: request.attemptId,
          executable: message.executable,
          args: message.args,
          cwd: request.projectRoot,
          ...(message.environment === undefined
            ? {}
            : { environment: message.environment }),
          ...(request.timeoutMs === undefined
            ? {}
            : { timeoutMs: request.timeoutMs }),
        });
        return handle;
      },
      async resume() {
        throw new Error('resume unsupported on worker passthrough adapter');
      },
    };
  }

  #createCrashingAdapter(
    message: StartRunMessage,
    supervisor: ProcessSupervisorPort,
  ): AgentAdapter {
    const parserPath = this.#data.crashingParserPath;
    if (parserPath === undefined) {
      throw new Error('crashing parser path is required when useCrashingParser is set');
    }
    const crashParse = loadCrashingParser(parserPath);
    const kind = message.agentKind as AgentKind;

    return {
      kind,
      async checkAvailability() {
        return { status: 'available', version: 'crash-fixture' };
      },
      async discoverCapabilities() {
        return {
          fixedSessionId: false,
          resume: false,
          structuredOutput: true,
          streamJson: true,
          realTimeInput: false,
          nativeSandbox: false,
          nativePermissionRules: false,
          budgetLimit: false,
          turnLimit: false,
          timeLimit: false,
          nonGitProjects: true,
          writeModes: Object.freeze(['workspace-write' as const]),
        };
      },
      parseEvent(line: string): AgentEvent | null {
        return crashParse(line);
      },
      start: async (request: AgentRequest) => {
        const capabilities = {
          fixedSessionId: false,
          resume: false,
          structuredOutput: true,
          streamJson: true,
          realTimeInput: false,
          nativeSandbox: false,
          nativePermissionRules: false,
          budgetLimit: false,
          turnLimit: false,
          timeLimit: false,
          nonGitProjects: true,
          writeModes: Object.freeze(['workspace-write' as const]),
        };
        const handle = new SupervisedExecutionHandle({
          attemptId: request.attemptId,
          capabilities,
          supervisor,
          parseEvent: this.#parseAfterRawEvidence(request.attemptId, crashParse),
        });
        await supervisor.start({
          attemptId: request.attemptId,
          executable: message.executable,
          args: message.args,
          cwd: request.projectRoot,
          ...(message.environment === undefined
            ? {}
            : { environment: message.environment }),
          ...(request.timeoutMs === undefined
            ? {}
            : { timeoutMs: request.timeoutMs }),
        });
        return handle;
      },
      async resume() {
        throw new Error('resume unsupported on crashing adapter');
      },
    };
  }

  async #stopRun(
    attemptId: AttemptId,
    mode: 'graceful' | 'force',
  ): Promise<void> {
    if (this.#activeAttemptId !== attemptId || this.#supervisor === undefined) {
      return;
    }
    if (mode === 'force') {
      await this.#supervisor.forceStopTree(attemptId);
    } else {
      await this.#supervisor.requestGracefulStop(attemptId);
    }
  }

  #emitEvent(event: AgentEvent): void {
    if (this.#activeAttemptId === undefined) return;
    if (event.attemptId !== this.#activeAttemptId) return;
    post({
      type: 'event',
      attemptId: event.attemptId,
      event,
      displayPriority: displayPriorityForAgentEvent(event),
    });
  }

  #failRun(
    attemptId: AttemptId | undefined,
    reasonCode: 'crash' | 'unhandled_error' | 'protocol_violation',
    message: string,
    fatal: boolean,
  ): void {
    if (this.#settled) return;
    this.#settled = true;
    post({
      type: 'worker_failed',
      workerId: this.#workerId,
      ...(attemptId === undefined ? {} : { attemptId }),
      reasonCode,
      message,
      occurredAt: nowIso(),
      fatal,
    });
    if (attemptId !== undefined) {
      post({
        type: 'run_exited',
        attemptId,
        status: 'failed',
        exitCode: null,
        signal: null,
        error: message,
        endedAt: nowIso(),
      });
    }
  }

  #clearClock(): void {
    if (this.#clockTimer !== undefined) {
      clearInterval(this.#clockTimer);
      this.#clockTimer = undefined;
    }
  }
}

const data = (workerData ?? { workerId: 'anonymous' }) as AgentWorkerData;
const controller = new WorkerRunController(data);
controller.start();

parentPort?.once('close', () => {
  controller.stop();
});
