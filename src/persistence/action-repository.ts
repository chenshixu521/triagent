import type { DatabaseSync } from 'node:sqlite';

import { asTaskId, type TaskId } from '../domain/ids.js';
import { parseJsonValue, serializeJsonValue } from './json-value.js';
import { withTransaction } from './transaction.js';

export type ActionStatus = 'intent' | 'completed' | 'failed';

export interface PendingAction {
  readonly actionId: string;
  readonly taskId?: TaskId;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly payload: unknown;
  readonly status: ActionStatus;
  readonly result?: unknown;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecordIntentInput {
  readonly actionId: string;
  readonly taskId?: TaskId;
  readonly idempotencyKey: string;
  readonly type: string;
  readonly payload: unknown;
}

interface ActionRow {
  readonly id: string;
  readonly task_id: string | null;
  readonly idempotency_key: string;
  readonly action_type: string;
  readonly payload_json: string;
  readonly status: string;
  readonly result_json: string | null;
  readonly error_text: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(`${field} must be non-empty`);
  }
  return trimmed;
}

function actionFromRow(row: ActionRow): PendingAction {
  if (row.status !== 'intent' && row.status !== 'completed' && row.status !== 'failed') {
    throw new Error(`invalid pending action status: ${row.status}`);
  }
  const payload = parseJsonValue(row.payload_json, 'action payload');
  const result = row.result_json === null
    ? undefined
    : parseJsonValue(row.result_json, 'action result');
  return {
    actionId: nonEmpty(row.id, 'action id'),
    ...(row.task_id === null ? {} : { taskId: asTaskId(row.task_id) }),
    idempotencyKey: nonEmpty(row.idempotency_key, 'idempotency key'),
    type: nonEmpty(row.action_type, 'action type'),
    payload,
    status: row.status,
    ...(result === undefined ? {} : { result }),
    ...(row.error_text === null ? {} : { error: row.error_text }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_ACTION = `SELECT id, task_id, idempotency_key, action_type, payload_json,
  status, result_json, error_text, created_at, updated_at FROM pending_actions`;

export class ActionRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public recordIntent(input: RecordIntentInput): PendingAction {
    const actionId = nonEmpty(input.actionId, 'action id');
    const idempotencyKey = nonEmpty(input.idempotencyKey, 'idempotency key');
    const type = nonEmpty(input.type, 'action type');
    const payload = serializeJsonValue(input.payload);
    const now = new Date().toISOString();
    try {
      withTransaction(this.database, () => {
        this.database
          .prepare(
            `INSERT INTO pending_actions(
              id, task_id, idempotency_key, action_type, payload_json,
              status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'intent', ?, ?)`,
          )
          .run(
            actionId,
            input.taskId ?? null,
            idempotencyKey,
            type,
            payload,
            now,
            now,
          );
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: pending_actions\.idempotency_key/i.test(error.message)
      ) {
        throw new Error(`idempotency key already recorded: ${idempotencyKey}`, {
          cause: error,
        });
      }
      throw error;
    }
    return this.get(actionId)!;
  }

  public markCompleted(
    actionId: string,
    completion: { readonly result?: unknown } = {},
  ): void {
    const resultJson = completion.result === undefined
      ? null
      : serializeJsonValue(completion.result);
    this.finish(actionId, 'completed', resultJson, null);
  }

  public markFailed(
    actionId: string,
    failure: { readonly error: string; readonly result?: unknown },
  ): void {
    const error = nonEmpty(failure.error, 'action error');
    const resultJson = failure.result === undefined
      ? null
      : serializeJsonValue(failure.result);
    this.finish(actionId, 'failed', resultJson, error);
  }

  public get(actionId: string): PendingAction | undefined {
    const row = this.database
      .prepare(`${SELECT_ACTION} WHERE id = ?`)
      .get(actionId) as unknown as ActionRow | undefined;
    return row === undefined ? undefined : actionFromRow(row);
  }

  public listPending(): readonly PendingAction[] {
    const rows = this.database
      .prepare(`${SELECT_ACTION} WHERE status = 'intent' ORDER BY created_at, id`)
      .all() as unknown as ActionRow[];
    return rows.map(actionFromRow);
  }

  private finish(
    actionId: string,
    status: 'completed' | 'failed',
    resultJson: string | null,
    error: string | null,
  ): void {
    withTransaction(this.database, () => {
      const now = new Date().toISOString();
      const result = this.database
        .prepare(
          `UPDATE pending_actions
           SET status = ?, result_json = ?, error_text = ?, completed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'intent'`,
        )
        .run(status, resultJson, error, now, now, nonEmpty(actionId, 'action id'));
      if (result.changes !== 1) {
        throw new Error(`pending action intent not found: ${actionId}`);
      }
    });
  }
}
