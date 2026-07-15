import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import type { AttemptId, TaskId } from '../domain/ids.js';
import type { AgentKind, AgentRole } from '../domain/task.js';
import { ActionRepository } from '../persistence/action-repository.js';

/**
 * Exact launch intent bound into a one-time authorization.
 * CodexAdapter must match this intent when consuming the authorization id.
 */
export interface LaunchAuthorizationIntent {
  readonly taskId: TaskId;
  readonly attemptId: AttemptId;
  readonly adapterKind: AgentKind;
  readonly adapterVersion: string;
  readonly adapterPlatform: string;
  readonly role: AgentRole;
  readonly mode: string;
  readonly guardDecisionId: string;
  readonly budgetReservationId: string;
  readonly schemaPath: string;
  readonly nonGit: boolean;
}

export type LaunchAuthorizationStatus = 'issued' | 'consumed';

/**
 * Durable store-backed one-time launch authorization.
 * The opaque authorizationId is the only value adapters accept — never a
 * forgeable plain WorkerStartGateRecord or caller booleans.
 */
export interface LaunchAuthorizationRecord extends LaunchAuthorizationIntent {
  readonly authorizationId: string;
  readonly status: LaunchAuthorizationStatus;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly consumedAt?: string;
}

export type LaunchAuthorizationConsumeResult =
  | {
      readonly ok: true;
      readonly record: LaunchAuthorizationRecord;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export interface LaunchAuthorizationPort {
  /**
   * Atomically verify exact intent and mark authorization consumed (one-time).
   * Missing, forged, mismatched, expired, or reused ⇒ ok=false, zero start.
   */
  consumeAndVerify(
    authorizationId: string,
    intent: LaunchAuthorizationIntent,
    options?: { readonly nowMs?: number },
  ): LaunchAuthorizationConsumeResult;
}

const ACTION_TYPE = 'launch_authorization';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAgentKind(value: unknown): value is AgentKind {
  return value === 'codex' || value === 'claude' || value === 'grok';
}

function isAgentRole(value: unknown): value is AgentRole {
  return value === 'master' || value === 'implementer' || value === 'reviewer';
}

function parseAuthorization(
  payload: unknown,
): LaunchAuthorizationRecord | undefined {
  if (!isRecord(payload)) return undefined;
  const authorizationId = payload.authorizationId;
  const status = payload.status;
  const taskId = payload.taskId;
  const attemptId = payload.attemptId;
  const adapterKind = payload.adapterKind;
  const adapterVersion = payload.adapterVersion;
  const adapterPlatform = payload.adapterPlatform;
  const role = payload.role;
  const mode = payload.mode;
  const guardDecisionId = payload.guardDecisionId;
  const budgetReservationId = payload.budgetReservationId;
  const schemaPath = payload.schemaPath;
  const nonGit = payload.nonGit;
  const expiresAt = payload.expiresAt;
  const createdAt = payload.createdAt;
  const consumedAt = payload.consumedAt;

  if (
    typeof authorizationId !== 'string'
    || authorizationId.trim().length === 0
    || (status !== 'issued' && status !== 'consumed')
    || typeof taskId !== 'string'
    || typeof attemptId !== 'string'
    || !isAgentKind(adapterKind)
    || typeof adapterVersion !== 'string'
    || adapterVersion.trim().length === 0
    || typeof adapterPlatform !== 'string'
    || adapterPlatform.trim().length === 0
    || !isAgentRole(role)
    || typeof mode !== 'string'
    || mode.trim().length === 0
    || typeof guardDecisionId !== 'string'
    || guardDecisionId.trim().length === 0
    || typeof budgetReservationId !== 'string'
    || budgetReservationId.trim().length === 0
    || typeof schemaPath !== 'string'
    || schemaPath.trim().length === 0
    || typeof nonGit !== 'boolean'
    || typeof expiresAt !== 'string'
    || typeof createdAt !== 'string'
  ) {
    return undefined;
  }

  return {
    authorizationId,
    status,
    taskId: taskId as TaskId,
    attemptId: attemptId as AttemptId,
    adapterKind,
    adapterVersion,
    adapterPlatform,
    role,
    mode,
    guardDecisionId,
    budgetReservationId,
    schemaPath,
    nonGit,
    expiresAt,
    createdAt,
    ...(typeof consumedAt === 'string' ? { consumedAt } : {}),
  };
}

function intentMatches(
  record: LaunchAuthorizationRecord,
  intent: LaunchAuthorizationIntent,
): boolean {
  return (
    record.taskId === intent.taskId
    && record.attemptId === intent.attemptId
    && record.adapterKind === intent.adapterKind
    && record.adapterVersion === intent.adapterVersion
    && record.adapterPlatform === intent.adapterPlatform
    && record.role === intent.role
    && record.mode === intent.mode
    && record.guardDecisionId === intent.guardDecisionId
    && record.budgetReservationId === intent.budgetReservationId
    && record.schemaPath === intent.schemaPath
    && record.nonGit === intent.nonGit
  );
}

function isExpired(expiresAt: string, nowMs: number): boolean {
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return true;
  return ms <= nowMs;
}

/**
 * SQLite/store-backed one-time launch authorization repository.
 * Issued only by the real Task13 WorkerStartGateVerifier after validating and
 * consuming capability, Guard, Budget, and Health evidence.
 */
export class LaunchAuthorizationRepository implements LaunchAuthorizationPort {
  readonly #actions: ActionRepository;

  public constructor(database: DatabaseSync) {
    this.#actions = new ActionRepository(database);
  }

  public issue(
    intent: LaunchAuthorizationIntent,
    options: {
      readonly nowIso: string;
      readonly expiresAt: string;
      readonly authorizationId?: string;
    },
  ): LaunchAuthorizationRecord {
    const authorizationId = options.authorizationId ?? randomUUID();
    const record: LaunchAuthorizationRecord = Object.freeze({
      authorizationId,
      status: 'issued',
      taskId: intent.taskId,
      attemptId: intent.attemptId,
      adapterKind: intent.adapterKind,
      adapterVersion: intent.adapterVersion,
      adapterPlatform: intent.adapterPlatform,
      role: intent.role,
      mode: intent.mode,
      guardDecisionId: intent.guardDecisionId,
      budgetReservationId: intent.budgetReservationId,
      schemaPath: intent.schemaPath,
      nonGit: intent.nonGit,
      expiresAt: options.expiresAt,
      createdAt: options.nowIso,
    });
    // taskId lives in the authorization payload for intent matching.
    // Do not set pending_actions.task_id (FK to tasks) so issuance does not
    // require a pre-created task row; Worker/Task paths already own that row.
    this.#actions.recordIntent({
      actionId: authorizationId,
      idempotencyKey: `launch-authorization:${authorizationId}`,
      type: ACTION_TYPE,
      payload: record,
    });
    return record;
  }

  public get(authorizationId: string): LaunchAuthorizationRecord | undefined {
    const action = this.#actions.get(authorizationId);
    if (action === undefined || action.type !== ACTION_TYPE) {
      return undefined;
    }
    if (action.status === 'completed' && action.result !== undefined) {
      return parseAuthorization(action.result);
    }
    return parseAuthorization(action.payload);
  }

  public consumeAndVerify(
    authorizationId: string,
    intent: LaunchAuthorizationIntent,
    options: { readonly nowMs?: number } = {},
  ): LaunchAuthorizationConsumeResult {
    const nowMs = options.nowMs ?? Date.now();
    const id = typeof authorizationId === 'string'
      ? authorizationId.trim()
      : '';
    if (id.length === 0) {
      return { ok: false, reason: 'launch authorization id is missing' };
    }

    const action = this.#actions.get(id);
    if (action === undefined || action.type !== ACTION_TYPE) {
      return {
        ok: false,
        reason: `launch authorization not found: ${id}`,
      };
    }

    // Already completed ⇒ reused.
    if (action.status === 'completed') {
      return {
        ok: false,
        reason: `launch authorization already consumed (reused): ${id}`,
      };
    }
    if (action.status !== 'intent') {
      return {
        ok: false,
        reason: `launch authorization is not issued: ${id}`,
      };
    }

    const record = parseAuthorization(action.payload);
    if (record === undefined) {
      return {
        ok: false,
        reason: `launch authorization payload is invalid: ${id}`,
      };
    }
    if (record.status !== 'issued') {
      return {
        ok: false,
        reason: `launch authorization already consumed (reused): ${id}`,
      };
    }
    if (isExpired(record.expiresAt, nowMs)) {
      return {
        ok: false,
        reason: `launch authorization expired: ${id}`,
      };
    }
    if (!intentMatches(record, intent)) {
      return {
        ok: false,
        reason: `launch authorization intent mismatch: ${id}`,
      };
    }

    const consumedAt = new Date(nowMs).toISOString();
    const consumed: LaunchAuthorizationRecord = Object.freeze({
      ...record,
      status: 'consumed',
      consumedAt,
    });
    // markCompleted is atomic (UPDATE WHERE status='intent') — race-safe one-time.
    try {
      this.#actions.markCompleted(id, { result: consumed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/not found|intent/i.test(message)) {
        return {
          ok: false,
          reason: `launch authorization already consumed (reused): ${id}`,
        };
      }
      return {
        ok: false,
        reason: `launch authorization consume failed: ${message}`,
      };
    }
    return { ok: true, record: consumed };
  }
}
