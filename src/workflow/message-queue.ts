import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { AgentMessageState } from '../agents/agent-adapter.js';
import type { AttemptId, TaskId } from '../domain/ids.js';
import { ActionRepository } from '../persistence/action-repository.js';
import type { ReadWriteDatabase } from '../persistence/database.js';
import { parseJsonValue, serializeJsonValue } from '../persistence/json-value.js';
import { withTransaction } from '../persistence/transaction.js';

/**
 * Durable user-message lifecycle for Task 18.
 *
 * SQLite `user_messages.status` only stores `queued | delivered | failed`.
 * Extended lifecycle states (`acknowledged`, `applied`) and failure kinds
 * (`retry_safe`, `dead_letter`) live in `result_json` so reconciler evidence
 * stays consistent without a schema migration.
 */

export type UserMessageKind = 'operational' | 'scope_change';

export type MessageFailureKind = 'retry_safe' | 'dead_letter';

export interface ScopeChangePayload {
  readonly requirements: string;
  readonly plan?: string;
  readonly acceptanceCriteria?: readonly string[];
}

export interface UserMessageRecord {
  readonly messageId: string;
  readonly taskId: TaskId;
  readonly body: string;
  readonly state: AgentMessageState;
  readonly kind: UserMessageKind;
  readonly attemptId?: AttemptId;
  readonly scopeChange?: ScopeChangePayload;
  readonly failureKind?: MessageFailureKind;
  readonly error?: string;
  readonly createdAt: string;
  readonly deliveredAt?: string;
  readonly result?: Record<string, unknown>;
}

export interface EnqueueMessageInput {
  readonly taskId: TaskId;
  readonly body: string;
  readonly kind: UserMessageKind;
  readonly attemptId?: AttemptId;
  readonly scopeChange?: ScopeChangePayload;
  readonly messageId?: string;
}

export interface MessageQueueOptions {
  readonly database: ReadWriteDatabase;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  /** Default capability hint for deliverWhenSupported. */
  readonly realTimeInputSupported?: boolean;
}

interface MessageRow {
  readonly id: string;
  readonly task_id: string;
  readonly body: string;
  readonly status: string;
  readonly result_json: string | null;
  readonly error_text: string | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function logicalState(
  row: MessageRow,
  result: Record<string, unknown> | undefined,
): AgentMessageState {
  const resultState = result?.state;
  if (
    resultState === 'queued'
    || resultState === 'delivered'
    || resultState === 'acknowledged'
    || resultState === 'applied'
    || resultState === 'failed'
  ) {
    return resultState;
  }
  if (row.status === 'queued' || row.status === 'delivered' || row.status === 'failed') {
    return row.status;
  }
  throw new Error(`user message has an invalid status: ${row.id}`);
}

function columnStatusFor(state: AgentMessageState): 'queued' | 'delivered' | 'failed' {
  if (state === 'failed') return 'failed';
  if (state === 'queued') return 'queued';
  // delivered / acknowledged / applied all map to delivered column.
  return 'delivered';
}

const MESSAGE_STATE_ORDER: Readonly<Record<AgentMessageState, number>> = {
  queued: 0,
  delivered: 1,
  acknowledged: 2,
  applied: 3,
  failed: 4,
};

function canTransition(from: AgentMessageState, to: AgentMessageState): boolean {
  if (from === to) return true;
  if (from === 'failed' || from === 'applied') return false;
  if (from === 'queued') return to === 'delivered' || to === 'failed';
  if (from === 'delivered') {
    return to === 'acknowledged' || to === 'applied' || to === 'failed';
  }
  if (from === 'acknowledged') return to === 'applied' || to === 'failed';
  return false;
}

/** True when `current` is already at or past `target` on the success path. */
function alreadyAtOrPast(
  current: AgentMessageState,
  target: AgentMessageState,
): boolean {
  if (current === 'failed') return target === 'failed';
  if (target === 'failed') return false;
  return MESSAGE_STATE_ORDER[current] >= MESSAGE_STATE_ORDER[target];
}

export class MessageQueue {
  readonly #database: ReadWriteDatabase;
  readonly #connection: DatabaseSync;
  readonly #actions: ActionRepository;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #realTimeInputSupported: boolean;

  public constructor(options: MessageQueueOptions) {
    this.#database = options.database;
    this.#connection = options.database.connection;
    this.#actions = new ActionRepository(options.database.connection);
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => randomUUID());
    this.#realTimeInputSupported = options.realTimeInputSupported ?? false;
  }

  public enqueue(input: EnqueueMessageInput): UserMessageRecord {
    const body = input.body.trim();
    if (body === '') throw new Error('message body must be non-empty');
    if (input.kind === 'scope_change' && input.scopeChange === undefined) {
      throw new Error('scope_change messages require a scopeChange payload');
    }
    const messageId = (input.messageId ?? this.#idFactory()).trim();
    if (messageId === '') throw new Error('message id must be non-empty');
    const createdAt = this.#now().toISOString();
    const result = {
      state: 'queued' as const,
      kind: input.kind,
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      ...(input.scopeChange === undefined ? {} : { scopeChange: input.scopeChange }),
    };
    withTransaction(this.#connection, () => {
      this.#connection
        .prepare(
          `INSERT INTO user_messages(
             id, task_id, body, status, result_json, created_at
           ) VALUES (?, ?, ?, 'queued', ?, ?)`,
        )
        .run(
          messageId,
          input.taskId,
          body,
          serializeJsonValue(result),
          createdAt,
        );
      this.#connection
        .prepare(
          'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          input.taskId,
          'USER_MESSAGE_QUEUED',
          serializeJsonValue({
            messageId,
            kind: input.kind,
            attemptId: input.attemptId ?? null,
          }),
          createdAt,
        );
    });
    return this.get(messageId)!;
  }

  public get(messageId: string): UserMessageRecord | undefined {
    const row = this.#connection
      .prepare(
        `SELECT id, task_id, body, status, result_json, error_text, created_at, delivered_at
         FROM user_messages WHERE id = ?`,
      )
      .get(messageId) as unknown as MessageRow | undefined;
    return row === undefined ? undefined : this.#fromRow(row);
  }

  public listForTask(taskId: TaskId): readonly UserMessageRecord[] {
    const rows = this.#connection
      .prepare(
        `SELECT id, task_id, body, status, result_json, error_text, created_at, delivered_at
         FROM user_messages WHERE task_id = ? ORDER BY created_at, id`,
      )
      .all(taskId) as unknown as MessageRow[];
    return rows.map((row) => this.#fromRow(row));
  }

  public markDelivered(
    messageId: string,
    options: { readonly attemptId?: AttemptId } = {},
  ): UserMessageRecord {
    return this.#transition(messageId, 'delivered', {
      attemptId: options.attemptId,
      setDeliveredAt: true,
    });
  }

  public markAcknowledged(messageId: string): UserMessageRecord {
    return this.#transition(messageId, 'acknowledged');
  }

  public markApplied(
    messageId: string,
    options: {
      readonly appliedAt?: string;
      readonly requirementVersion?: number;
    } = {},
  ): UserMessageRecord {
    return this.#transition(messageId, 'applied', {
      appliedAt: options.appliedAt ?? this.#now().toISOString(),
      requirementVersion: options.requirementVersion,
    });
  }

  public markFailed(
    messageId: string,
    options: {
      readonly error: string;
      readonly failureKind: MessageFailureKind;
    },
  ): UserMessageRecord {
    const error = options.error.trim();
    if (error === '') throw new Error('failure error must be non-empty');
    return this.#transition(messageId, 'failed', {
      error,
      failureKind: options.failureKind,
    });
  }

  /**
   * Delivery is allowed only when real-time input is supported while running,
   * or when the attempt has settled (safe point). Unsupported real-time input
   * must remain queued until that safe point.
   */
  public deliverWhenSupported(
    messageId: string,
    options: {
      readonly attemptRunning: boolean;
      readonly realTimeInputSupported?: boolean;
    },
  ): UserMessageRecord {
    const realTime =
      options.realTimeInputSupported ?? this.#realTimeInputSupported;
    if (options.attemptRunning && !realTime) {
      throw new Error(
        'message remains queued until a verified safe point: real-time input is unsupported while the attempt is running',
      );
    }
    return this.markDelivered(messageId);
  }

  public retryFailed(
    messageId: string,
    options: {
      readonly actionId: string;
      readonly idempotencyKey: string;
    },
  ): UserMessageRecord {
    const current = this.get(messageId);
    if (current === undefined) {
      throw new Error(`user message not found: ${messageId}`);
    }
    if (current.state !== 'failed' && current.state !== 'queued') {
      throw new Error(
        `message ${messageId} cannot be retried from state ${current.state}`,
      );
    }
    if (current.state === 'queued') {
      // Idempotent: already re-queued.
      return current;
    }
    if (current.failureKind === 'dead_letter') {
      throw new Error(
        `message ${messageId} is dead-lettered and is not retryable`,
      );
    }
    if (current.failureKind !== 'retry_safe') {
      throw new Error(
        `message ${messageId} failure is not retry-safe`,
      );
    }

    const existing = this.#actions.get(options.actionId);
    if (existing !== undefined) {
      if (
        existing.idempotencyKey === options.idempotencyKey
        && existing.status === 'completed'
      ) {
        return this.get(messageId)!;
      }
      throw new Error(
        `retry action already recorded with different outcome: ${options.actionId}`,
      );
    }

    const byKey = this.#connection
      .prepare(
        `SELECT id, status FROM pending_actions WHERE idempotency_key = ?`,
      )
      .get(options.idempotencyKey) as
      | { readonly id: string; readonly status: string }
      | undefined;
    if (byKey?.status === 'completed') {
      return this.get(messageId)!;
    }

    const now = this.#now().toISOString();
    withTransaction(this.#connection, () => {
      this.#connection
        .prepare(
          `INSERT INTO pending_actions(
             id, task_id, idempotency_key, action_type, payload_json,
             status, result_json, created_at, updated_at, completed_at
           ) VALUES (?, ?, ?, 'message-retry', ?, 'completed', ?, ?, ?, ?)`,
        )
        .run(
          options.actionId,
          current.taskId,
          options.idempotencyKey,
          serializeJsonValue({
            messageId,
            previousState: 'failed',
            failureKind: current.failureKind,
          }),
          serializeJsonValue({ messageId, state: 'queued' }),
          now,
          now,
          now,
        );
      const result = {
        ...(current.result ?? {}),
        state: 'queued' as const,
        failureKind: current.failureKind,
        retriedAt: now,
        retryActionId: options.actionId,
      };
      this.#connection
        .prepare(
          `UPDATE user_messages
           SET status = 'queued', result_json = ?, error_text = NULL, delivered_at = NULL
           WHERE id = ?`,
        )
        .run(serializeJsonValue(result), messageId);
      this.#connection
        .prepare(
          'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          current.taskId,
          'USER_MESSAGE_RETRIED',
          serializeJsonValue({ messageId, actionId: options.actionId }),
          now,
        );
    });
    return this.get(messageId)!;
  }

  #transition(
    messageId: string,
    to: AgentMessageState,
    extras: {
      readonly attemptId?: AttemptId;
      readonly setDeliveredAt?: boolean;
      readonly appliedAt?: string;
      readonly requirementVersion?: number;
      readonly error?: string;
      readonly failureKind?: MessageFailureKind;
    } = {},
  ): UserMessageRecord {
    const current = this.get(messageId);
    if (current === undefined) {
      throw new Error(`user message not found: ${messageId}`);
    }
    // Idempotent replay: once a transition has succeeded, replaying an earlier
    // or equal mark* is a no-op that returns the durable current record.
    if (current.state === to || alreadyAtOrPast(current.state, to)) {
      return current;
    }
    if (!canTransition(current.state, to)) {
      throw new Error(
        `invalid message state transition for ${messageId}: ${current.state} -> ${to}`,
      );
    }
    const now = this.#now().toISOString();
    const columnStatus = columnStatusFor(to);
    const result: Record<string, unknown> = {
      ...(current.result ?? {}),
      state: to,
      kind: current.kind,
      ...(current.attemptId === undefined && extras.attemptId === undefined
        ? {}
        : { attemptId: extras.attemptId ?? current.attemptId }),
      ...(current.scopeChange === undefined
        ? {}
        : { scopeChange: current.scopeChange }),
      ...(extras.appliedAt === undefined ? {} : { appliedAt: extras.appliedAt }),
      ...(extras.requirementVersion === undefined
        ? {}
        : { requirementVersion: extras.requirementVersion }),
      ...(extras.failureKind === undefined
        ? {}
        : { failureKind: extras.failureKind }),
      ...(extras.error === undefined ? {} : { error: extras.error }),
    };
    withTransaction(this.#connection, () => {
      this.#connection
        .prepare(
          `UPDATE user_messages
           SET status = ?, result_json = ?, error_text = ?,
               delivered_at = CASE
                 WHEN ? = 1 THEN COALESCE(delivered_at, ?)
                 ELSE delivered_at
               END
           WHERE id = ?`,
        )
        .run(
          columnStatus,
          serializeJsonValue(result),
          extras.error ?? null,
          extras.setDeliveredAt || to === 'delivered' ? 1 : 0,
          now,
          messageId,
        );
      this.#connection
        .prepare(
          'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          current.taskId,
          'USER_MESSAGE_STATE',
          serializeJsonValue({
            messageId,
            from: current.state,
            to,
            failureKind: extras.failureKind ?? null,
          }),
          now,
        );
    });
    return this.get(messageId)!;
  }

  #fromRow(row: MessageRow): UserMessageRecord {
    const result = row.result_json === null
      ? undefined
      : objectValue(parseJsonValue(row.result_json, 'message result'));
    const state = logicalState(row, result);
    const kind =
      result?.kind === 'scope_change' || result?.kind === 'operational'
        ? result.kind
        : 'operational';
    const attemptId =
      typeof result?.attemptId === 'string' ? (result.attemptId as AttemptId) : undefined;
    const failureKind =
      result?.failureKind === 'retry_safe' || result?.failureKind === 'dead_letter'
        ? result.failureKind
        : undefined;
    const scopeChange = objectValue(result?.scopeChange) as ScopeChangePayload | undefined;
    return {
      messageId: row.id,
      taskId: row.task_id as TaskId,
      body: row.body,
      state,
      kind,
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(scopeChange === undefined ? {} : { scopeChange }),
      ...(failureKind === undefined ? {} : { failureKind }),
      ...(row.error_text === null
        ? typeof result?.error === 'string'
          ? { error: result.error }
          : {}
        : { error: row.error_text }),
      createdAt: row.created_at,
      ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
      ...(result === undefined ? {} : { result }),
    };
  }
}
