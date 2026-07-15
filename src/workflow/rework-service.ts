import { randomUUID } from 'node:crypto';

import type { AttemptId, BaselineId, TaskId } from '../domain/ids.js';
import type { RequirementVersion } from '../domain/task.js';
import { ActionRepository } from '../persistence/action-repository.js';
import { AttemptRepository } from '../persistence/attempt-repository.js';
import type { ReadWriteDatabase } from '../persistence/database.js';
import { parseJsonValue, serializeJsonValue } from '../persistence/json-value.js';
import {
  TaskRepository,
  type PersistedTask,
} from '../persistence/task-repository.js';
import { withTransaction } from '../persistence/transaction.js';
import {
  expectedRoleForExecutionState,
  type WorkflowSnapshot,
} from './states.js';
import {
  MessageQueue,
  type ScopeChangePayload,
  type UserMessageRecord,
} from './message-queue.js';

export type ReworkIdKind = 'action' | 'attempt' | 'baseline' | 'requirement';

export interface ReworkServiceOptions {
  readonly database: ReadWriteDatabase;
  readonly messageQueue: MessageQueue;
  readonly now?: () => Date;
  readonly idFactory?: (kind: ReworkIdKind) => string;
}

export interface ApplyMessageOptions {
  readonly planningAttemptId?: AttemptId;
  readonly planningBaselineId?: string;
}

export type ApplyMessageResult =
  | {
      readonly status: 'applied';
      readonly messageId: string;
      readonly requirementVersion: RequirementVersion;
      readonly returnedToPlanning: boolean;
      readonly reviewsInvalidated: number;
    }
  | {
      readonly status: 'already_applied';
      readonly messageId: string;
      readonly requirementVersion: RequirementVersion;
      readonly returnedToPlanning: boolean;
      readonly reviewsInvalidated: number;
    };

export interface AttemptAdvanceGate {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly currentRequirementVersion: RequirementVersion;
}

/**
 * Applies durable user messages, including scope changes that mint a new
 * immutable requirement version, return the task to planning, and invalidate
 * all older review approvals/bundles/evidence.
 */
export class ReworkService {
  readonly #database: ReadWriteDatabase;
  readonly #tasks: TaskRepository;
  readonly #actions: ActionRepository;
  readonly #attempts: AttemptRepository;
  readonly #messages: MessageQueue;
  readonly #now: () => Date;
  readonly #idFactory: (kind: ReworkIdKind) => string;

  public constructor(options: ReworkServiceOptions) {
    this.#database = options.database;
    this.#tasks = new TaskRepository(options.database.connection);
    this.#actions = new ActionRepository(options.database.connection);
    this.#attempts = new AttemptRepository(options.database.connection);
    this.#messages = options.messageQueue;
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => randomUUID());
  }

  public applyMessage(
    messageId: string,
    options: ApplyMessageOptions = {},
  ): ApplyMessageResult {
    const message = this.#messages.get(messageId);
    if (message === undefined) {
      throw new Error(`user message not found: ${messageId}`);
    }
    if (message.state === 'applied') {
      const task = this.#requireTask(message.taskId);
      return {
        status: 'already_applied',
        messageId,
        requirementVersion: task.workflowSnapshot.requirementVersion,
        returnedToPlanning: message.kind === 'scope_change',
        reviewsInvalidated: 0,
      };
    }

    const idempotencyKey = `${message.taskId}:apply-message:${messageId}`;
    const existing = this.#findCompletedAction(idempotencyKey);
    if (existing !== undefined) {
      const task = this.#requireTask(message.taskId);
      return {
        status: 'already_applied',
        messageId,
        requirementVersion: task.workflowSnapshot.requirementVersion,
        returnedToPlanning: message.kind === 'scope_change',
        reviewsInvalidated: 0,
      };
    }

    // Application requires durable acknowledgement. Delivery alone is not enough.
    if (message.state !== 'acknowledged') {
      throw new Error(
        `cannot apply message ${messageId}: durable state must be acknowledged, got ${message.state}`,
      );
    }

    if (message.kind === 'operational') {
      return this.#applyOperational(message, idempotencyKey);
    }
    return this.#applyScopeChange(message, idempotencyKey, options);
  }

  public assertAttemptMayAdvance(input: {
    readonly taskId: TaskId;
    readonly attemptId: AttemptId;
  }): AttemptAdvanceGate {
    const task = this.#requireTask(input.taskId);
    const current = task.workflowSnapshot.requirementVersion;
    const ownership = this.#database.connection
      .prepare(
        `SELECT task_id AS taskId, status, requirement_version AS requirementVersion
         FROM run_attempts WHERE id = ?`,
      )
      .get(input.attemptId) as
      | {
          readonly taskId: string;
          readonly status: string;
          readonly requirementVersion: number;
        }
      | undefined;
    if (ownership === undefined) {
      return {
        allowed: false,
        reason: `attempt ${input.attemptId} is missing`,
        currentRequirementVersion: current,
      };
    }
    if (ownership.taskId !== input.taskId) {
      return {
        allowed: false,
        reason: `attempt ${input.attemptId} does not belong to task ${input.taskId}`,
        currentRequirementVersion: current,
      };
    }
    if (ownership.status !== 'pending' && ownership.status !== 'active') {
      return {
        allowed: false,
        reason:
          `attempt ${input.attemptId} has terminal/invalid status ${ownership.status} and cannot advance`,
        currentRequirementVersion: current,
      };
    }
    const attempt = this.#attempts.get(input.attemptId);
    if (attempt === undefined) {
      return {
        allowed: false,
        reason: `attempt ${input.attemptId} is missing from repository`,
        currentRequirementVersion: current,
      };
    }
    if (attempt.requirementVersion !== current) {
      return {
        allowed: false,
        reason:
          `stale attempt ${input.attemptId} is on requirement version `
          + `${String(attempt.requirementVersion)}; current is ${String(current)}`,
        currentRequirementVersion: current,
      };
    }
    return {
      allowed: true,
      currentRequirementVersion: current,
    };
  }

  #applyOperational(
    message: UserMessageRecord,
    idempotencyKey: string,
  ): ApplyMessageResult {
    const task = this.#requireTask(message.taskId);
    const actionId = this.#idFactory('action');
    const now = this.#now().toISOString();
    const requirementVersion = task.workflowSnapshot.requirementVersion;
    withTransaction(this.#database.connection, () => {
      this.#insertCompletedAction(actionId, message.taskId, idempotencyKey, {
        messageId: message.messageId,
        kind: 'operational',
        requirementVersion,
      }, {
        messageId: message.messageId,
        requirementVersion,
        returnedToPlanning: false,
        reviewsInvalidated: 0,
      }, now);
      this.#applyAcknowledgedMessage(message, requirementVersion, now);
      this.#database.connection
        .prepare(
          'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          message.taskId,
          'USER_MESSAGE_APPLIED',
          serializeJsonValue({
            messageId: message.messageId,
            kind: 'operational',
            requirementVersion,
          }),
          now,
        );
    });
    return {
      status: 'applied',
      messageId: message.messageId,
      requirementVersion,
      returnedToPlanning: false,
      reviewsInvalidated: 0,
    };
  }

  #applyScopeChange(
    message: UserMessageRecord,
    idempotencyKey: string,
    options: ApplyMessageOptions,
  ): ApplyMessageResult {
    const task = this.#requireTask(message.taskId);
    const scope = message.scopeChange;
    if (scope === undefined) {
      throw new Error(
        `scope_change message ${message.messageId} is missing scopeChange payload`,
      );
    }
    const nextVersion = task.workflowSnapshot.requirementVersion + 1;
    const planningAttemptId =
      options.planningAttemptId
      ?? (this.#idFactory('attempt') as AttemptId);
    const planningBaselineId =
      options.planningBaselineId
      ?? this.#idFactory('baseline');
    const actionId = this.#idFactory('action');
    const now = this.#now().toISOString();

    let reviewsInvalidated = 0;
    withTransaction(this.#database.connection, () => {
      this.#insertCompletedAction(actionId, message.taskId, idempotencyKey, {
        messageId: message.messageId,
        kind: 'scope_change',
        fromRequirementVersion: task.workflowSnapshot.requirementVersion,
        toRequirementVersion: nextVersion,
        planningAttemptId,
        planningBaselineId,
      }, {
        messageId: message.messageId,
        requirementVersion: nextVersion,
        returnedToPlanning: true,
        reviewsInvalidated: 0,
      }, now);

      this.#insertRequirementVersion(message.taskId, nextVersion, scope, now);
      reviewsInvalidated = this.#invalidateReviews(
        message.taskId,
        task.workflowSnapshot.requirementVersion,
        nextVersion,
        now,
      );
      this.#returnToPlanning(
        task,
        nextVersion,
        planningAttemptId,
        planningBaselineId as BaselineId,
        now,
      );
      this.#applyAcknowledgedMessage(message, nextVersion, now);
      this.#database.connection
        .prepare(
          `UPDATE pending_actions
           SET result_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          serializeJsonValue({
            messageId: message.messageId,
            requirementVersion: nextVersion,
            returnedToPlanning: true,
            reviewsInvalidated,
          }),
          now,
          actionId,
        );
      this.#database.connection
        .prepare(
          'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          message.taskId,
          'REQUIREMENT_VERSION_CREATED',
          serializeJsonValue({
            messageId: message.messageId,
            requirementVersion: nextVersion,
            planningAttemptId,
            planningBaselineId,
            reviewsInvalidated,
          }),
          now,
        );
    });

    return {
      status: 'applied',
      messageId: message.messageId,
      requirementVersion: nextVersion,
      returnedToPlanning: true,
      reviewsInvalidated,
    };
  }

  #insertRequirementVersion(
    taskId: TaskId,
    version: number,
    scope: ScopeChangePayload,
    now: string,
  ): void {
    this.#database.connection
      .prepare(
        `INSERT INTO requirement_versions(task_id, version, requirements, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        taskId,
        version,
        serializeJsonValue({
          requirements: scope.requirements,
          plan: scope.plan ?? null,
          acceptanceCriteria: scope.acceptanceCriteria ?? [],
          approved: false,
          planVersion: version,
        }),
        now,
      );
  }

  #invalidateReviews(
    taskId: TaskId,
    previousVersion: number,
    nextVersion: number,
    now: string,
  ): number {
    const rows = this.#database.connection
      .prepare(
        `SELECT id, verdict, payload_json AS payloadJson
         FROM reviews WHERE task_id = ?`,
      )
      .all(taskId) as Array<{
      readonly id: string;
      readonly verdict: string;
      readonly payloadJson: string;
    }>;
    let count = 0;
    for (const row of rows) {
      if (row.verdict === 'invalid') continue;
      const payload = objectValue(
        parseJsonValue(row.payloadJson, 'review payload'),
      ) ?? {};
      const payloadVersion =
        typeof payload.requirementVersion === 'number'
          ? payload.requirementVersion
          : previousVersion;
      if (payloadVersion >= nextVersion) continue;
      const nextPayload = {
        ...payload,
        requirementVersion: payloadVersion,
        invalidatedAt: now,
        invalidatedByRequirementVersion: nextVersion,
        previousVerdict: row.verdict,
        evidenceInvalidated: true,
        bundleInvalidated: true,
      };
      this.#database.connection
        .prepare(
          `UPDATE reviews
           SET verdict = 'invalid', payload_json = ?
           WHERE id = ?`,
        )
        .run(serializeJsonValue(nextPayload), row.id);
      count += 1;
    }
    return count;
  }

  #returnToPlanning(
    task: PersistedTask,
    requirementVersion: number,
    planningAttemptId: AttemptId,
    planningBaselineId: BaselineId,
    now: string,
  ): void {
    const nextVersion = task.workflowVersion + 1;
    const snapshot: WorkflowSnapshot = {
      state: 'planning',
      taskId: task.taskId,
      requirementVersion,
      reworkCount: task.workflowSnapshot.reworkCount,
      maxReworks: task.workflowSnapshot.maxReworks,
      pauseAfterAttempt: false,
      activeAttemptId: planningAttemptId,
      activeAttemptBaselineId: planningBaselineId,
      activeAttemptRole: expectedRoleForExecutionState('planning'),
    };
    const serialized = serializeJsonValue({
      state: snapshot.state,
      taskId: snapshot.taskId,
      requirementVersion: snapshot.requirementVersion,
      reworkCount: snapshot.reworkCount,
      maxReworks: snapshot.maxReworks,
      pauseAfterAttempt: snapshot.pauseAfterAttempt,
      activeAttemptId: snapshot.activeAttemptId,
      activeAttemptBaselineId: snapshot.activeAttemptBaselineId,
      activeAttemptRole: snapshot.activeAttemptRole,
    });
    const updated = this.#database.connection
      .prepare(
        `UPDATE tasks
         SET status = ?, workflow_version = ?, workflow_snapshot = ?, updated_at = ?
         WHERE id = ? AND workflow_version = ?`,
      )
      .run(
        'planning',
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
        'planning',
        'SCOPE_CHANGE_REQUIRES_REPLAN',
        nextVersion,
        serialized,
        now,
      );
  }

  /**
   * Transition acknowledged -> applied for exactly one durable row.
   * Must run inside the same transaction as task/version/review side effects.
   * Uses result_json.state = 'acknowledged' as the CAS predicate.
   */
  #applyAcknowledgedMessage(
    message: UserMessageRecord,
    requirementVersion: number,
    now: string,
  ): void {
    const result: Record<string, unknown> = {
      ...(message.result ?? {}),
      state: 'applied',
      kind: message.kind,
      ...(message.attemptId === undefined ? {} : { attemptId: message.attemptId }),
      ...(message.scopeChange === undefined ? {} : { scopeChange: message.scopeChange }),
      appliedAt: now,
      requirementVersion,
    };
    const updated = this.#database.connection
      .prepare(
        `UPDATE user_messages
         SET status = 'delivered', result_json = ?
         WHERE id = ?
           AND status = 'delivered'
           AND json_extract(result_json, '$.state') = 'acknowledged'`,
      )
      .run(serializeJsonValue(result), message.messageId);
    if (updated.changes !== 1) {
      throw new Error(
        `cannot apply message ${message.messageId}: expected exactly one acknowledged row`,
      );
    }
  }

  #findCompletedAction(idempotencyKey: string):
    | { readonly actionId: string }
    | undefined {
    const row = this.#database.connection
      .prepare(
        `SELECT id FROM pending_actions
         WHERE idempotency_key = ? AND status = 'completed'`,
      )
      .get(idempotencyKey) as { readonly id: string } | undefined;
    return row === undefined ? undefined : { actionId: row.id };
  }

  #insertCompletedAction(
    actionId: string,
    taskId: TaskId,
    idempotencyKey: string,
    payload: unknown,
    result: unknown,
    now: string,
  ): void {
    this.#database.connection
      .prepare(
        `INSERT INTO pending_actions(
           id, task_id, idempotency_key, action_type, payload_json,
           status, result_json, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, 'apply-user-message', ?, 'completed', ?, ?, ?, ?)`,
      )
      .run(
        actionId,
        taskId,
        idempotencyKey,
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
