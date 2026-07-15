import { randomUUID } from 'node:crypto';

import type { AttemptId, TaskId } from '../domain/ids.js';
import { ActionRepository } from '../persistence/action-repository.js';
import { AttemptRepository } from '../persistence/attempt-repository.js';
import type { ReadWriteDatabase } from '../persistence/database.js';
import { serializeJsonValue } from '../persistence/json-value.js';
import {
  TaskRepository,
  type PersistedTask,
} from '../persistence/task-repository.js';
import { withTransaction } from '../persistence/transaction.js';
import type {
  ProcessSupervisorPort,
  ProcessWaitResult,
} from '../process/process-supervisor-port.js';
import {
  expectedRoleForExecutionState,
  isSafeExecutionState,
  type PendingResumeAttempt,
  type ResumeTargetState,
  type WorkflowSnapshot,
  type WorkflowState,
} from './states.js';
import { transition } from './workflow-engine.js';

export type PauseIdKind = 'action';

export interface PauseControllerOptions {
  readonly database: ReadWriteDatabase;
  readonly supervisor: ProcessSupervisorPort;
  readonly now?: () => Date;
  readonly idFactory?: (kind: PauseIdKind) => string;
  /**
   * Optional liveness probe. Defaults to supervisor.wait race: if wait is still
   * pending the process is treated as running.
   */
  readonly isProcessRunning?: (
    attemptId: AttemptId,
  ) => boolean | Promise<boolean>;
}

export interface RuntimeView {
  readonly taskId: TaskId;
  readonly workflowState: WorkflowState;
  readonly processRunning: boolean;
  readonly pauseAfterAttempt: boolean;
  readonly paused: boolean;
  readonly resumeTargetState?: ResumeTargetState;
  readonly activeAttemptId?: AttemptId;
}

export type PauseRequestResult = {
  readonly status: 'pause_requested' | 'already_requested';
  readonly processRunning: boolean;
  readonly workflowState: WorkflowState;
  readonly pauseAfterAttempt: boolean;
};

export interface AttemptSettlementInput {
  readonly attemptId: AttemptId;
  readonly normalSuccessor: {
    readonly resumeTargetState: ResumeTargetState;
    readonly pendingResumeAttempt?: PendingResumeAttempt;
    readonly reworkRequest?: WorkflowSnapshot['reworkRequest'];
    readonly awaitingReason?: string;
    readonly allowedAwaitingActions?: WorkflowSnapshot['allowedAwaitingActions'];
    readonly awaitingResumeTargetState?: WorkflowSnapshot['awaitingResumeTargetState'];
    readonly inspectionResumeTargetState?: WorkflowSnapshot['inspectionResumeTargetState'];
  };
}

export type PauseSettlementResult = {
  readonly status: 'paused' | 'already_paused' | 'not_requested' | 'denied';
  readonly workflowState: WorkflowState;
  readonly resumeTargetState?: ResumeTargetState;
  readonly processRunning: boolean;
  readonly reason?: string;
};

export type ResumeResult = {
  readonly status: 'resumed';
  readonly workflowState: WorkflowState;
  readonly resumeTargetState: ResumeTargetState;
};

/**
 * Pause-after-run: request is recorded while the process is still alive.
 * The workflow only enters `paused_after_run` after the attempt settles and the
 * normal successor is stored as `resumeTargetState`. Resume consumes that
 * target exactly once under an idempotent pending action.
 */
export class PauseController {
  readonly #database: ReadWriteDatabase;
  readonly #tasks: TaskRepository;
  readonly #actions: ActionRepository;
  readonly #attempts: AttemptRepository;
  readonly #supervisor: ProcessSupervisorPort;
  readonly #now: () => Date;
  readonly #idFactory: (kind: PauseIdKind) => string;
  readonly #isProcessRunning: (attemptId: AttemptId) => boolean | Promise<boolean>;
  readonly #runningAttempts = new Set<string>();

  public constructor(options: PauseControllerOptions) {
    this.#database = options.database;
    this.#tasks = new TaskRepository(options.database.connection);
    this.#actions = new ActionRepository(options.database.connection);
    this.#attempts = new AttemptRepository(options.database.connection);
    this.#supervisor = options.supervisor;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => randomUUID());
    this.#isProcessRunning =
      options.isProcessRunning
      ?? ((attemptId) => this.#defaultIsRunning(attemptId));
  }

  public async requestPauseAfterRun(taskId: TaskId): Promise<PauseRequestResult> {
    const task = this.#requireTask(taskId);
    if (task.workflowSnapshot.pauseAfterAttempt) {
      const processRunning = await this.#processRunningFor(task);
      return {
        status: 'already_requested',
        processRunning,
        workflowState: task.status,
        pauseAfterAttempt: true,
      };
    }
    const reduced = transition(task.workflowSnapshot, {
      type: 'PAUSE_AFTER_ATTEMPT_REQUESTED',
    });
    if (reduced.kind !== 'transitioned') {
      throw new Error(`cannot request pause: ${reduced.reason}`);
    }
    this.#persistSnapshot(task, reduced, 'PAUSE_AFTER_ATTEMPT_REQUESTED');
    const processRunning = await this.#processRunningFor(
      this.#requireTask(taskId),
    );
    return {
      status: 'pause_requested',
      processRunning,
      workflowState: reduced.state,
      pauseAfterAttempt: true,
    };
  }

  public getRuntimeView(taskId: TaskId): RuntimeView {
    const task = this.#requireTask(taskId);
    const activeAttemptId = task.workflowSnapshot.activeAttemptId;
    const processRunning =
      activeAttemptId !== undefined
      && this.#runningAttempts.has(activeAttemptId);
    // Synchronous view: if we have not tracked wait yet, treat active attempt
    // identity as running until settlement clears it (never claim paused early).
    const inferredRunning =
      processRunning
      || (
        activeAttemptId !== undefined
        && task.status !== 'paused_after_run'
        && isSafeExecutionState(task.status as ResumeTargetState)
      );
    return {
      taskId,
      workflowState: task.status,
      processRunning: inferredRunning && task.status !== 'paused_after_run',
      pauseAfterAttempt: task.workflowSnapshot.pauseAfterAttempt,
      paused: task.status === 'paused_after_run',
      ...(task.workflowSnapshot.resumeTargetState === undefined
        ? {}
        : { resumeTargetState: task.workflowSnapshot.resumeTargetState }),
      ...(activeAttemptId === undefined ? {} : { activeAttemptId }),
    };
  }

  /**
   * Called when the supervised attempt has exited and its result is durable.
   * Stores the normal successor as resume_target_state and enters paused_after_run
   * only when pauseAfterAttempt was requested.
   *
   * Never trusts the caller for liveness: verifies supervisor wait settlement
   * and/or persisted terminal attempt evidence bound to the same launch identity
   * before clearing running state or persisting paused_after_run.
   */
  public async onAttemptSettled(
    taskId: TaskId,
    input: AttemptSettlementInput,
  ): Promise<PauseSettlementResult> {
    const task = this.#requireTask(taskId);
    if (task.status === 'paused_after_run') {
      return {
        status: 'already_paused',
        workflowState: 'paused_after_run',
        resumeTargetState: task.workflowSnapshot.resumeTargetState,
        processRunning: false,
      };
    }
    if (!task.workflowSnapshot.pauseAfterAttempt) {
      return {
        status: 'not_requested',
        workflowState: task.status,
        processRunning: await this.#processRunningFor(task),
      };
    }
    if (task.workflowSnapshot.activeAttemptId !== input.attemptId) {
      throw new Error(
        `settled attempt ${input.attemptId} does not match active attempt`,
      );
    }

    const settlement = await this.#verifyAttemptSettled(taskId, input.attemptId);
    if (!settlement.settled) {
      return {
        status: 'denied',
        workflowState: task.status,
        processRunning: true,
        reason: settlement.reason,
      };
    }

    // Only clear liveness after verified settlement.
    this.#runningAttempts.delete(input.attemptId);

    const successor = input.normalSuccessor;
    const snapshot: WorkflowSnapshot = {
      state: 'paused_after_run',
      taskId: task.taskId,
      requirementVersion: task.workflowSnapshot.requirementVersion,
      reworkCount: task.workflowSnapshot.reworkCount,
      maxReworks: task.workflowSnapshot.maxReworks,
      pauseAfterAttempt: false,
      resumeTargetState: successor.resumeTargetState,
      ...(successor.pendingResumeAttempt === undefined
        ? {}
        : { pendingResumeAttempt: successor.pendingResumeAttempt }),
      ...(successor.reworkRequest === undefined
        ? {}
        : { reworkRequest: successor.reworkRequest }),
      ...(successor.awaitingReason === undefined
        ? {}
        : { awaitingReason: successor.awaitingReason }),
      ...(successor.allowedAwaitingActions === undefined
        ? {}
        : { allowedAwaitingActions: successor.allowedAwaitingActions }),
      ...(successor.awaitingResumeTargetState === undefined
        ? {}
        : { awaitingResumeTargetState: successor.awaitingResumeTargetState }),
      ...(successor.inspectionResumeTargetState === undefined
        ? {}
        : {
            inspectionResumeTargetState: successor.inspectionResumeTargetState,
          }),
    };

    const actionId = this.#idFactory('action');
    const idempotencyKey = `${taskId}:pause-settle:${input.attemptId}`;
    const now = this.#now().toISOString();
    const existing = this.#database.connection
      .prepare(
        `SELECT id, status FROM pending_actions WHERE idempotency_key = ?`,
      )
      .get(idempotencyKey) as
      | { readonly id: string; readonly status: string }
      | undefined;
    if (existing?.status === 'completed') {
      const updated = this.#requireTask(taskId);
      return {
        status: 'already_paused',
        workflowState: updated.status,
        resumeTargetState: updated.workflowSnapshot.resumeTargetState,
        processRunning: false,
      };
    }
    withTransaction(this.#database.connection, () => {
      if (existing === undefined) {
        this.#insertCompletedAction(
          actionId,
          taskId,
          idempotencyKey,
          'pause-settle',
          {
            attemptId: input.attemptId,
            resumeTargetState: successor.resumeTargetState,
          },
          {
            resumeTargetState: successor.resumeTargetState,
            attemptId: input.attemptId,
          },
          now,
        );
      }
      this.#writeSnapshot(task, snapshot, 'ATTEMPT_SETTLED_PAUSE', now);
    });

    const updated = this.#requireTask(taskId);
    return {
      status: 'paused',
      workflowState: updated.status,
      resumeTargetState: updated.workflowSnapshot.resumeTargetState,
      processRunning: false,
    };
  }

  /**
   * Fail-closed settlement proof — BOTH are required:
   * 1) Durable terminal completion for the same attempt/launch identity, AND
   * 2) Positive supervisor settlement / no-liveness evidence (wait resolved).
   * Pending wait, live registered process, identity uncertainty, or disagreement
   * keeps processRunning true and refuses paused_after_run.
   */
  async #verifyAttemptSettled(
    taskId: TaskId,
    attemptId: AttemptId,
  ): Promise<{ readonly settled: true } | { readonly settled: false; readonly reason: string }> {
    const ownership = this.#database.connection
      .prepare(
        `SELECT task_id AS taskId, status, pid, process_started_at AS processStartedAt
         FROM run_attempts WHERE id = ?`,
      )
      .get(attemptId) as
      | {
          readonly taskId: string;
          readonly status: string;
          readonly pid: number | null;
          readonly processStartedAt: string | null;
        }
      | undefined;
    if (ownership === undefined) {
      return {
        settled: false,
        reason: `attempt ${attemptId} is missing; identity uncertain`,
      };
    }
    if (ownership.taskId !== taskId) {
      return {
        settled: false,
        reason: `attempt ${attemptId} does not belong to task ${taskId}`,
      };
    }

    const attempt = this.#attempts.get(attemptId);
    const terminalInDb =
      attempt !== undefined
      && attempt.status === 'completed'
      && ownership.status === 'completed';

    // Probe supervisor wait with a zero-delay timeout race so already-settled
    // waits resolve first; still-pending waits time out as alive.
    let waitResult: ProcessWaitResult | undefined;
    let waitMissing = false;
    let waitPending = false;
    try {
      const outcome = await new Promise<
        | { readonly kind: 'settled'; readonly result: ProcessWaitResult }
        | { readonly kind: 'missing' }
        | { readonly kind: 'pending' }
      >((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) resolve({ kind: 'pending' });
        }, 0);
        void this.#supervisor
          .wait(attemptId)
          .then((result) => {
            settled = true;
            clearTimeout(timer);
            resolve({ kind: 'settled', result });
          })
          .catch(() => {
            settled = true;
            clearTimeout(timer);
            resolve({ kind: 'missing' });
          });
      });
      if (outcome.kind === 'settled') {
        waitResult = outcome.result;
      } else if (outcome.kind === 'missing') {
        waitMissing = true;
      } else {
        waitPending = true;
      }
    } catch {
      waitMissing = true;
    }

    // Pending supervisor wait / live registered process always denies pause,
    // even if the DB row was incorrectly marked completed early.
    if (waitPending || this.#runningAttempts.has(attemptId)) {
      return {
        settled: false,
        reason:
          `attempt ${attemptId} process is still alive/unsettled under the supervisor`,
      };
    }

    if (!terminalInDb) {
      if (waitResult !== undefined && ownership.status === 'active') {
        return {
          settled: false,
          reason:
            `attempt ${attemptId} is nonterminal in the repository (status ${ownership.status}); `
            + 'persist terminal evidence before pause settlement',
        };
      }
      return {
        settled: false,
        reason: waitMissing
          ? `attempt ${attemptId} is unresolved: status ${ownership.status}, no supervisor identity`
          : `attempt ${attemptId} is unresolved: status ${ownership.status}, no verified settlement`,
      };
    }

    // Terminal DB + supervisor must both agree; wait must positively settle.
    if (waitMissing || waitResult === undefined) {
      return {
        settled: false,
        reason:
          `attempt ${attemptId} has terminal DB evidence but supervisor settlement is missing or uncertain`,
      };
    }
    if (ownership.pid !== null && waitResult.pid !== ownership.pid) {
      return {
        settled: false,
        reason:
          `attempt ${attemptId} launch identity mismatch: wait pid ${String(waitResult.pid)} `
          + `!= persisted pid ${String(ownership.pid)}`,
      };
    }
    return { settled: true };
  }

  public async resume(taskId: TaskId): Promise<ResumeResult> {
    const task = this.#requireTask(taskId);
    if (task.status !== 'paused_after_run') {
      throw new Error(
        `resume is only valid in paused_after_run, current state is ${task.status}`,
      );
    }
    const resumeTarget = task.workflowSnapshot.resumeTargetState;
    if (resumeTarget === undefined) {
      throw new Error('resume_target_state already consumed or missing');
    }

    const actionId = this.#idFactory('action');
    const idempotencyKey = `${taskId}:pause-resume:${resumeTarget}:${String(task.workflowVersion)}`;
    const reduced = transition(task.workflowSnapshot, { type: 'RESUME' });
    if (reduced.kind !== 'transitioned') {
      throw new Error(`cannot resume: ${reduced.reason}`);
    }

    // Consume resume target exactly once: clear it after successful RESUME
    // when the engine left it set for nested awaiting/inspection targets only
    // when appropriate. For safe execution targets the engine restores active
    // attempt identity and the pause resume target is no longer needed.
    const snapshot = this.#consumeResumeTarget(reduced);

    const now = this.#now().toISOString();
    withTransaction(this.#database.connection, () => {
      this.#insertCompletedAction(
        actionId,
        taskId,
        idempotencyKey,
        'pause-resume',
        {
          resumeTargetState: resumeTarget,
          fromWorkflowVersion: task.workflowVersion,
        },
        {
          resumeTargetState: resumeTarget,
          workflowState: snapshot.state,
        },
        now,
      );
      this.#writeSnapshot(task, snapshot, 'RESUME', now);
    });

    return {
      status: 'resumed',
      workflowState: snapshot.state,
      resumeTargetState: resumeTarget,
    };
  }

  /**
   * Track an attempt as running for accurate runtime views. Call when the
   * supervisor start succeeds; settlement / interrupt clears it.
   */
  public noteAttemptStarted(attemptId: AttemptId): void {
    this.#runningAttempts.add(attemptId);
  }

  public noteAttemptSettled(attemptId: AttemptId): void {
    this.#runningAttempts.delete(attemptId);
  }

  #consumeResumeTarget(snapshot: WorkflowSnapshot): WorkflowSnapshot {
    // RESUME into safe execution / plan approval / rework / completed should not
    // retain the pause resume target. awaiting_user and interrupted keep theirs
    // via engine semantics (resumeTargetState / nested fields).
    if (
      snapshot.state === 'awaiting_user'
      || snapshot.state === 'interrupted_needs_inspection'
    ) {
      return snapshot;
    }
    if (snapshot.resumeTargetState === undefined) {
      return snapshot;
    }
    // For reviewing/planning/etc the engine may leave resumeTargetState unset;
    // if still set from pause context, clear it so resume cannot be replayed.
    if (isSafeExecutionState(snapshot.state as ResumeTargetState)
      || snapshot.state === 'awaiting_plan_approval'
      || snapshot.state === 'rework_requested'
      || snapshot.state === 'completed') {
      const {
        resumeTargetState: _consumed,
        pendingResumeAttempt: _pending,
        ...rest
      } = snapshot as WorkflowSnapshot & {
        resumeTargetState?: ResumeTargetState;
        pendingResumeAttempt?: PendingResumeAttempt;
      };
      // Preserve active attempt identity when engine set it.
      if (isSafeExecutionState(snapshot.state as ResumeTargetState)) {
        const state = snapshot.state as
          | 'planning'
          | 'implementing'
          | 'reviewing'
          | 'master_validation';
        const pending = snapshot.pendingResumeAttempt;
        if (
          snapshot.activeAttemptId === undefined
          && pending !== undefined
        ) {
          return {
            ...rest,
            state,
            activeAttemptId: pending.attemptId,
            activeAttemptBaselineId: pending.baselineId,
            activeAttemptRole: expectedRoleForExecutionState(state),
            pauseAfterAttempt: false,
          } as WorkflowSnapshot;
        }
      }
      return {
        ...rest,
        pauseAfterAttempt: false,
      } as WorkflowSnapshot;
    }
    return snapshot;
  }

  #persistSnapshot(
    task: PersistedTask,
    snapshot: WorkflowSnapshot,
    eventType: string,
  ): void {
    const now = this.#now().toISOString();
    withTransaction(this.#database.connection, () => {
      this.#writeSnapshot(task, snapshot, eventType, now);
    });
  }

  #writeSnapshot(
    task: PersistedTask,
    snapshot: WorkflowSnapshot,
    eventType: string,
    now: string,
  ): void {
    const nextVersion = task.workflowVersion + 1;
    const serialized = serializeJsonValue(canonicalSnapshot(snapshot));
    const updated = this.#database.connection
      .prepare(
        `UPDATE tasks
         SET status = ?, workflow_version = ?, workflow_snapshot = ?, updated_at = ?
         WHERE id = ? AND workflow_version = ?`,
      )
      .run(
        snapshot.state,
        nextVersion,
        serialized,
        now,
        task.taskId,
        task.workflowVersion,
      );
    if (updated.changes !== 1) {
      throw new Error(
        `stale workflow version for task ${task.taskId}: expected ${String(task.workflowVersion)}`,
      );
    }
    this.#database.connection
      .prepare(
        `INSERT INTO workflow_transitions(
           task_id, from_state, to_state, event_type, workflow_version, snapshot_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.taskId,
        task.status,
        snapshot.state,
        eventType,
        nextVersion,
        serialized,
        now,
      );
    this.#database.connection
      .prepare(
        'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        task.taskId,
        eventType,
        serializeJsonValue({
          from: task.status,
          to: snapshot.state,
          workflowVersion: nextVersion,
        }),
        now,
      );
  }

  async #processRunningFor(task: PersistedTask): Promise<boolean> {
    const attemptId = task.workflowSnapshot.activeAttemptId;
    if (attemptId === undefined) return false;
    return this.#isProcessRunning(attemptId);
  }

  async #defaultIsRunning(attemptId: AttemptId): Promise<boolean> {
    if (this.#runningAttempts.has(attemptId)) return true;
    // Best-effort: if wait rejects (not supervised), treat as not running.
    try {
      const wait = this.#supervisor.wait(attemptId);
      const raced = await Promise.race([
        wait.then(() => 'settled' as const),
        Promise.resolve('pending' as const),
      ]);
      if (raced === 'pending') {
        this.#runningAttempts.add(attemptId);
        void wait.finally(() => {
          this.#runningAttempts.delete(attemptId);
        });
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  #insertCompletedAction(
    actionId: string,
    taskId: TaskId,
    idempotencyKey: string,
    type: string,
    payload: unknown,
    result: unknown,
    now: string,
  ): void {
    this.#database.connection
      .prepare(
        `INSERT INTO pending_actions(
           id, task_id, idempotency_key, action_type, payload_json,
           status, result_json, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        actionId,
        taskId,
        idempotencyKey,
        type,
        serializeJsonValue(payload),
        serializeJsonValue(result),
        now,
        now,
        now,
      );
  }

  #requireTask(taskId: TaskId): PersistedTask {
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new Error(`task not found: ${taskId}`);
    return task;
  }
}

function canonicalSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  return {
    state: snapshot.state,
    taskId: snapshot.taskId,
    requirementVersion: snapshot.requirementVersion,
    reworkCount: snapshot.reworkCount,
    maxReworks: snapshot.maxReworks,
    pauseAfterAttempt: snapshot.pauseAfterAttempt,
    ...(snapshot.resumeTargetState === undefined
      ? {}
      : { resumeTargetState: snapshot.resumeTargetState }),
    ...(snapshot.pendingResumeAttempt === undefined
      ? {}
      : { pendingResumeAttempt: snapshot.pendingResumeAttempt }),
    ...(snapshot.awaitingResumeTargetState === undefined
      ? {}
      : { awaitingResumeTargetState: snapshot.awaitingResumeTargetState }),
    ...(snapshot.inspectionResumeTargetState === undefined
      ? {}
      : { inspectionResumeTargetState: snapshot.inspectionResumeTargetState }),
    ...(snapshot.activeAttemptId === undefined
      ? {}
      : { activeAttemptId: snapshot.activeAttemptId }),
    ...(snapshot.activeAttemptBaselineId === undefined
      ? {}
      : { activeAttemptBaselineId: snapshot.activeAttemptBaselineId }),
    ...(snapshot.activeAttemptRole === undefined
      ? {}
      : { activeAttemptRole: snapshot.activeAttemptRole }),
    ...(snapshot.stopIntent === undefined
      ? {}
      : { stopIntent: snapshot.stopIntent }),
    ...(snapshot.awaitingReason === undefined
      ? {}
      : { awaitingReason: snapshot.awaitingReason }),
    ...(snapshot.allowedAwaitingActions === undefined
      ? {}
      : { allowedAwaitingActions: [...snapshot.allowedAwaitingActions] }),
    ...(snapshot.reworkRequest === undefined
      ? {}
      : { reworkRequest: snapshot.reworkRequest }),
  } as WorkflowSnapshot;
}
