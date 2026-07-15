import { randomUUID } from 'node:crypto';

import type { RunAttempt } from '../domain/attempt.js';
import {
  asAttemptId,
  asBaselineId,
  type TaskId,
} from '../domain/ids.js';
import type { ReadWriteDatabase } from '../persistence/database.js';
import { parseJsonValue, serializeJsonValue } from '../persistence/json-value.js';
import { TaskRepository, type PersistedTask } from '../persistence/task-repository.js';
import { withTransaction } from '../persistence/transaction.js';
import type { ProjectLock } from '../persistence/lock-repository.js';
import { DiffService } from '../tracking/diff-service.js';
import type { BaselineTrackerPort } from '../tracking/tracking-port.js';
import type {
  ReconciliationBaselineEvidence,
  ReconciliationProcessEvidence,
  StartupReconciliationEvidence,
} from '../workflow/reconciler.js';
import {
  type RecoveryProcessInspector,
  WorkflowRecoveryJournal,
} from '../workflow/workflow-journal.js';
import type { WorkflowSnapshot } from '../workflow/states.js';
import type { WorkflowEffect, WorkflowEvent } from '../workflow/transitions.js';
import { transition, type Transitioned } from '../workflow/workflow-engine.js';

export type RecoveryIdKind = 'action' | 'attempt' | 'baseline';

export interface RecoveryEffectIntent {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly actionType: 'create-attempt-baseline' | 'agent-run';
  readonly effect: Exclude<WorkflowEffect, { readonly type: 'PersistTransition' }>;
}

export interface RecoveryInspectionEvidence {
  readonly observedAt: string;
  readonly process: ReconciliationProcessEvidence;
  readonly baseline: ReconciliationBaselineEvidence;
  readonly lock: StartupReconciliationEvidence['lock'];
  readonly changedFiles: readonly string[];
  readonly changeCount: number;
  readonly diffDiagnostic?: string;
}

export type RecoveryOperationResult =
  | {
      readonly status: 'applied' | 'already_applied';
      readonly workflowSnapshot: WorkflowSnapshot;
      readonly evidence?: RecoveryInspectionEvidence;
      readonly execution?: 'started' | 'deferred' | 'failed';
      readonly reason?: string;
    }
  | {
      readonly status: 'blocked';
      readonly workflowSnapshot: WorkflowSnapshot;
      readonly reason: string;
      readonly evidence?: RecoveryInspectionEvidence;
    };

export interface RestartRecoveryServiceOptions {
  readonly database: ReadWriteDatabase;
  readonly tracker: BaselineTrackerPort;
  readonly ownerInstanceId: string;
  readonly inspectProcess: RecoveryProcessInspector;
  readonly now?: () => Date;
  readonly leaseDurationMs?: number;
  readonly idFactory?: (kind: RecoveryIdKind) => string;
  readonly executeEffects?: (
    effects: readonly RecoveryEffectIntent[],
  ) => Promise<void>;
}

interface OperatorActionRow {
  readonly id: string;
  readonly status: 'intent' | 'completed' | 'failed';
  readonly result_json: string | null;
}

interface ActiveLockRow {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string | null;
  readonly path: string;
  readonly canonical_root: string | null;
  readonly comparison_key: string | null;
  readonly display_root: string | null;
  readonly path_flavor: 'windows' | 'posix' | null;
  readonly owner_token: string;
  readonly owner_instance_id: string | null;
  readonly acquired_at: string;
  readonly lease_expires_at: string;
  readonly heartbeat_at: string | null;
  readonly updated_at: string | null;
  readonly released_at: string | null;
}

const DEFAULT_LEASE_DURATION_MS = 60_000;

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

function workflowEventForCancel(task: PersistedTask): WorkflowEvent {
  return task.status === 'interrupted_needs_inspection'
    ? { type: 'INSPECTION_CANCEL' }
    : { type: 'AWAITING_USER_CANCEL' };
}

function actionTypeForEffect(
  effect: RecoveryEffectIntent['effect'],
): RecoveryEffectIntent['actionType'] {
  if (effect.type === 'CreateAttemptBaseline') return 'create-attempt-baseline';
  if (
    effect.type === 'StartPlanning'
    || effect.type === 'StartImplementation'
    || effect.type === 'StartReview'
    || effect.type === 'StartMasterValidation'
  ) {
    return 'agent-run';
  }
  throw new Error(`unsupported recovery continue effect: ${effect.type}`);
}

function lockFromRow(row: ActiveLockRow): ProjectLock {
  return {
    lockId: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    path: row.path,
    canonicalRoot: row.canonical_root ?? row.path,
    comparisonKey: row.comparison_key ?? row.path.toLocaleLowerCase('en-US'),
    displayRoot: row.display_root ?? row.path,
    pathFlavor: row.path_flavor ?? 'windows',
    ownerToken: row.owner_token,
    ownerInstanceId: row.owner_instance_id ?? row.owner_token,
    acquiredAt: row.acquired_at,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at ?? row.acquired_at,
    updatedAt: row.updated_at ?? row.acquired_at,
    releasedAt: row.released_at,
  };
}

export class RestartRecoveryService {
  readonly #database: ReadWriteDatabase;
  readonly #tasks: TaskRepository;
  readonly #tracker: BaselineTrackerPort;
  readonly #journal: WorkflowRecoveryJournal;
  readonly #ownerInstanceId: string;
  readonly #now: () => Date;
  readonly #leaseDurationMs: number;
  readonly #idFactory: (kind: RecoveryIdKind) => string;
  readonly #executeEffects:
    | ((effects: readonly RecoveryEffectIntent[]) => Promise<void>)
    | undefined;

  public constructor(options: RestartRecoveryServiceOptions) {
    if (options.ownerInstanceId.trim().length === 0) {
      throw new Error('ownerInstanceId must be non-empty');
    }
    if (
      options.leaseDurationMs !== undefined
      && (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0)
    ) {
      throw new Error('leaseDurationMs must be a positive integer');
    }
    this.#database = options.database;
    this.#tasks = new TaskRepository(options.database.connection);
    this.#tracker = options.tracker;
    this.#ownerInstanceId = options.ownerInstanceId;
    this.#now = options.now ?? (() => new Date());
    this.#leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#idFactory = options.idFactory ?? (() => randomUUID());
    this.#executeEffects = options.executeEffects;
    this.#journal = new WorkflowRecoveryJournal({
      database: options.database,
      tracker: options.tracker,
      ownerInstanceId: options.ownerInstanceId,
      observedAt: this.#now,
      inspectProcess: async (attempt: RunAttempt) => {
        try {
          return await options.inspectProcess(attempt);
        } catch (error) {
          return {
            identity: 'unverifiable',
            terminalState: 'unknown',
            diagnostic: error instanceof Error ? error.message : String(error),
          };
        }
      },
    });
  }

  public async inspect(taskId: TaskId): Promise<RecoveryOperationResult> {
    const task = this.#requireTask(taskId);
    const episodeAttemptId = this.#requireEpisodeAttemptId(taskId);
    const idempotencyKey = this.#operatorKey(taskId, episodeAttemptId, 'inspect');
    const existing = this.#existingOperation(idempotencyKey);
    if (existing?.status === 'completed') {
      return {
        status: 'already_applied',
        workflowSnapshot: this.#requireTask(taskId).workflowSnapshot,
      };
    }
    if (task.status !== 'interrupted_needs_inspection') {
      return this.#blocked(task, `inspection is not legal while task is ${task.status}`);
    }

    const evidence = await this.#inspectionEvidence(taskId);
    const reduced = transition(task.workflowSnapshot, { type: 'INSPECTION_VIEW' });
    if (reduced.kind !== 'transitioned') {
      return this.#blocked(task, reduced.reason, evidence);
    }
    const actionId = this.#nextId('action');
    this.#commitOperatorTransition({
      task,
      reduced,
      event: { type: 'INSPECTION_VIEW' },
      operation: 'inspect',
      episodeAttemptId,
      actionId,
      idempotencyKey,
      evidence,
    });
    return {
      status: 'applied',
      workflowSnapshot: this.#requireTask(taskId).workflowSnapshot,
      evidence,
    };
  }

  public async continueAfterInspection(
    taskId: TaskId,
  ): Promise<RecoveryOperationResult> {
    const task = this.#requireTask(taskId);
    const episodeAttemptId = this.#requireEpisodeAttemptId(taskId);
    const idempotencyKey = this.#operatorKey(taskId, episodeAttemptId, 'continue');
    const existing = this.#existingOperation(idempotencyKey);
    if (existing?.status === 'completed') {
      return {
        status: 'already_applied',
        workflowSnapshot: this.#requireTask(taskId).workflowSnapshot,
      };
    }
    if (
      task.status !== 'awaiting_user'
      || !task.workflowSnapshot.allowedAwaitingActions?.includes('continue')
    ) {
      return this.#blocked(task, `continue is not legal while task is ${task.status}`);
    }

    const startupEvidence = await this.#journal.readStartupEvidence(taskId);
    const evidence = this.#inspectionEvidenceFromStartup(startupEvidence);
    const safetyBlock = this.#continuationSafetyBlock(startupEvidence);
    if (safetyBlock !== undefined) return this.#blocked(task, safetyBlock, evidence);
    const activeLock = this.#requireActiveLock(taskId);
    if (activeLock.ownerInstanceId === this.#ownerInstanceId) {
      return this.#blocked(task, 'recovery lock is already owned by the restarted instance', evidence);
    }
    if (
      startupEvidence.lock.status !== 'present'
      || startupEvidence.lock.ownerInstanceId !== activeLock.ownerInstanceId
    ) {
      return this.#blocked(task, 'active project lock evidence changed during recovery', evidence);
    }

    const attemptId = asAttemptId(this.#nextId('attempt'));
    const baselineId = asBaselineId(this.#nextId('baseline'));
    const event: WorkflowEvent = {
      type: 'AWAITING_USER_CONTINUE',
      attemptId,
      baselineId,
    };
    const reduced = transition(task.workflowSnapshot, event);
    if (reduced.kind !== 'transitioned') {
      return this.#blocked(task, reduced.reason, evidence);
    }
    const recoverableEffects = reduced.effects.filter(
      (effect): effect is RecoveryEffectIntent['effect'] => effect.type !== 'PersistTransition',
    );
    const effectIntents = recoverableEffects.map((effect, index) => ({
      actionId: this.#nextId('action'),
      idempotencyKey: `${taskId}:recovery:${episodeAttemptId}:${String(task.workflowVersion + 1)}:${effect.type}:${String(index)}`,
      actionType: actionTypeForEffect(effect),
      effect,
    } satisfies RecoveryEffectIntent));
    if (
      effectIntents.length !== 2
      || effectIntents.filter((intent) => intent.actionType === 'create-attempt-baseline').length !== 1
      || effectIntents.filter((intent) => intent.actionType === 'agent-run').length !== 1
    ) {
      return this.#blocked(task, 'continue must create exactly one baseline and one agent-run intent', evidence);
    }

    const actionId = this.#nextId('action');
    this.#commitContinue({
      task,
      reduced,
      event,
      episodeAttemptId,
      actionId,
      idempotencyKey,
      evidence,
      activeLock,
      effectIntents,
    });

    let execution: 'started' | 'deferred' | 'failed' = 'deferred';
    let reason: string | undefined;
    if (this.#executeEffects !== undefined) {
      try {
        await this.#executeEffects(effectIntents);
        execution = 'started';
      } catch (error) {
        execution = 'failed';
        reason = error instanceof Error ? error.message : String(error);
        this.#recordEvent(taskId, 'RECOVERY_EFFECT_EXECUTION_FAILED', {
          episodeAttemptId,
          effectActionIds: effectIntents.map((intent) => intent.actionId),
          reason,
        });
      }
    }
    return {
      status: 'applied',
      workflowSnapshot: this.#requireTask(taskId).workflowSnapshot,
      execution,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  public async cancelAfterInspection(
    taskId: TaskId,
  ): Promise<RecoveryOperationResult> {
    const task = this.#requireTask(taskId);
    const episodeAttemptId = this.#latestEpisodeAttemptId(taskId);
    const recoveryEpisodeKey = episodeAttemptId ?? 'pre-attempt';
    const idempotencyKey = this.#operatorKey(taskId, recoveryEpisodeKey, 'cancel');
    const existing = this.#existingOperation(idempotencyKey);
    if (existing?.status === 'completed') {
      return {
        status: 'already_applied',
        workflowSnapshot: this.#requireTask(taskId).workflowSnapshot,
      };
    }
    if (
      task.status !== 'interrupted_needs_inspection'
      && (
        task.status !== 'awaiting_user'
        || !task.workflowSnapshot.allowedAwaitingActions?.includes('cancel')
      )
    ) {
      return this.#blocked(task, `cancel is not legal while task is ${task.status}`);
    }

    const startupEvidence = await this.#journal.readStartupEvidence(taskId);
    const evidence = this.#inspectionEvidenceFromStartup(startupEvidence);
    const processBlock = this.#processExitBlock(startupEvidence);
    if (
      processBlock !== undefined
      && !this.#hasDurableRejectedPrelaunchEvidence(startupEvidence)
    ) {
      return this.#blocked(task, processBlock, evidence);
    }
    const activeLock = this.#requireActiveLock(taskId);
    if (
      startupEvidence.lock.status !== 'present'
      || startupEvidence.lock.ownerInstanceId !== activeLock.ownerInstanceId
    ) {
      return this.#blocked(task, 'active project lock evidence changed during recovery', evidence);
    }

    const event = workflowEventForCancel(task);
    const reduced = transition(task.workflowSnapshot, event);
    if (reduced.kind !== 'transitioned') {
      return this.#blocked(task, reduced.reason, evidence);
    }
    const actionId = this.#nextId('action');
    this.#commitCancel({
      task,
      reduced,
      event,
      recoveryEpisodeKey,
      ...(episodeAttemptId === undefined ? {} : { episodeAttemptId }),
      actionId,
      idempotencyKey,
      evidence,
      activeLock,
    });
    return {
      status: 'applied',
      workflowSnapshot: this.#requireTask(taskId).workflowSnapshot,
      evidence,
    };
  }

  async #inspectionEvidence(taskId: TaskId): Promise<RecoveryInspectionEvidence> {
    const startupEvidence = await this.#journal.readStartupEvidence(taskId);
    return this.#inspectionEvidenceFromStartup(startupEvidence);
  }

  #inspectionEvidenceFromStartup(
    startupEvidence: StartupReconciliationEvidence,
  ): RecoveryInspectionEvidence {
    let changedFiles: readonly string[] = [];
    let diffDiagnostic: string | undefined;
    if (startupEvidence.baseline.status === 'complete') {
      try {
        changedFiles = new DiffService(this.#tracker)
          .attemptWindow(startupEvidence.baseline.baselineId)
          .changes.map((change) => change.path);
      } catch (error) {
        diffDiagnostic = error instanceof Error ? error.message : String(error);
      }
    } else {
      diffDiagnostic = startupEvidence.baseline.diagnostic;
    }
    return {
      observedAt: startupEvidence.observedAt,
      process: startupEvidence.process,
      baseline: startupEvidence.baseline,
      lock: startupEvidence.lock,
      changedFiles,
      changeCount: changedFiles.length,
      ...(diffDiagnostic === undefined ? {} : { diffDiagnostic }),
    };
  }

  #continuationSafetyBlock(
    evidence: StartupReconciliationEvidence,
  ): string | undefined {
    const processBlock = this.#processExitBlock(evidence);
    if (processBlock !== undefined) return processBlock;
    if (evidence.baseline.status !== 'complete') {
      return `continue blocked: durable attempt baseline is ${evidence.baseline.status}`;
    }
    if (
      evidence.lastAttempt === undefined
      || evidence.baseline.attemptId !== evidence.lastAttempt.attemptId
      || evidence.baseline.taskId !== evidence.taskId
    ) {
      return 'continue blocked: durable attempt baseline identity does not match recovery evidence';
    }
    return undefined;
  }

  #processExitBlock(evidence: StartupReconciliationEvidence): string | undefined {
    const attempt = evidence.lastAttempt;
    if (attempt === undefined) return undefined;
    if (attempt.status === 'pending') {
      return 'recovery blocked: the prior attempt has no durable process identity';
    }
    const process = evidence.process;
    if (process.identity !== 'matched') {
      return `recovery blocked: prior process identity is ${process.identity}`;
    }
    if (
      process.pid !== attempt.pid
      || process.processStartedAt !== attempt.processStartedAt
    ) {
      return 'recovery blocked: prior process PID/start time does not match the durable attempt';
    }
    if (process.terminalState !== 'exited') {
      return `recovery blocked: prior process is ${process.terminalState}, not proven exited`;
    }
    return undefined;
  }

  #hasDurableRejectedPrelaunchEvidence(
    evidence: StartupReconciliationEvidence,
  ): boolean {
    const attempt = evidence.lastAttempt;
    if (attempt === undefined || attempt.status !== 'pending') return false;
    const row = this.#database.connection
      .prepare(
        `SELECT 1 AS present
         FROM pending_actions AS agent_run
         JOIN pending_actions AS guard_decision
           ON guard_decision.task_id = agent_run.task_id
         WHERE agent_run.task_id = ?
           AND agent_run.action_type = 'agent-run'
           AND agent_run.status = 'failed'
           AND json_extract(agent_run.payload_json, '$.attemptId') = ?
           AND json_extract(agent_run.payload_json, '$.replayPolicy') = 'never-auto-replay'
           AND guard_decision.action_type = 'guard_decision'
           AND json_extract(guard_decision.payload_json, '$.attemptId') = ?
           AND json_extract(guard_decision.payload_json, '$.scope.kind') = 'adapter_start'
           AND json_extract(guard_decision.payload_json, '$.userConfirmationRequired') = 0
           AND (
             (
               json_extract(guard_decision.payload_json, '$.mode') = 'disabled'
               AND json_extract(
                 guard_decision.payload_json,
                 '$.capabilityEvidence.verified'
               ) = 0
               AND agent_run.error_text =
                 'ProjectGuard start is not auto-allowed (disabled): '
                 || json_extract(guard_decision.payload_json, '$.reason')
             )
             OR
             (
               json_extract(guard_decision.payload_json, '$.mode') = 'auto_allowed'
               AND json_extract(
                 guard_decision.payload_json,
                 '$.capabilityEvidence.verified'
               ) = 1
               AND substr(agent_run.error_text, 1, 16) = 'AdapterDisabled:'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM log_index
             WHERE task_id = agent_run.task_id AND attempt_id = ?
           )
         LIMIT 1`,
      )
      .get(
        evidence.taskId,
        attempt.attemptId,
        attempt.attemptId,
        attempt.attemptId,
      );
    return row !== undefined;
  }

  #commitOperatorTransition(input: {
    readonly task: PersistedTask;
    readonly reduced: Transitioned;
    readonly event: WorkflowEvent;
    readonly operation: 'inspect';
    readonly episodeAttemptId: string;
    readonly actionId: string;
    readonly idempotencyKey: string;
    readonly evidence: RecoveryInspectionEvidence;
  }): void {
    const now = this.#now().toISOString();
    withTransaction(this.#database.connection, () => {
      this.#assertWorkflowVersion(input.task);
      this.#insertOperatorIntent(input, now);
      const snapshot = canonicalSnapshot(input.reduced);
      this.#writeTransition(input.task, snapshot, input.event, now);
      this.#completeOperator(input.actionId, now, {
        operation: input.operation,
        workflowState: snapshot.state,
        workflowVersion: input.task.workflowVersion + 1,
        evidence: input.evidence,
      });
    });
  }

  #commitContinue(input: {
    readonly task: PersistedTask;
    readonly reduced: Transitioned;
    readonly event: WorkflowEvent;
    readonly episodeAttemptId: string;
    readonly actionId: string;
    readonly idempotencyKey: string;
    readonly evidence: RecoveryInspectionEvidence;
    readonly activeLock: ProjectLock;
    readonly effectIntents: readonly RecoveryEffectIntent[];
  }): void {
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const leaseExpiresAt = new Date(
      nowDate.getTime() + this.#leaseDurationMs,
    ).toISOString();
    withTransaction(this.#database.connection, () => {
      this.#assertWorkflowVersion(input.task);
      this.#insertOperatorIntent({ ...input, operation: 'continue' }, now);
      const takeover = this.#database.connection
        .prepare(
          `UPDATE project_locks
           SET owner_token = ?, owner_instance_id = ?, heartbeat_at = ?,
               lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND task_id = ? AND owner_instance_id = ?
             AND released_at IS NULL`,
        )
        .run(
          this.#ownerInstanceId,
          this.#ownerInstanceId,
          now,
          leaseExpiresAt,
          now,
          input.activeLock.lockId,
          input.task.taskId,
          input.activeLock.ownerInstanceId,
        );
      if (takeover.changes !== 1) {
        throw new Error('recovery lock takeover lost its owner/version race');
      }

      const snapshot = canonicalSnapshot(input.reduced);
      this.#writeTransition(input.task, snapshot, input.event, now);
      this.#recordEventInTransaction(input.task.taskId, 'RECOVERY_LOCK_TAKEOVER', {
        episodeAttemptId: input.episodeAttemptId,
        lockId: input.activeLock.lockId,
        previousOwnerInstanceId: input.activeLock.ownerInstanceId,
        ownerInstanceId: this.#ownerInstanceId,
        process: input.evidence.process,
        baseline: input.evidence.baseline,
      }, now);
      for (const effectIntent of input.effectIntents) {
        this.#insertEffectIntent(input.task.taskId, effectIntent, now);
      }
      this.#completeOperator(input.actionId, now, {
        operation: 'continue',
        workflowState: snapshot.state,
        workflowVersion: input.task.workflowVersion + 1,
        lockId: input.activeLock.lockId,
        effectActionIds: input.effectIntents.map((intent) => intent.actionId),
      });
    });
  }

  #commitCancel(input: {
    readonly task: PersistedTask;
    readonly reduced: Transitioned;
    readonly event: WorkflowEvent;
    readonly recoveryEpisodeKey: string;
    readonly episodeAttemptId?: string;
    readonly actionId: string;
    readonly idempotencyKey: string;
    readonly evidence: RecoveryInspectionEvidence;
    readonly activeLock: ProjectLock;
  }): void {
    const now = this.#now().toISOString();
    withTransaction(this.#database.connection, () => {
      this.#assertWorkflowVersion(input.task);
      this.#insertOperatorIntent({ ...input, operation: 'cancel' }, now);
      const snapshot = canonicalSnapshot(input.reduced);
      this.#writeTransition(input.task, snapshot, input.event, now);
      this.#database.connection
        .prepare(
          `INSERT INTO project_lock_reconciliations(
             lock_id, task_id, decision, reason, evidence,
             lock_snapshot_json, reconciled_at
           ) VALUES (?, ?, 'release', ?, ?, ?, ?)`,
        )
        .run(
          input.activeLock.lockId,
          input.task.taskId,
          'operator cancelled after restart inspection',
          serializeJsonValue({
            recoveryEpisodeKey: input.recoveryEpisodeKey,
            ...(input.episodeAttemptId === undefined
              ? {}
              : { episodeAttemptId: input.episodeAttemptId }),
            process: input.evidence.process,
            baseline: input.evidence.baseline,
          }),
          serializeJsonValue(input.activeLock),
          now,
        );
      const deleted = this.#database.connection
        .prepare(
          `DELETE FROM project_locks
           WHERE id = ? AND task_id = ? AND owner_instance_id = ?
             AND released_at IS NULL`,
        )
        .run(
          input.activeLock.lockId,
          input.task.taskId,
          input.activeLock.ownerInstanceId,
        );
      if (deleted.changes !== 1) {
        throw new Error('recovery cancel could not delete the audited project lock');
      }
      this.#recordEventInTransaction(input.task.taskId, 'RECOVERY_LOCK_RELEASED', {
        recoveryEpisodeKey: input.recoveryEpisodeKey,
        ...(input.episodeAttemptId === undefined
          ? {}
          : { episodeAttemptId: input.episodeAttemptId }),
        lockId: input.activeLock.lockId,
        previousOwnerInstanceId: input.activeLock.ownerInstanceId,
      }, now);
      this.#completeOperator(input.actionId, now, {
        operation: 'cancel',
        workflowState: snapshot.state,
        workflowVersion: input.task.workflowVersion + 1,
        lockId: input.activeLock.lockId,
      });
    });
  }

  #insertOperatorIntent(
    input: {
      readonly task: PersistedTask;
      readonly operation: 'inspect' | 'continue' | 'cancel';
      readonly recoveryEpisodeKey?: string;
      readonly episodeAttemptId?: string;
      readonly actionId: string;
      readonly idempotencyKey: string;
      readonly evidence: RecoveryInspectionEvidence;
    },
    now: string,
  ): void {
    const recoveryEpisodeKey = input.recoveryEpisodeKey ?? input.episodeAttemptId;
    if (recoveryEpisodeKey === undefined) {
      throw new Error('recovery operator requires an episode key');
    }
    this.#database.connection
      .prepare(
        `INSERT INTO pending_actions(
           id, task_id, idempotency_key, action_type, payload_json,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 'recovery-operator', ?, 'intent', ?, ?)`,
      )
      .run(
        input.actionId,
        input.task.taskId,
        input.idempotencyKey,
        serializeJsonValue({
          schemaVersion: 1,
          operation: input.operation,
          recoveryEpisodeKey,
          ...(input.episodeAttemptId === undefined
            ? {}
            : { episodeAttemptId: input.episodeAttemptId }),
          expectedWorkflowVersion: input.task.workflowVersion,
          ownerInstanceId: this.#ownerInstanceId,
          evidence: input.evidence,
        }),
        now,
        now,
      );
  }

  #insertEffectIntent(
    taskId: TaskId,
    intent: RecoveryEffectIntent,
    now: string,
  ): void {
    this.#database.connection
      .prepare(
        `INSERT INTO pending_actions(
           id, task_id, idempotency_key, action_type, payload_json,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'intent', ?, ?)`,
      )
      .run(
        intent.actionId,
        taskId,
        intent.idempotencyKey,
        intent.actionType,
        serializeJsonValue({
          schemaVersion: 1,
          effect: intent.effect,
          replayPolicy: intent.actionType === 'agent-run'
            ? 'never-auto-replay'
            : 'reconcile-before-retry',
          recoveredBy: this.#ownerInstanceId,
        }),
        now,
        now,
      );
  }

  #writeTransition(
    task: PersistedTask,
    snapshot: WorkflowSnapshot,
    event: WorkflowEvent,
    now: string,
  ): void {
    const nextVersion = task.workflowVersion + 1;
    const serializedSnapshot = serializeJsonValue(snapshot);
    const updated = this.#database.connection
      .prepare(
        `UPDATE tasks
         SET status = ?, workflow_version = ?, workflow_snapshot = ?, updated_at = ?
         WHERE id = ? AND workflow_version = ?`,
      )
      .run(
        snapshot.state,
        nextVersion,
        serializedSnapshot,
        now,
        task.taskId,
        task.workflowVersion,
      );
    if (updated.changes !== 1) {
      throw new Error('recovery task workflow version changed concurrently');
    }
    this.#database.connection
      .prepare(
        `INSERT INTO workflow_transitions(
           task_id, from_state, to_state, event_type, workflow_version,
           snapshot_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.taskId,
        task.status,
        snapshot.state,
        event.type,
        nextVersion,
        serializedSnapshot,
        now,
      );
    this.#recordEventInTransaction(task.taskId, event.type, {
      event,
      workflowVersion: nextVersion,
      recoveredBy: this.#ownerInstanceId,
    }, now);
  }

  #completeOperator(actionId: string, now: string, result: unknown): void {
    const completed = this.#database.connection
      .prepare(
        `UPDATE pending_actions
         SET status = 'completed', result_json = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'intent'`,
      )
      .run(serializeJsonValue(result), now, now, actionId);
    if (completed.changes !== 1) {
      throw new Error('recovery operator action could not be completed exactly once');
    }
  }

  #recordEvent(taskId: TaskId, eventType: string, payload: unknown): void {
    withTransaction(this.#database.connection, () => {
      this.#recordEventInTransaction(
        taskId,
        eventType,
        payload,
        this.#now().toISOString(),
      );
    });
  }

  #recordEventInTransaction(
    taskId: TaskId,
    eventType: string,
    payload: unknown,
    now: string,
  ): void {
    this.#database.connection
      .prepare(
        'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(taskId, eventType, serializeJsonValue(payload), now);
  }

  #assertWorkflowVersion(task: PersistedTask): void {
    const current = this.#requireTask(task.taskId);
    if (current.workflowVersion !== task.workflowVersion || current.status !== task.status) {
      throw new Error('recovery task workflow version changed concurrently');
    }
  }

  #existingOperation(idempotencyKey: string): OperatorActionRow | undefined {
    return this.#database.connection
      .prepare(
        `SELECT id, status, result_json
         FROM pending_actions WHERE idempotency_key = ? AND action_type = 'recovery-operator'`,
      )
      .get(idempotencyKey) as OperatorActionRow | undefined;
  }

  #requireActiveLock(taskId: TaskId): ProjectLock {
    const rows = this.#database.connection
      .prepare(
        `SELECT id, project_id, task_id, path, canonical_root, comparison_key,
                display_root, path_flavor, owner_token, owner_instance_id,
                acquired_at, lease_expires_at, heartbeat_at, updated_at, released_at
         FROM project_locks WHERE task_id = ? AND released_at IS NULL
         ORDER BY acquired_at, id`,
      )
      .all(taskId) as unknown as ActiveLockRow[];
    if (rows.length !== 1 || rows[0] === undefined) {
      throw new Error('recovery requires exactly one active project lock');
    }
    return lockFromRow(rows[0]);
  }

  #requireEpisodeAttemptId(taskId: TaskId): string {
    const attemptId = this.#latestEpisodeAttemptId(taskId);
    if (attemptId === undefined) throw new Error('recovery task has no prior attempt');
    return attemptId;
  }

  #latestEpisodeAttemptId(taskId: TaskId): string | undefined {
    const row = this.#database.connection
      .prepare(
        `SELECT id FROM run_attempts WHERE task_id = ?
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId) as { readonly id: string } | undefined;
    return row?.id;
  }

  #operatorKey(
    taskId: TaskId,
    recoveryEpisodeKey: string,
    operation: 'inspect' | 'continue' | 'cancel',
  ): string {
    return `${taskId}:recovery-operator:${recoveryEpisodeKey}:${operation}`;
  }

  #nextId(kind: RecoveryIdKind): string {
    const value = this.#idFactory(kind).trim();
    if (value.length === 0) throw new Error(`idFactory returned an empty ${kind} ID`);
    return value;
  }

  #requireTask(taskId: TaskId): PersistedTask {
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new Error(`recovery task not found: ${taskId}`);
    return task;
  }

  #blocked(
    task: PersistedTask,
    reason: string,
    evidence?: RecoveryInspectionEvidence,
  ): RecoveryOperationResult {
    return {
      status: 'blocked',
      workflowSnapshot: task.workflowSnapshot,
      reason,
      ...(evidence === undefined ? {} : { evidence }),
    };
  }
}
