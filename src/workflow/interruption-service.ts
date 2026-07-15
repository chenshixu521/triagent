import { randomUUID } from 'node:crypto';

import type { AttemptId, TaskId } from '../domain/ids.js';
import { ActionRepository } from '../persistence/action-repository.js';
import type { ReadWriteDatabase } from '../persistence/database.js';
import { serializeJsonValue } from '../persistence/json-value.js';
import {
  TaskRepository,
  type PersistedTask,
} from '../persistence/task-repository.js';
import { withTransaction } from '../persistence/transaction.js';
import type { ProcessSupervisorPort } from '../process/process-supervisor-port.js';
import type { GitBaselineService } from '../tracking/git-baseline-service.js';
import {
  isSafeExecutionState,
  type SafeExecutionState,
  type WorkflowSnapshot,
  type WorkflowState,
} from './states.js';
import { transition } from './workflow-engine.js';

export type InterruptionIdKind = 'action';

export type TreeVerificationResult =
  | { readonly clean: true }
  | { readonly clean: false; readonly reason: string };

export type RescanResult =
  | { readonly ok: true; readonly changeCount: number }
  | { readonly ok: false; readonly reason: string };

export interface InterruptionServiceOptions {
  readonly database: ReadWriteDatabase;
  readonly supervisor: ProcessSupervisorPort;
  readonly tracker: GitBaselineService;
  readonly now?: () => Date;
  readonly gracePeriodMs?: number;
  readonly idFactory?: (kind: InterruptionIdKind) => string;
  /**
   * Test seam: advance a fake clock so graceful/force stop plans settle.
   * Production may omit this and rely on real-time supervisor events.
   */
  readonly advanceClock?: (milliseconds: number) => void;
  readonly verifyTreeGone?: (
    attemptId: AttemptId,
  ) => TreeVerificationResult | Promise<TreeVerificationResult>;
  readonly rescanProject?: (
    taskId: TaskId,
  ) => RescanResult | Promise<RescanResult>;
}

export type InterruptionResult = {
  readonly status: WorkflowState;
  readonly cleanupComplete: boolean;
  readonly exitAllowed: boolean;
  readonly reason?: string;
  readonly alreadyComplete?: boolean;
};

export type ExitGate = {
  readonly allowed: boolean;
  readonly reason?: string;
};

const DEFAULT_GRACE_MS = 5_000;

/**
 * Interrupt cleanup: persist stop intent first, cooperative stop, bounded
 * grace, force-close Job via supervisor, fail-closed tree verification, project
 * rescan, then atomically enter interrupted_needs_inspection. Any cleanup /
 * rescan / persistence failure blocks TUI exit and never claims complete.
 */
export class InterruptionService {
  readonly #database: ReadWriteDatabase;
  readonly #tasks: TaskRepository;
  readonly #actions: ActionRepository;
  readonly #supervisor: ProcessSupervisorPort;
  readonly #tracker: GitBaselineService;
  readonly #now: () => Date;
  readonly #gracePeriodMs: number;
  readonly #idFactory: (kind: InterruptionIdKind) => string;
  readonly #advanceClock?: (milliseconds: number) => void;
  readonly #verifyTreeGone: (
    attemptId: AttemptId,
  ) => Promise<TreeVerificationResult>;
  readonly #rescanProject: (taskId: TaskId) => Promise<RescanResult>;

  public constructor(options: InterruptionServiceOptions) {
    this.#database = options.database;
    this.#tasks = new TaskRepository(options.database.connection);
    this.#actions = new ActionRepository(options.database.connection);
    this.#supervisor = options.supervisor;
    this.#tracker = options.tracker;
    this.#now = options.now ?? (() => new Date());
    this.#gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_MS;
    this.#idFactory = options.idFactory ?? (() => randomUUID());
    this.#advanceClock = options.advanceClock;
    this.#verifyTreeGone =
      options.verifyTreeGone === undefined
        ? async () => this.#defaultVerifyTreeGone()
        : async (attemptId) => options.verifyTreeGone!(attemptId);
    this.#rescanProject =
      options.rescanProject === undefined
        ? async (taskId) => this.#defaultRescan(taskId)
        : async (taskId) => options.rescanProject!(taskId);
  }

  public async interrupt(taskId: TaskId): Promise<InterruptionResult> {
    const task = this.#requireTask(taskId);
    if (task.status === 'interrupted_needs_inspection') {
      return {
        status: 'interrupted_needs_inspection',
        cleanupComplete: true,
        exitAllowed: true,
        alreadyComplete: true,
      };
    }
    if (task.status === 'cleanup_failed' || task.status === 'interrupting') {
      return this.resumeCleanup(taskId);
    }

    const attemptId = task.workflowSnapshot.activeAttemptId;
    if (attemptId === undefined) {
      throw new Error('interrupt requires an active attempt');
    }
    if (!isSafeExecutionState(task.status as SafeExecutionState)) {
      throw new Error(
        `interrupt is not valid while workflow is ${task.status}`,
      );
    }

    // 1) Persist stop intent + INTERRUPT transition BEFORE any process side effects.
    const actionId = this.#idFactory('action');
    const idempotencyKey = `${taskId}:process-cleanup:${attemptId}`;
    this.#persistInterruptIntent(task, attemptId, actionId, idempotencyKey);

    return this.#runCleanupPipeline(taskId, attemptId, actionId, idempotencyKey);
  }

  public async resumeCleanup(taskId: TaskId): Promise<InterruptionResult> {
    const task = this.#requireTask(taskId);
    if (task.status === 'interrupted_needs_inspection') {
      return {
        status: 'interrupted_needs_inspection',
        cleanupComplete: true,
        exitAllowed: true,
        alreadyComplete: true,
      };
    }
    if (task.status !== 'interrupting' && task.status !== 'cleanup_failed') {
      throw new Error(
        `resumeCleanup is only valid while interrupting/cleanup_failed, got ${task.status}`,
      );
    }
    const attemptId = task.workflowSnapshot.activeAttemptId;
    if (attemptId === undefined) {
      throw new Error('cleanup recovery requires active attempt identity');
    }

    if (task.status === 'cleanup_failed') {
      const reduced = transition(task.workflowSnapshot, { type: 'RETRY_CLEANUP' });
      if (reduced.kind !== 'transitioned') {
        throw new Error(`cannot retry cleanup: ${reduced.reason}`);
      }
      this.#persistSnapshot(task, reduced, 'RETRY_CLEANUP');
    }

    const reopened = this.#reopenOrCreateCleanupAction(taskId, attemptId);
    return this.#runCleanupPipeline(
      taskId,
      attemptId,
      reopened.actionId,
      reopened.idempotencyKey,
    );
  }

  public canExitTui(taskId: TaskId): ExitGate {
    const task = this.#requireTask(taskId);
    if (
      task.status === 'interrupting'
      || task.status === 'cleanup_failed'
    ) {
      return {
        allowed: false,
        reason: `exit blocked: cleanup incomplete while workflow is ${task.status}`,
      };
    }
    // Block on the latest cleanup action that is not completed (intent OR failed).
    const latest = this.#database.connection
      .prepare(
        `SELECT id, status FROM pending_actions
         WHERE task_id = ? AND action_type = 'process-cleanup'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(taskId) as { readonly id: string; readonly status: string } | undefined;
    if (latest !== undefined && latest.status !== 'completed') {
      return {
        allowed: false,
        reason:
          `exit blocked: latest process-cleanup action is ${latest.status} (not completed)`,
      };
    }
    return { allowed: true };
  }

  /**
   * Never reuse a failed cleanup action as if it were still intent.
   * Atomically reopen failed -> intent (clear completion/error, bump retryCount)
   * or insert a new uniquely keyed retry action linked to the prior one.
   */
  #reopenOrCreateCleanupAction(
    taskId: TaskId,
    attemptId: AttemptId,
  ): { readonly actionId: string; readonly idempotencyKey: string } {
    const now = this.#now().toISOString();
    return withTransaction(this.#database.connection, () => {
      const latest = this.#database.connection
        .prepare(
          `SELECT id, status, idempotency_key AS idempotencyKey, payload_json AS payloadJson
           FROM pending_actions
           WHERE task_id = ? AND action_type = 'process-cleanup'
             AND (
               idempotency_key = ?
               OR idempotency_key LIKE ?
             )
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
        )
        .get(
          taskId,
          `${taskId}:process-cleanup:${attemptId}`,
          `${taskId}:process-cleanup:${attemptId}:%`,
        ) as
        | {
            readonly id: string;
            readonly status: string;
            readonly idempotencyKey: string;
            readonly payloadJson: string;
          }
        | undefined;

      if (latest === undefined) {
        const actionId = this.#idFactory('action');
        const idempotencyKey = `${taskId}:process-cleanup:${attemptId}`;
        this.#database.connection
          .prepare(
            `INSERT INTO pending_actions(
               id, task_id, idempotency_key, action_type, payload_json,
               status, created_at, updated_at
             ) VALUES (?, ?, ?, 'process-cleanup', ?, 'intent', ?, ?)`,
          )
          .run(
            actionId,
            taskId,
            idempotencyKey,
            serializeJsonValue({
              attemptId,
              stopIntent: 'interrupt',
              phase: 'intent_persisted',
              recovered: true,
              retryCount: 0,
            }),
            now,
            now,
          );
        return { actionId, idempotencyKey };
      }

      if (latest.status === 'completed') {
        // Should not resume a completed cleanup; surface as open intent for safety.
        const actionId = this.#idFactory('action');
        const idempotencyKey =
          `${taskId}:process-cleanup:${attemptId}:retry:${now}`;
        this.#database.connection
          .prepare(
            `INSERT INTO pending_actions(
               id, task_id, idempotency_key, action_type, payload_json,
               status, created_at, updated_at
             ) VALUES (?, ?, ?, 'process-cleanup', ?, 'intent', ?, ?)`,
          )
          .run(
            actionId,
            taskId,
            idempotencyKey,
            serializeJsonValue({
              attemptId,
              stopIntent: 'interrupt',
              phase: 'intent_persisted',
              recovered: true,
              priorActionId: latest.id,
              retryCount: 1,
            }),
            now,
            now,
          );
        return { actionId, idempotencyKey };
      }

      if (latest.status === 'intent') {
        return { actionId: latest.id, idempotencyKey: latest.idempotencyKey };
      }

      // failed (or any non-intent, non-completed): reopen same row to intent.
      const priorPayload = objectValue(JSON.parse(latest.payloadJson)) ?? {};
      const retryCount =
        typeof priorPayload.retryCount === 'number'
          ? priorPayload.retryCount + 1
          : 1;
      const reopened = this.#database.connection
        .prepare(
          `UPDATE pending_actions
           SET status = 'intent',
               error_text = NULL,
               result_json = NULL,
               completed_at = NULL,
               payload_json = ?,
               updated_at = ?
           WHERE id = ? AND status = 'failed'`,
        )
        .run(
          serializeJsonValue({
            ...priorPayload,
            attemptId,
            stopIntent: 'interrupt',
            phase: 'intent_persisted',
            recovered: true,
            retryCount,
            reopenedAt: now,
          }),
          now,
          latest.id,
        );
      if (reopened.changes === 1) {
        return { actionId: latest.id, idempotencyKey: latest.idempotencyKey };
      }

      // Race: row changed; create a new uniquely keyed retry action linked to prior.
      const actionId = this.#idFactory('action');
      const idempotencyKey =
        `${taskId}:process-cleanup:${attemptId}:retry:${String(retryCount)}:${actionId}`;
      this.#database.connection
        .prepare(
          `INSERT INTO pending_actions(
             id, task_id, idempotency_key, action_type, payload_json,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, 'process-cleanup', ?, 'intent', ?, ?)`,
        )
        .run(
          actionId,
          taskId,
          idempotencyKey,
          serializeJsonValue({
            attemptId,
            stopIntent: 'interrupt',
            phase: 'intent_persisted',
            recovered: true,
            priorActionId: latest.id,
            retryCount,
          }),
          now,
          now,
        );
      return { actionId, idempotencyKey };
    });
  }

  async #runCleanupPipeline(
    taskId: TaskId,
    attemptId: AttemptId,
    actionId: string,
    idempotencyKey: string,
  ): Promise<InterruptionResult> {
    // 2) Cooperative stop.
    try {
      await this.#supervisor.requestGracefulStop(attemptId);
    } catch (error) {
      // Continue to force path; record the cooperative failure.
      this.#noteCleanupPhase(actionId, 'graceful_stop_failed', error);
    }

    // 3) Bounded grace period.
    this.#advanceClock?.(this.#gracePeriodMs);
    if (this.#advanceClock === undefined) {
      await delay(this.#gracePeriodMs);
    }

    // 4) Force-close Job through supervisor abstraction if still alive.
    // Fail-closed: when verification is uncertain, treat as still alive and force.
    let stillAlive = true;
    try {
      const earlyTree = await this.#verifyTreeGone(attemptId);
      stillAlive = !earlyTree.clean;
    } catch {
      stillAlive = true;
    }
    // Always attempt force-close after the grace window unless the tree was
    // positively verified clean. Cooperative stop alone is not sufficient proof
    // without identity verification (Windows Job kill-on-close remains required
    // whenever liveness is uncertain).
    if (stillAlive) {
      try {
        await this.#supervisor.forceStopTree(attemptId);
        this.#advanceClock?.(Math.max(2, Math.floor(this.#gracePeriodMs / 5)));
        if (this.#advanceClock === undefined) {
          await delay(50);
        }
      } catch (error) {
        // If the process already settled under cooperative stop, force may
        // reject; re-check the tree before failing closed.
        const afterForceError = await this.#verifyTreeGone(attemptId).catch(
          (verifyError: unknown) =>
            ({
              clean: false as const,
              reason: errorMessage(verifyError),
            }),
        );
        if (!afterForceError.clean) {
          return this.#failCleanup(
            taskId,
            actionId,
            `force Job close failed: ${errorMessage(error)}`,
          );
        }
        stillAlive = false;
      }
    }

    // 5) Verify whole tree gone with fail-closed identity checks.
    let tree: TreeVerificationResult;
    try {
      tree = await this.#verifyTreeGone(attemptId);
    } catch (error) {
      return this.#failCleanup(
        taskId,
        actionId,
        `tree verification failed closed: ${errorMessage(error)}`,
      );
    }
    if (!tree.clean) {
      return this.#failCleanup(
        taskId,
        actionId,
        `process tree cleanup verification failed: ${tree.reason}`,
      );
    }

    // 6) Rescan / reconcile project files & baseline.
    let rescan: RescanResult;
    try {
      rescan = await this.#rescanProject(taskId);
    } catch (error) {
      return this.#failCleanup(
        taskId,
        actionId,
        `project rescan failed: ${errorMessage(error)}`,
      );
    }
    if (!rescan.ok) {
      return this.#failCleanup(
        taskId,
        actionId,
        `project rescan failed: ${rescan.reason}`,
      );
    }

    // 7) Atomically enter interrupted_needs_inspection.
    return this.#completeCleanup(taskId, attemptId, actionId, rescan.changeCount);
  }

  #persistInterruptIntent(
    task: PersistedTask,
    attemptId: AttemptId,
    actionId: string,
    idempotencyKey: string,
  ): void {
    const reduced = transition(task.workflowSnapshot, { type: 'INTERRUPT' });
    if (reduced.kind !== 'transitioned') {
      throw new Error(`cannot interrupt: ${reduced.reason}`);
    }
    const now = this.#now().toISOString();
    withTransaction(this.#database.connection, () => {
      this.#database.connection
        .prepare(
          `INSERT INTO pending_actions(
             id, task_id, idempotency_key, action_type, payload_json,
             status, created_at, updated_at
           ) VALUES (?, ?, ?, 'process-cleanup', ?, 'intent', ?, ?)`,
        )
        .run(
          actionId,
          task.taskId,
          idempotencyKey,
          serializeJsonValue({
            attemptId,
            stopIntent: 'interrupt',
            phase: 'intent_persisted',
          }),
          now,
          now,
        );
      this.#writeSnapshot(task, reduced, 'INTERRUPT', now);
    });
  }

  #completeCleanup(
    taskId: TaskId,
    attemptId: AttemptId,
    actionId: string,
    changeCount: number,
  ): InterruptionResult {
    const task = this.#requireTask(taskId);
    const reduced = transition(task.workflowSnapshot, {
      type: 'PROCESS_TREE_CLEAN',
    });
    if (reduced.kind !== 'transitioned') {
      return this.#failCleanup(
        taskId,
        actionId,
        `PROCESS_TREE_CLEAN rejected: ${reduced.reason}`,
      );
    }
    const now = this.#now().toISOString();
    try {
      withTransaction(this.#database.connection, () => {
        this.#writeSnapshot(task, reduced, 'PROCESS_TREE_CLEAN', now);
        const completed = this.#database.connection
          .prepare(
            `UPDATE pending_actions
             SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ?
             WHERE id = ? AND status = 'intent'`,
          )
          .run(
            serializeJsonValue({
              attemptId,
              changeCount,
              status: 'interrupted_needs_inspection',
            }),
            now,
            now,
            actionId,
          );
        if (completed.changes !== 1) {
          throw new Error(
            `process-cleanup complete requires exactly one intent action row; got ${String(completed.changes)}`,
          );
        }
      });
    } catch (error) {
      return this.#failCleanup(
        taskId,
        actionId,
        `cleanup action complete failed: ${errorMessage(error)}`,
      );
    }
    return {
      status: 'interrupted_needs_inspection',
      cleanupComplete: true,
      exitAllowed: true,
    };
  }

  #failCleanup(
    taskId: TaskId,
    actionId: string,
    reason: string,
  ): InterruptionResult {
    const task = this.#requireTask(taskId);
    if (task.status === 'cleanup_failed') {
      this.#markActionFailed(actionId, reason);
      return {
        status: 'cleanup_failed',
        cleanupComplete: false,
        exitAllowed: false,
        reason,
      };
    }
    if (task.status === 'interrupting') {
      const reduced = transition(task.workflowSnapshot, {
        type: 'PROCESS_CLEANUP_FAILED',
        reason,
      });
      if (reduced.kind === 'transitioned') {
        try {
          this.#persistSnapshot(task, reduced, 'PROCESS_CLEANUP_FAILED');
        } catch {
          // Fall through; still report blocked exit.
        }
      }
    }
    this.#markActionFailed(actionId, reason);
    return {
      status: 'cleanup_failed',
      cleanupComplete: false,
      exitAllowed: false,
      reason,
    };
  }

  #markActionFailed(actionId: string, reason: string): void {
    const action = this.#actions.get(actionId);
    if (action?.status !== 'intent') return;
    const now = this.#now().toISOString();
    try {
      this.#database.connection
        .prepare(
          `UPDATE pending_actions
           SET status = 'failed', error_text = ?, completed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'intent'`,
        )
        .run(reason, now, now, actionId);
    } catch {
      // ignore double-finish races
    }
  }

  #noteCleanupPhase(actionId: string, phase: string, error: unknown): void {
    const action = this.#actions.get(actionId);
    if (action?.taskId === undefined) return;
    // Do not complete/fail yet; only annotate via events.
    this.#database.connection
      .prepare(
        'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        action.taskId,
        'PROCESS_CLEANUP_PHASE',
        serializeJsonValue({
          actionId,
          phase,
          error: errorMessage(error),
        }),
        this.#now().toISOString(),
      );
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

  async #defaultVerifyTreeGone(): Promise<TreeVerificationResult> {
    // Without identity probe injection, fail closed.
    return {
      clean: false,
      reason: 'process tree identity verification is unavailable',
    };
  }

  async #defaultRescan(taskId: TaskId): Promise<RescanResult> {
    try {
      // Tracker presence is required; a throw means rescan failed.
      void this.#tracker.projectRoot;
      void taskId;
      return { ok: true, changeCount: 0 };
    } catch (error) {
      return { ok: false, reason: errorMessage(error) };
    }
  }

  #requireTask(taskId: TaskId): PersistedTask {
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new Error(`task not found: ${taskId}`);
    return task;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
