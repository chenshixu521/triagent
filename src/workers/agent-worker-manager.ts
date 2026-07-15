import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { DatabaseSync } from 'node:sqlite';

import type { AgentEvent } from '../agents/agent-adapter.js';
import {
  type CompatibilityKey,
  type WorkerStartGateRecord,
  type WorkerStartMissingPrerequisite,
} from '../agents/compatibility-matrix.js';
import {
  activateRunAttempt,
  completeRunAttempt,
  createPendingRunAttempt,
  type ActiveRunAttempt,
  type PendingRunAttempt,
} from '../domain/attempt.js';
import {
  asAttemptId,
  asBaselineId,
  asTaskId,
  type AttemptId,
  type TaskId,
} from '../domain/ids.js';
import type { AgentKind, AgentRole } from '../domain/task.js';
import { JsonlLog } from '../logging/jsonl-log.js';
import { Redactor } from '../logging/redact.js';
import { ActionRepository } from '../persistence/action-repository.js';
import { AttemptRepository } from '../persistence/attempt-repository.js';
import { TaskRepository } from '../persistence/task-repository.js';
import { withTransaction } from '../persistence/transaction.js';
import { resolvePackageResourcePath } from '../process/native-helper-discovery.js';
import {
  transition,
  type Transitioned,
} from '../workflow/workflow-engine.js';
import type { WorkflowSnapshot } from '../workflow/states.js';
import type { WorkflowEvent } from '../workflow/transitions.js';
import { WorkerHeartbeatMonitor } from './worker-heartbeat.js';
import {
  WorkerStartGateVerifier,
  type WorkerStartGateRefs,
} from './worker-start-gate-verifier.js';
import {
  encodeWorkerIpcMessage,
  isTerminalOrRunStateEvent,
  parseWorkerIpcMessage,
  redactBoundedError,
  truncateDisplayText,
  type StartRunMessage,
  type WorkerFailedMessage,
  type WorkerToMainMessage,
  MAX_WORKER_IPC_MESSAGE_BYTES,
} from './worker-protocol.js';
import type {
  AgentWorkerData,
  WorkerFakeProcessPlan,
} from './agent-worker.js';

const WORKER_ENTRY = fileURLToPath(new URL('./agent-worker.ts', import.meta.url));

export type WorkerSessionState =
  | 'idle'
  | 'running'
  | 'failed'
  | 'exited'
  | 'terminated';

export interface NormalizedWorkerEvent {
  readonly attemptId: AttemptId;
  readonly event: AgentEvent;
  readonly displayPriority: 'low' | 'normal' | 'high';
  readonly dropped?: boolean;
  readonly truncated?: boolean;
}

/**
 * Typed, single-use reconcile authorization for starting a replacement Worker.
 * Bound to the failed attempt identity and the only safe next attempt id.
 */
export interface WorkerReplacementAuthorization {
  readonly kind: 'worker_replacement';
  readonly decisionId: string;
  readonly taskId: TaskId;
  readonly failedAttemptId: AttemptId;
  readonly failedGeneration: number;
  readonly nextAttemptId: AttemptId;
  readonly reasonCode: string;
}

export interface AgentWorkerManagerOptions {
  readonly database: DatabaseSync;
  readonly log: JsonlLog;
  readonly taskId: TaskId;
  readonly redactor?: Redactor;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly maxQueuedLowPriorityEvents?: number;
  readonly maxIpcMessageBytes?: number;
  readonly workerEntryPath?: string;
  readonly execArgv?: readonly string[];
  readonly now?: () => Date;
  readonly onNormalizedEvent?: (event: NormalizedWorkerEvent) => void;
  readonly onWorkerFailed?: (failure: WorkerFailedMessage) => void;
  readonly onRunExited?: (payload: {
    readonly attemptId: AttemptId;
    readonly status: 'succeeded' | 'failed' | 'timed_out' | 'stopped';
    readonly exitCode?: number | null;
    readonly signal?: string | null;
    readonly endedAt?: string;
  }) => void;
}

/**
 * Identifiers-only start gate. Manager verifies real GuardDecision /
 * BudgetRepository rows and matrix records — never caller-claimed booleans.
 */
export type WorkerStartGateInput = WorkerStartGateRefs;

export interface StartWorkerRunInput {
  readonly attemptId: AttemptId;
  readonly role: AgentRole;
  readonly agentKind: AgentKind;
  readonly projectRoot: string;
  readonly prompt: string;
  readonly baselineId: string;
  readonly requirementVersion: number;
  readonly timeoutMs?: number;
  readonly conversationId?: string;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly useCrashingParser?: boolean;
  readonly crashingParserPath?: string;
  readonly fakePlans?: readonly WorkerFakeProcessPlan[];
  readonly pid?: number;
  /** Task 12: bind Worker ProcessSupervisorPort to real ProcessHost. */
  readonly supervisorMode?: 'fake' | 'inject' | 'process_host';
  readonly processHostPath?: string;
  /**
   * Task 13: identifiers for capability key + guard decision + budget reservation.
   * Required before any Worker / ProcessHost launch. Fail closed when absent.
   */
  readonly startGate: WorkerStartGateInput;
  /** Optional clock override for gate expiry checks (tests). */
  readonly startGateNowMs?: number;
  /**
   * Bound into the opaque one-time launch authorization issued after gate
   * success. Defaults are fail-closed-safe for isolation tests.
   */
  readonly schemaPath?: string;
  readonly nonGit?: boolean;
  readonly mode?: string;
}

export interface WorkerSessionSnapshot {
  readonly workerId: string;
  readonly state: WorkerSessionState;
  readonly attemptId?: AttemptId;
  readonly generation: number;
  readonly failurePersisted: boolean;
  readonly replacementAllowed: boolean;
  /** Verified start-gate references retained after a successful launch. */
  readonly startGate?: WorkerStartGateRecord;
  /** Opaque one-time launch authorization id issued for this run. */
  readonly launchAuthorizationId?: string;
}

export class WorkerStartPrerequisitesError extends Error {
  readonly missing: readonly WorkerStartMissingPrerequisite[];
  readonly capabilityKey?: CompatibilityKey;

  public constructor(
    message: string,
    missing: readonly WorkerStartMissingPrerequisite[],
    capabilityKey?: CompatibilityKey,
  ) {
    super(message);
    this.name = 'WorkerStartPrerequisitesError';
    this.missing = missing;
    if (capabilityKey !== undefined) {
      this.capabilityKey = capabilityKey;
    }
  }
}

interface Session {
  workerId: string;
  worker: Worker | undefined;
  state: WorkerSessionState;
  attemptId: AttemptId | undefined;
  generation: number;
  heartbeat: WorkerHeartbeatMonitor | undefined;
  lowPriorityQueue: NormalizedWorkerEvent[];
  droppedLowPriority: number;
  failurePersisted: boolean;
  messageHandler: ((raw: unknown) => void) | undefined;
  errorHandler: ((error: Error) => void) | undefined;
  exitHandler: ((code: number) => void) | undefined;
  activeAttempt: ActiveRunAttempt | undefined;
  startGate: WorkerStartGateRecord | undefined;
  launchAuthorizationId: string | undefined;
}

interface PendingReplacementAuthorization {
  readonly authorization: WorkerReplacementAuthorization;
  readonly consumed: boolean;
}

/**
 * Main-process manager for isolated Agent Workers.
 *
 * Lifecycle guarantees:
 * - Worker crash/heartbeat timeout marks the RunAttempt failed and moves the
 *   task to a recoverable workflow state (`interrupted_needs_inspection`).
 * - No automatic fresh Worker is created for an unresolved active run.
 * - Replacement requires an explicit {@link allowReplacementAfterReconcile}.
 * - Stale messages from a previous generation are ignored.
 * - Backpressure may drop/truncate only low-priority partial output.
 * - Raw durable JSONL retains evidence independently of display events.
 */
export class AgentWorkerManager {
  readonly #database: DatabaseSync;
  readonly #log: JsonlLog;
  readonly #taskId: TaskId;
  readonly #redactor: Redactor;
  readonly #attempts: AttemptRepository;
  readonly #tasks: TaskRepository;
  readonly #actions: ActionRepository;
  readonly #startGateVerifier: WorkerStartGateVerifier;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatTimeoutMs: number;
  readonly #maxQueuedLowPriorityEvents: number;
  readonly #maxIpcMessageBytes: number;
  readonly #workerEntryPath: string;
  readonly #execArgv: readonly string[];
  readonly #now: () => Date;
  readonly #onNormalizedEvent?: (event: NormalizedWorkerEvent) => void;
  readonly #onWorkerFailed?: (failure: WorkerFailedMessage) => void;
  readonly #onRunExited?: (payload: {
    readonly attemptId: AttemptId;
    readonly status: 'succeeded' | 'failed' | 'timed_out' | 'stopped';
    readonly exitCode?: number | null;
    readonly signal?: string | null;
    readonly endedAt?: string;
  }) => void;
  #session: Session | undefined;
  #pendingReplacement: PendingReplacementAuthorization | undefined;
  readonly #consumedDecisionIds = new Set<string>();
  #closed = false;
  readonly #receivedEvents: NormalizedWorkerEvent[] = [];
  #mainAlive = true;
  /** Process-event observers (Budget proxy / workflow) — never drop terminal events. */
  readonly #processEventObservers = new Set<
    (attemptId: AttemptId, event: AgentEvent) => void
  >();

  public constructor(options: AgentWorkerManagerOptions) {
    this.#database = options.database;
    this.#log = options.log;
    this.#taskId = options.taskId;
    this.#redactor = options.redactor ?? new Redactor();
    this.#attempts = new AttemptRepository(options.database);
    this.#tasks = new TaskRepository(options.database);
    this.#actions = new ActionRepository(options.database);
    this.#startGateVerifier = new WorkerStartGateVerifier(options.database);
    this.#heartbeatIntervalMs = options.heartbeatIntervalMs ?? 200;
    this.#heartbeatTimeoutMs = options.heartbeatTimeoutMs
      ?? this.#heartbeatIntervalMs * 5;
    this.#maxQueuedLowPriorityEvents = options.maxQueuedLowPriorityEvents ?? 32;
    this.#maxIpcMessageBytes = options.maxIpcMessageBytes
      ?? MAX_WORKER_IPC_MESSAGE_BYTES;
    this.#workerEntryPath = options.workerEntryPath ?? WORKER_ENTRY;
    this.#execArgv = options.execArgv ?? ['--import', 'tsx'];
    this.#now = options.now ?? (() => new Date());
    this.#onNormalizedEvent = options.onNormalizedEvent;
    this.#onWorkerFailed = options.onWorkerFailed;
    this.#onRunExited = options.onRunExited;
  }

  public get mainProcessAlive(): boolean {
    return this.#mainAlive;
  }

  public get receivedEvents(): readonly NormalizedWorkerEvent[] {
    return this.#receivedEvents;
  }

  public get droppedLowPriorityCount(): number {
    return this.#session?.droppedLowPriority ?? 0;
  }

  /**
   * Observe process-related agent events (cleanup_*, process_exited, …)
   * for main-process ports such as {@link WorkerProcessSupervisorProxy}.
   * Terminal / run-state events are never dropped by backpressure.
   */
  public addProcessEventObserver(
    observer: (attemptId: AttemptId, event: AgentEvent) => void,
  ): () => void {
    this.#processEventObservers.add(observer);
    return () => {
      this.#processEventObservers.delete(observer);
    };
  }

  public snapshot(): WorkerSessionSnapshot | undefined {
    if (this.#session === undefined) return undefined;
    return {
      workerId: this.#session.workerId,
      state: this.#session.state,
      ...(this.#session.attemptId === undefined
        ? {}
        : { attemptId: this.#session.attemptId }),
      generation: this.#session.generation,
      failurePersisted: this.#session.failurePersisted,
      replacementAllowed: this.#isReplacementAuthorized(),
      ...(this.#session.startGate === undefined
        ? {}
        : { startGate: this.#session.startGate }),
      ...(this.#session.launchAuthorizationId === undefined
        ? {}
        : { launchAuthorizationId: this.#session.launchAuthorizationId }),
    };
  }

  /**
   * Test seam: inject a hostile/malformed worker IPC payload into the same
   * listener path used by real Worker messages.
   */
  public handleWorkerIpcForTests(raw: unknown): void {
    const session = this.#session;
    if (session === undefined) {
      throw new Error('no active worker session for IPC injection');
    }
    this.#onWorkerMessage(session, raw);
  }

  /**
   * Explicit typed reconcile authorization. Without this, a failed session
   * cannot spawn a replacement Worker (never silently replay non-idempotent work).
   * Authorization is single-use and bound to task/attempt/generation/nextAttempt.
   */
  public allowReplacementAfterReconcile(
    authorization: WorkerReplacementAuthorization,
  ): void {
    this.#assertValidReplacementAuthorization(authorization);

    const session = this.#session;
    if (session === undefined) {
      throw new Error(
        'worker replacement authorization denied: no failed session to authorize',
      );
    }
    if (session.state === 'running') {
      throw new Error(
        'worker replacement authorization denied: session is still running/healthy',
      );
    }
    if (session.state !== 'failed' || !session.failurePersisted) {
      throw new Error(
        'worker replacement authorization denied: durable worker failure required first',
      );
    }
    if (session.attemptId !== authorization.failedAttemptId) {
      throw new Error(
        'worker replacement authorization denied: failed attempt mismatch',
      );
    }
    if (session.generation !== authorization.failedGeneration) {
      throw new Error(
        'worker replacement authorization denied: generation mismatch',
      );
    }
    if (this.#consumedDecisionIds.has(authorization.decisionId)) {
      throw new Error(
        'worker replacement authorization denied: decision already consumed/stale',
      );
    }

    // Recoverable task state is required (attempt cleared by failure path).
    const task = this.#tasks.get(this.#taskId);
    if (task === undefined) {
      throw new Error(
        'worker replacement authorization denied: task missing',
      );
    }
    if (
      task.workflowSnapshot.state !== 'interrupted_needs_inspection'
      && task.workflowSnapshot.state !== 'awaiting_user'
    ) {
      throw new Error(
        'worker replacement authorization denied: task is not in a recoverable state',
      );
    }

    this.#pendingReplacement = {
      authorization,
      consumed: false,
    };
    void this.#log.append({
      taskId: this.#taskId,
      stream: 'system',
      eventType: 'worker_replacement_authorized',
      payload: {
        decisionId: authorization.decisionId,
        kind: authorization.kind,
        failedAttemptId: authorization.failedAttemptId,
        failedGeneration: authorization.failedGeneration,
        nextAttemptId: authorization.nextAttemptId,
        reasonCode: authorization.reasonCode,
        previousWorkerId: session.workerId,
      },
      display: { priority: 'high' },
    });
  }

  public async startRun(input: StartWorkerRunInput): Promise<WorkerSessionSnapshot> {
    if (this.#closed) {
      throw new Error('AgentWorkerManager is closed');
    }

    // Mandatory fail-closed gate BEFORE any Worker / ProcessHost launch.
    // Issues opaque one-time launchAuthorizationId after evidence consume.
    const authorized = this.#evaluateStartGate(input);
    const verifiedGate = authorized.gate;

    const existing = this.#session;
    if (existing !== undefined && existing.state === 'running') {
      throw new Error(
        'refusing to start a fresh Worker for an unresolved active run; '
          + 'session is still running',
      );
    }
    if (existing !== undefined && existing.state === 'failed') {
      if (!this.#isReplacementAuthorized()) {
        throw new Error(
          'refusing to start a fresh Worker for an unresolved active run; '
            + 'reconcile must authorize replacement first',
        );
      }
      const auth = this.#pendingReplacement!.authorization;
      if (input.attemptId !== auth.nextAttemptId) {
        throw new Error(
          'worker replacement denied: nextAttemptId mismatch with authorization',
        );
      }
    }

    // Tear down previous session only when replacement was explicitly authorized
    // or the previous session fully exited cleanly.
    const previousGeneration = existing?.generation ?? 0;
    if (existing !== undefined) {
      if (existing.state === 'failed' && !this.#isReplacementAuthorized()) {
        throw new Error(
          'worker replacement denied until explicit safe reconcile decision',
        );
      }
      await this.#terminateSession(existing, 'replaced');
    }

    // Consume single-use authorization at the point of starting a replacement.
    if (this.#pendingReplacement !== undefined) {
      this.#consumedDecisionIds.add(this.#pendingReplacement.authorization.decisionId);
      this.#pendingReplacement = undefined;
    }

    const workerId = `worker-${randomUUID()}`;
    const generation = previousGeneration + 1;
    const attemptId = input.attemptId;

    const pending = this.#ensurePendingAttempt(input);
    const processStartedAt = this.#now().toISOString();
    const pid = input.pid ?? 42_001;
    const active = activateRunAttempt(pending, {
      role: input.role,
      pid,
      processStartedAt,
    });
    this.#attempts.markActive(attemptId, {
      role: input.role,
      pid,
      processStartedAt,
    });

    const workerData: AgentWorkerData = {
      workerId,
      heartbeatIntervalMs: this.#heartbeatIntervalMs,
      ...(input.useCrashingParser === true
        ? {
            useCrashingParser: true,
            crashingParserPath: input.crashingParserPath,
          }
        : {}),
      ...(input.fakePlans === undefined ? {} : { fakePlans: input.fakePlans }),
    };

    const worker = new Worker(this.#workerEntryPath, {
      workerData,
      execArgv: [...this.#execArgv],
    });

    const session: Session = {
      workerId,
      worker,
      state: 'running',
      attemptId,
      generation,
      heartbeat: undefined,
      lowPriorityQueue: [],
      droppedLowPriority: 0,
      failurePersisted: false,
      messageHandler: undefined,
      errorHandler: undefined,
      exitHandler: undefined,
      activeAttempt: active,
      startGate: verifiedGate,
      launchAuthorizationId: authorized.launchAuthorizationId,
    };
    this.#session = session;

    session.heartbeat = new WorkerHeartbeatMonitor({
      intervalMs: this.#heartbeatIntervalMs,
      timeoutMs: this.#heartbeatTimeoutMs,
      now: () => this.#now().getTime(),
      onTimeout: () => {
        void this.#handleHeartbeatTimeout(session);
      },
    });
    session.heartbeat.startWatching();

    session.messageHandler = (raw: unknown) => {
      try {
        this.#onWorkerMessage(session, raw);
      } catch (error) {
        // Absolute last line of defense: never throw into the Worker message loop.
        void this.#handleWorkerFailure(session, {
          type: 'worker_failed',
          workerId: session.workerId,
          attemptId: session.attemptId,
          reasonCode: 'protocol_violation',
          message: redactBoundedError(error, this.#redactor),
          occurredAt: this.#now().toISOString(),
          fatal: true,
        });
      }
    };
    session.errorHandler = (error: Error) => {
      void this.#handleWorkerFailure(session, {
        type: 'worker_failed',
        workerId: session.workerId,
        attemptId: session.attemptId,
        reasonCode: 'unhandled_error',
        message: redactBoundedError(error, this.#redactor),
        occurredAt: this.#now().toISOString(),
        fatal: true,
      });
    };
    session.exitHandler = (code: number) => {
      if (session.state === 'running') {
        void this.#handleWorkerFailure(session, {
          type: 'worker_failed',
          workerId: session.workerId,
          attemptId: session.attemptId,
          reasonCode: 'crash',
          message: `worker exited unexpectedly with code ${String(code)}`,
          occurredAt: this.#now().toISOString(),
          fatal: true,
        });
      }
    };
    worker.on('message', session.messageHandler);
    worker.on('error', session.errorHandler);
    worker.on('exit', session.exitHandler);

    const startMessage: StartRunMessage = {
      type: 'start_run',
      attemptId,
      taskId: this.#taskId,
      role: input.role,
      agentKind: input.agentKind,
      projectRoot: input.projectRoot,
      prompt: input.prompt,
      baselineId: input.baselineId,
      requirementVersion: input.requirementVersion,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.conversationId === undefined
        ? {}
        : { conversationId: input.conversationId }),
      executable: input.executable ?? process.execPath,
      args: [...(input.args ?? [])],
      ...(input.environment === undefined
        ? {}
        : { environment: { ...input.environment } }),
      supervisorMode: input.supervisorMode ?? 'fake',
      ...(input.processHostPath === undefined
        ? {}
        : { processHostPath: input.processHostPath }),
      ...(input.useCrashingParser === true ? { useCrashingParser: true } : {}),
      // Opaque one-time id only — never the forgeable gate record.
      launchAuthorizationId: authorized.launchAuthorizationId,
    };
    this.#postToWorker(session, startMessage);

    await this.#log.append({
      taskId: this.#taskId,
      attemptId,
      stream: 'system',
      eventType: 'worker_start_run',
      payload: {
        workerId,
        generation,
        role: input.role,
        agentKind: input.agentKind,
        capabilityKey: verifiedGate.capabilityKey,
        projectGuardDecisionId: verifiedGate.projectGuardDecisionId,
        projectGuardMode: verifiedGate.projectGuardMode,
        reservedBudgetId: verifiedGate.reservedBudgetId,
        budgetCanLaunch: verifiedGate.budgetCanLaunch,
        authStatus: verifiedGate.authStatus,
        requiresReadinessProbe: verifiedGate.requiresReadinessProbe,
        readinessProbeCompleted: verifiedGate.readinessProbeCompleted,
      },
      display: { priority: 'high' },
    });

    return this.snapshot()!;
  }

  /**
   * Fail-closed evaluation of Task 13 start prerequisites against real stores.
   * Issues a durable opaque launchAuthorizationId after validate+consume.
   * Must run before any Worker thread or ProcessHost is created.
   */
  #evaluateStartGate(input: StartWorkerRunInput): {
    readonly gate: WorkerStartGateRecord;
    readonly launchAuthorizationId: string;
  } {
    const gate = input.startGate;
    if (gate === undefined || gate === null || typeof gate !== 'object') {
      throw new WorkerStartPrerequisitesError(
        'worker start denied: startGate prerequisites missing '
          + '(verified capability key, ProjectGuard decision id, Budget reservation id required)',
        Object.freeze([
          'verified_capability_record',
          'project_guard_decision',
          'budget_can_launch',
          'reserved_budget',
        ] as WorkerStartMissingPrerequisite[]),
      );
    }

    // Reject legacy caller-claimed truth booleans / fabricated records.
    const legacy = gate as unknown as Record<string, unknown>;
    if (
      'capabilityRecord' in legacy
      || 'budgetCanLaunch' in legacy
      || 'projectGuardMode' in legacy
      || 'authStatus' in legacy
      || 'requiresReadinessProbe' in legacy
      || 'readinessProbeCompleted' in legacy
    ) {
      throw new WorkerStartPrerequisitesError(
        'worker start denied: startGate must supply identifiers only '
          + '(capabilityKey, projectGuardDecisionId, reservedBudgetId, '
          + 'healthEvidenceId, readinessEvidenceId); '
          + 'caller-claimed auth/readiness/budget booleans are rejected',
        Object.freeze([
          'verified_capability_record',
          'project_guard_decision',
          'budget_can_launch',
          'authenticated',
          'readiness_probe',
        ] as WorkerStartMissingPrerequisite[]),
      );
    }

    const schemaPath = input.schemaPath
      ?? resolvePackageResourcePath(
        'schemas/agent-result.schema.json',
        import.meta.url,
      );
    const nonGit = input.nonGit ?? false;
    const mode = input.mode ?? 'project_write';

    const result = this.#startGateVerifier.authorizeForLaunch({
      taskId: this.#taskId,
      attemptId: input.attemptId,
      role: input.role,
      agentKind: input.agentKind,
      refs: gate,
      schemaPath,
      nonGit,
      mode,
      ...(input.startGateNowMs === undefined
        ? {}
        : { nowMs: input.startGateNowMs }),
    });

    if (!result.allowed) {
      throw new WorkerStartPrerequisitesError(
        `worker start denied: missing prerequisites [${result.missing.join(', ')}]`,
        result.missing,
        result.capabilityKey,
      );
    }

    return {
      gate: result.gate,
      launchAuthorizationId: result.launchAuthorizationId,
    };
  }

  public async stopRun(
    attemptId: AttemptId,
    mode: 'graceful' | 'force' = 'graceful',
  ): Promise<void> {
    const session = this.#session;
    if (session === undefined || session.attemptId !== attemptId) return;
    this.#postToWorker(session, {
      type: 'stop_run',
      attemptId,
      mode,
    });
  }

  public async deliverMessage(
    attemptId: AttemptId,
    sequence: number,
    content: string,
  ): Promise<void> {
    const session = this.#session;
    if (session === undefined || session.attemptId !== attemptId) {
      throw new Error('deliver_message targets a non-active attempt');
    }
    this.#postToWorker(session, {
      type: 'deliver_message',
      attemptId,
      sequence,
      content,
    });
  }

  public async close(): Promise<void> {
    this.#closed = true;
    if (this.#session !== undefined) {
      await this.#terminateSession(this.#session, 'closed');
      this.#session = undefined;
    }
  }

  #ensurePendingAttempt(input: StartWorkerRunInput): PendingRunAttempt {
    const existing = this.#attempts.get(input.attemptId);
    if (existing !== undefined) {
      if (existing.status === 'pending') return existing;
      if (existing.status === 'active') {
        throw new Error(
          `attempt ${input.attemptId} is already active; refuse silent replay`,
        );
      }
      throw new Error(
        `attempt ${input.attemptId} is already completed; refuse silent replay`,
      );
    }
    const pending = createPendingRunAttempt({
      attemptId: input.attemptId,
      startedAt: this.#now().toISOString(),
      baselineId: asBaselineId(input.baselineId),
      requirementVersion: input.requirementVersion,
    });
    this.#attempts.create(this.#taskId, pending);
    return pending;
  }

  #postToWorker(
    session: Session,
    message: Parameters<typeof encodeWorkerIpcMessage>[0],
  ): void {
    if (session.worker === undefined) return;
    const encoded = encodeWorkerIpcMessage(message, this.#maxIpcMessageBytes);
    session.worker.postMessage(encoded);
  }

  #isReplacementAuthorized(): boolean {
    return (
      this.#pendingReplacement !== undefined
      && !this.#pendingReplacement.consumed
    );
  }

  #assertValidReplacementAuthorization(
    authorization: WorkerReplacementAuthorization,
  ): void {
    if (authorization === null || typeof authorization !== 'object') {
      throw new Error(
        'worker replacement authorization denied: typed decision object required',
      );
    }
    if (authorization.kind !== 'worker_replacement') {
      throw new Error(
        'worker replacement authorization denied: kind must be worker_replacement',
      );
    }
    if (
      typeof authorization.decisionId !== 'string'
      || authorization.decisionId.trim() === ''
    ) {
      throw new Error(
        'worker replacement authorization denied: decisionId required',
      );
    }
    if (authorization.taskId !== this.#taskId) {
      throw new Error(
        'worker replacement authorization denied: task mismatch',
      );
    }
    if (
      typeof authorization.failedAttemptId !== 'string'
      || authorization.failedAttemptId.trim() === ''
    ) {
      throw new Error(
        'worker replacement authorization denied: failedAttemptId required',
      );
    }
    if (
      !Number.isSafeInteger(authorization.failedGeneration)
      || authorization.failedGeneration < 1
    ) {
      throw new Error(
        'worker replacement authorization denied: failedGeneration required',
      );
    }
    if (
      typeof authorization.nextAttemptId !== 'string'
      || authorization.nextAttemptId.trim() === ''
    ) {
      throw new Error(
        'worker replacement authorization denied: nextAttemptId required',
      );
    }
    if (authorization.nextAttemptId === authorization.failedAttemptId) {
      throw new Error(
        'worker replacement authorization denied: nextAttemptId must differ from failed attempt',
      );
    }
    if (
      typeof authorization.reasonCode !== 'string'
      || authorization.reasonCode.trim() === ''
    ) {
      throw new Error(
        'worker replacement authorization denied: reasonCode required',
      );
    }
  }

  #onWorkerMessage(session: Session, raw: unknown): void {
    try {
      // Generation fence: ignore messages after session was replaced/terminated.
      if (this.#session !== session) return;
      if (session.state === 'terminated') return;

      let parsed: ReturnType<typeof parseWorkerIpcMessage>;
      try {
        parsed = parseWorkerIpcMessage(raw, 'worker_to_main', {
          maxBytes: this.#maxIpcMessageBytes,
          redactor: this.#redactor,
        });
      } catch (error) {
        void this.#handleWorkerFailure(session, {
          type: 'worker_failed',
          workerId: session.workerId,
          attemptId: session.attemptId,
          reasonCode: 'protocol_violation',
          message: redactBoundedError(error, this.#redactor),
          occurredAt: this.#now().toISOString(),
          fatal: true,
        });
        return;
      }

      if (!parsed.ok) {
        void this.#handleWorkerFailure(session, {
          type: 'worker_failed',
          workerId: session.workerId,
          attemptId: session.attemptId,
          reasonCode: parsed.reasonCode === 'oversized_message'
            ? 'oversized_message'
            : 'protocol_violation',
          message: parsed.message,
          occurredAt: this.#now().toISOString(),
          fatal: true,
        });
        return;
      }

      const message = parsed.message as WorkerToMainMessage;

      // Stale attempt fence: drop messages that do not match the active attempt.
      if (
        'attemptId' in message
        && message.attemptId !== undefined
        && session.attemptId !== undefined
        && message.attemptId !== session.attemptId
      ) {
        void this.#log.append({
          taskId: this.#taskId,
          attemptId: session.attemptId,
          stream: 'system',
          eventType: 'worker_stale_message_dropped',
          payload: {
            workerId: session.workerId,
            generation: session.generation,
            staleAttemptId: message.attemptId,
            messageType: message.type,
          },
          display: { priority: 'normal' },
        });
        return;
      }

      switch (message.type) {
        case 'heartbeat':
          session.heartbeat?.noteBeat(message.sequence, message.sentAt);
          return;
        case 'raw_output':
          void this.#handleRawOutput(session, message);
          return;
        case 'event':
          void this.#handleEvent(
            session,
            message.attemptId,
            message.event,
            message.displayPriority,
          );
          return;
        case 'run_exited':
          void this.#handleRunExited(session, message);
          return;
        case 'worker_failed':
          void this.#handleWorkerFailure(session, message);
          return;
      }
    } catch (error) {
      // Never let parser/handler exceptions crash the main process.
      void this.#handleWorkerFailure(session, {
        type: 'worker_failed',
        workerId: session.workerId,
        attemptId: session.attemptId,
        reasonCode: 'protocol_violation',
        message: redactBoundedError(error, this.#redactor),
        occurredAt: this.#now().toISOString(),
        fatal: true,
      });
    }
  }

  async #handleRawOutput(
    session: Session,
    message: Extract<WorkerToMainMessage, { type: 'raw_output' }>,
  ): Promise<void> {
    if (this.#session !== session) return;
    if (session.attemptId !== undefined && message.attemptId !== session.attemptId) {
      return;
    }
    const truncated = truncateDisplayText(message.chunk);
    // Redact before durable write; retain attempt identity for evidence.
    const redacted = this.#redactor.redact({
      stream: message.stream,
      chunk: truncated.text,
      truncated: truncated.truncated,
      occurredAt: message.occurredAt,
      workerId: session.workerId,
      generation: session.generation,
    });
    await this.#log.append({
      taskId: this.#taskId,
      attemptId: message.attemptId,
      stream: message.stream,
      eventType: 'worker_raw_output',
      payload: redacted.value,
      display: { priority: 'low' },
    });
  }

  async #handleEvent(
    session: Session,
    attemptId: AttemptId,
    event: AgentEvent,
    displayPriority: 'low' | 'normal' | 'high',
  ): Promise<void> {
    // Always retain raw durable evidence first (Task 6 JSONL), independent of
    // display backpressure.
    const rawPayload = this.#redactor.redact({
      eventType: event.type,
      event,
    });
    await this.#log.append({
      taskId: this.#taskId,
      attemptId,
      stream: event.type === 'stderr' ? 'stderr' : 'stdout',
      eventType: `worker_event_${event.type}`,
      payload: rawPayload.value,
      display: { priority: displayPriority },
    });

    let normalizedEvent = event;
    let truncated = false;
    if (event.type === 'output') {
      const result = truncateDisplayText(event.text);
      truncated = result.truncated;
      normalizedEvent = { ...event, text: result.text };
    } else if (event.type === 'stderr') {
      const result = truncateDisplayText(event.chunk);
      truncated = result.truncated;
      normalizedEvent = { ...event, chunk: result.text };
    }

    const normalized: NormalizedWorkerEvent = {
      attemptId,
      event: normalizedEvent,
      displayPriority,
      ...(truncated ? { truncated: true } : {}),
    };

    if (displayPriority === 'low' && !isTerminalOrRunStateEvent(event)) {
      if (session.lowPriorityQueue.length >= this.#maxQueuedLowPriorityEvents) {
        session.droppedLowPriority += 1;
        session.lowPriorityQueue.shift();
        const dropped: NormalizedWorkerEvent = {
          ...normalized,
          dropped: true,
        };
        // Still notify observers that a drop happened, but do not retain body.
        this.#receivedEvents.push({
          attemptId,
          event: {
            type: 'output',
            attemptId,
            text: '[dropped under backpressure]',
          },
          displayPriority: 'low',
          dropped: true,
        });
        this.#onNormalizedEvent?.(dropped);
        return;
      }
      session.lowPriorityQueue.push(normalized);
    }

    // Terminal / run-state / error events are never dropped.
    this.#receivedEvents.push(normalized);
    this.#onNormalizedEvent?.(normalized);
    for (const observer of this.#processEventObservers) {
      try {
        observer(attemptId, normalizedEvent);
      } catch {
        // Observer failures must not corrupt worker session state.
      }
    }
  }

  async #handleRunExited(
    session: Session,
    message: Extract<WorkerToMainMessage, { type: 'run_exited' }>,
  ): Promise<void> {
    if (session.state !== 'running' && session.state !== 'failed') return;
    if (session.attemptId !== message.attemptId) return;

    const exitReason = message.status === 'succeeded'
      ? 'completed'
      : message.status === 'timed_out'
        ? 'timed_out'
        : message.status === 'stopped'
          ? 'cancelled'
          : 'failed';

    if (session.activeAttempt !== undefined) {
      const completed = completeRunAttempt(session.activeAttempt, {
        endedAt: message.endedAt,
        exitReason,
      });
      try {
        this.#attempts.markCompleted(message.attemptId, {
          endedAt: completed.endedAt,
          exitReason: completed.exitReason,
        });
      } catch {
        // Attempt may already be marked failed by worker_failed path.
      }
    }

    session.state = message.status === 'succeeded' ? 'exited' : 'failed';
    session.heartbeat?.stop();

    await this.#log.append({
      taskId: this.#taskId,
      attemptId: message.attemptId,
      stream: 'system',
      eventType: 'worker_run_exited',
      payload: {
        status: message.status,
        exitCode: message.exitCode,
        signal: message.signal,
        error: message.error ?? null,
      },
      display: { priority: 'high' },
    });

    this.#onRunExited?.({
      attemptId: message.attemptId,
      status: message.status,
      exitCode: message.exitCode,
      signal: message.signal,
      endedAt: message.endedAt,
    });
  }

  async #handleHeartbeatTimeout(session: Session): Promise<void> {
    if (this.#session !== session || session.state !== 'running') return;
    await this.#handleWorkerFailure(session, {
      type: 'worker_failed',
      workerId: session.workerId,
      attemptId: session.attemptId,
      reasonCode: 'heartbeat_timeout',
      message: 'worker heartbeat timed out',
      occurredAt: this.#now().toISOString(),
      fatal: true,
    });
  }

  async #handleWorkerFailure(
    session: Session,
    failure: WorkerFailedMessage,
  ): Promise<void> {
    if (this.#session !== session) return;
    if (session.failurePersisted) {
      // Still surface but do not double-write durable failure.
      this.#onWorkerFailed?.(failure);
      return;
    }
    session.failurePersisted = true;
    session.state = 'failed';
    session.heartbeat?.stop();

    const attemptId = failure.attemptId ?? session.attemptId;
    const endedAt = failure.occurredAt;

    await this.#log.append({
      taskId: this.#taskId,
      ...(attemptId === undefined ? {} : { attemptId }),
      stream: 'system',
      eventType: 'worker_failed',
      payload: {
        workerId: failure.workerId,
        reasonCode: failure.reasonCode,
        message: this.#redactor.redact(failure.message).value,
        fatal: failure.fatal,
        generation: session.generation,
      },
      display: { priority: 'high' },
    });

    if (attemptId !== undefined && session.activeAttempt !== undefined) {
      try {
        this.#attempts.markCompleted(attemptId, {
          endedAt,
          exitReason: 'failed',
        });
      } catch {
        // Already completed.
      }
    }

    // Move task to safe recoverable state; never auto-replay.
    this.#moveTaskToRecoverableState(attemptId, failure.message);

    // Persist a never-auto-replay action intent for reconcile.
    const actionId = `worker-fail-${session.workerId}`;
    try {
      this.#actions.recordIntent({
        actionId,
        taskId: this.#taskId,
        idempotencyKey: `worker_failed:${session.workerId}:${attemptId ?? 'none'}`,
        type: 'worker_failed',
        payload: {
          schemaVersion: 1,
          workerId: session.workerId,
          attemptId: attemptId ?? null,
          reasonCode: failure.reasonCode,
          replayPolicy: 'never-auto-replay',
        },
      });
      this.#actions.markFailed(actionId, { error: failure.message });
    } catch {
      // Action may already exist on retry of failure handler.
    }

    this.#onWorkerFailed?.(failure);

    // Clean terminate without spawning a replacement.
    await this.#terminateSession(session, 'failed');
  }

  #moveTaskToRecoverableState(
    attemptId: AttemptId | undefined,
    reason: string,
  ): void {
    const task = this.#tasks.get(this.#taskId);
    if (task === undefined) return;
    const snapshot = task.workflowSnapshot;
    if (
      snapshot.state !== 'implementing'
      && snapshot.state !== 'planning'
      && snapshot.state !== 'reviewing'
      && snapshot.state !== 'master_validation'
    ) {
      // Already in a non-running state; leave as-is.
      return;
    }
    if (
      attemptId === undefined
      || snapshot.activeAttemptId === undefined
      || snapshot.activeAttemptId !== attemptId
    ) {
      return;
    }

    const event = this.#failureWorkflowEvent(snapshot, attemptId, reason);
    if (event === undefined) return;
    const result = transition(snapshot, event);
    if (result.kind !== 'transitioned') return;
    const next = result as Transitioned;
    this.#tasks.updateWorkflow(this.#taskId, {
      workflowSnapshot: {
        state: next.state,
        taskId: next.taskId,
        requirementVersion: next.requirementVersion,
        reworkCount: next.reworkCount,
        maxReworks: next.maxReworks,
        pauseAfterAttempt: next.pauseAfterAttempt,
        ...(next.resumeTargetState === undefined
          ? {}
          : { resumeTargetState: next.resumeTargetState }),
        ...(next.awaitingReason === undefined
          ? {}
          : { awaitingReason: next.awaitingReason }),
        ...(next.allowedAwaitingActions === undefined
          ? {}
          : { allowedAwaitingActions: next.allowedAwaitingActions }),
        ...(next.inspectionResumeTargetState === undefined
          ? {}
          : {
              inspectionResumeTargetState: next.inspectionResumeTargetState,
            }),
      } as WorkflowSnapshot,
      expectedVersion: task.workflowVersion,
      status: next.state,
    });
  }

  #failureWorkflowEvent(
    snapshot: WorkflowSnapshot,
    attemptId: AttemptId,
    reason: string,
  ): WorkflowEvent | undefined {
    switch (snapshot.state) {
      case 'implementing':
        return {
          type: 'IMPLEMENTATION_FAILED',
          attemptId,
          reason,
        };
      case 'planning':
        return { type: 'PLAN_FAILED', attemptId, reason };
      case 'reviewing':
        return { type: 'REVIEW_FAILED', attemptId, reason };
      case 'master_validation':
        return { type: 'MASTER_FAILED', attemptId, reason };
      default:
        return undefined;
    }
  }

  async #terminateSession(
    session: Session,
    reason: 'replaced' | 'closed' | 'failed',
  ): Promise<void> {
    session.heartbeat?.stop();
    session.heartbeat = undefined;
    const worker = session.worker;
    if (worker !== undefined) {
      if (session.messageHandler !== undefined) {
        worker.off('message', session.messageHandler);
      }
      if (session.errorHandler !== undefined) {
        worker.off('error', session.errorHandler);
      }
      if (session.exitHandler !== undefined) {
        worker.off('exit', session.exitHandler);
      }
      session.messageHandler = undefined;
      session.errorHandler = undefined;
      session.exitHandler = undefined;
      try {
        await worker.terminate();
      } catch {
        // Already dead.
      }
      session.worker = undefined;
    }
    if (reason !== 'failed') {
      session.state = 'terminated';
    }
  }
}

export function resolveCrashingParserFixturePath(
  from: string = fileURLToPath(import.meta.url),
): string {
  // Prefer tests/fixtures path relative to package root.
  const packageRoot = path.resolve(path.dirname(from), '../..');
  return path.join(
    packageRoot,
    'tests',
    'fixtures',
    'workers',
    'crashing-parser.mjs',
  );
}

/** Read-only probe that the main process SQLite writer is still usable. */
export function probeSqliteWritable(database: DatabaseSync): boolean {
  try {
    withTransaction(database, () => {
      database.prepare('SELECT 1 AS ok').get();
    });
    return true;
  } catch {
    return false;
  }
}

export function readJsonlEvidence(
  logPath: string,
): readonly Record<string, unknown>[] {
  const text = readFileSync(logPath, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export { asAttemptId, asTaskId };
