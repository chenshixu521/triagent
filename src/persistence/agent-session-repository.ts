import type { DatabaseSync } from 'node:sqlite';

import {
  asAttemptId,
  asConversationId,
  asTaskId,
  type AttemptId,
  type ConversationId,
  type TaskId,
} from '../domain/ids.js';
import { AGENT_KINDS, AGENT_ROLES, type AgentKind, type AgentRole } from '../domain/task.js';
import { withTransaction } from './transaction.js';

export type AgentSessionStatus = 'active' | 'completed_persisted' | 'unresumable';

export type AgentSessionExitReason =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'timed_out'
  | 'killed_unpersisted';

export type AgentSessionMode =
  | 'workspace_write'
  | 'project_write'
  | 'read_only'
  | 'patch_mode'
  | 'auto_allowed'
  | 'disabled';

export interface AgentSessionRecord {
  readonly sessionId: string;
  readonly taskId: TaskId;
  readonly role: AgentRole;
  readonly agentKind: AgentKind;
  readonly conversationId: ConversationId | undefined;
  readonly attemptId: AttemptId | undefined;
  readonly adapterVersion: string | undefined;
  readonly adapterPlatform: string | undefined;
  readonly mode: AgentSessionMode | undefined;
  readonly permissionProfileHash: string | undefined;
  readonly guardDecisionId: string | undefined;
  readonly status: AgentSessionStatus;
  readonly exitReason: AgentSessionExitReason | undefined;
  readonly lastAttemptId: AttemptId | undefined;
  readonly resumable: boolean;
  readonly startedAt: string;
  readonly lastUsedAt: string | undefined;
  readonly endedAt: string | undefined;
}

export interface CreateAgentSessionInput {
  readonly sessionId: string;
  readonly taskId: TaskId;
  readonly role: AgentRole;
  readonly agentKind: AgentKind;
  readonly conversationId?: ConversationId;
  readonly attemptId?: AttemptId;
  readonly adapterVersion?: string;
  readonly adapterPlatform?: string;
  readonly mode?: AgentSessionMode;
  readonly permissionProfileHash?: string;
  readonly guardDecisionId?: string;
  readonly status?: AgentSessionStatus;
  readonly startedAt: string;
}

export interface MarkCompletedPersistedInput {
  readonly sessionId: string;
  readonly attemptId: AttemptId;
  readonly conversationId: ConversationId;
  readonly endedAt: string;
  readonly exitReason?: Extract<AgentSessionExitReason, 'completed'>;
}

export interface MarkUnresumableInput {
  readonly sessionId: string;
  readonly attemptId: AttemptId;
  readonly endedAt: string;
  readonly reason: AgentSessionExitReason;
}

export interface FindResumableSessionInput {
  readonly taskId: TaskId;
  readonly agentKind: AgentKind;
  readonly conversationId: ConversationId;
  readonly adapterVersion: string;
  readonly adapterPlatform: string;
}

interface SessionRow {
  readonly id: string;
  readonly task_id: string;
  readonly role: string;
  readonly agent_kind: string;
  readonly conversation_id: string | null;
  readonly attempt_id: string | null;
  readonly adapter_version: string | null;
  readonly adapter_platform: string | null;
  readonly mode: string | null;
  readonly permission_profile_hash: string | null;
  readonly guard_decision_id: string | null;
  readonly status: string;
  readonly exit_reason: string | null;
  readonly last_attempt_id: string | null;
  readonly resumable: number;
  readonly started_at: string;
  readonly last_used_at: string | null;
  readonly ended_at: string | null;
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
}

function sessionFromRow(row: SessionRow): AgentSessionRecord {
  if (!(AGENT_ROLES as readonly string[]).includes(row.role)) {
    throw new Error(`invalid agent session role: ${row.role}`);
  }
  if (!(AGENT_KINDS as readonly string[]).includes(row.agent_kind)) {
    throw new Error(`invalid agent session agent_kind: ${row.agent_kind}`);
  }
  if (
    row.status !== 'active'
    && row.status !== 'completed_persisted'
    && row.status !== 'unresumable'
  ) {
    throw new Error(`invalid agent session status: ${row.status}`);
  }
  return Object.freeze({
    sessionId: row.id,
    taskId: asTaskId(row.task_id),
    role: row.role as AgentRole,
    agentKind: row.agent_kind as AgentKind,
    conversationId: row.conversation_id === null
      ? undefined
      : asConversationId(row.conversation_id),
    attemptId: row.attempt_id === null ? undefined : asAttemptId(row.attempt_id),
    adapterVersion: row.adapter_version ?? undefined,
    adapterPlatform: row.adapter_platform ?? undefined,
    mode: (row.mode as AgentSessionMode | null) ?? undefined,
    permissionProfileHash: row.permission_profile_hash ?? undefined,
    guardDecisionId: row.guard_decision_id ?? undefined,
    status: row.status as AgentSessionStatus,
    exitReason: (row.exit_reason as AgentSessionExitReason | null) ?? undefined,
    lastAttemptId: row.last_attempt_id === null
      ? undefined
      : asAttemptId(row.last_attempt_id),
    resumable: row.resumable === 1,
    startedAt: row.started_at,
    lastUsedAt: row.last_used_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
  });
}

/**
 * Store-backed agent session evidence for safe resume decisions.
 * Resume is allowed only for completed_persisted + resumable rows with
 * matching task/adapter/conversation/capability context.
 */
export class AgentSessionRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(input: CreateAgentSessionInput): AgentSessionRecord {
    assertNonEmpty(input.sessionId, 'sessionId');
    assertNonEmpty(input.startedAt, 'startedAt');
    if (!(AGENT_ROLES as readonly string[]).includes(input.role)) {
      throw new Error(`invalid agent session role: ${input.role}`);
    }
    if (!(AGENT_KINDS as readonly string[]).includes(input.agentKind)) {
      throw new Error(`invalid agent session agentKind: ${input.agentKind}`);
    }
    const status: AgentSessionStatus = input.status ?? 'active';
    // Active sessions are never resumable until completed+persisted.
    const resumable = status === 'completed_persisted' ? 1 : 0;

    return withTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO agent_sessions (
             id, task_id, role, agent_kind, conversation_id,
             attempt_id, adapter_version, adapter_platform, mode,
             permission_profile_hash, guard_decision_id, status,
             exit_reason, last_attempt_id, resumable,
             started_at, last_used_at, ended_at
           ) VALUES (
             ?, ?, ?, ?, ?,
             ?, ?, ?, ?,
             ?, ?, ?,
             NULL, ?, ?,
             ?, NULL, NULL
           )`,
        )
        .run(
          input.sessionId,
          input.taskId,
          input.role,
          input.agentKind,
          input.conversationId === undefined ? null : String(input.conversationId),
          input.attemptId === undefined ? null : String(input.attemptId),
          input.adapterVersion ?? null,
          input.adapterPlatform ?? null,
          input.mode ?? null,
          input.permissionProfileHash ?? null,
          input.guardDecisionId ?? null,
          status,
          input.attemptId === undefined ? null : String(input.attemptId),
          resumable,
          input.startedAt,
        );
      const row = this.#getById(input.sessionId);
      if (row === undefined) {
        throw new Error('failed to persist agent session');
      }
      return sessionFromRow(row);
    });
  }

  public markCompletedAndPersisted(
    input: MarkCompletedPersistedInput,
  ): AgentSessionRecord {
    assertNonEmpty(input.sessionId, 'sessionId');
    assertNonEmpty(input.endedAt, 'endedAt');
    return withTransaction(this.database, () => {
      const existing = this.#getById(input.sessionId);
      if (existing === undefined) {
        throw new Error(`agent session not found: ${input.sessionId}`);
      }
      if (existing.status === 'unresumable') {
        throw new Error(
          `agent session ${input.sessionId} is unresumable and cannot be completed`,
        );
      }
      this.database
        .prepare(
          `UPDATE agent_sessions SET
             conversation_id = ?,
             last_attempt_id = ?,
             attempt_id = ?,
             status = 'completed_persisted',
             exit_reason = ?,
             resumable = 1,
             last_used_at = ?,
             ended_at = ?
           WHERE id = ?`,
        )
        .run(
          String(input.conversationId),
          String(input.attemptId),
          String(input.attemptId),
          input.exitReason ?? 'completed',
          input.endedAt,
          input.endedAt,
          input.sessionId,
        );
      const row = this.#getById(input.sessionId);
      if (row === undefined) {
        throw new Error('failed to update agent session');
      }
      return sessionFromRow(row);
    });
  }

  public markUnresumable(input: MarkUnresumableInput): AgentSessionRecord {
    assertNonEmpty(input.sessionId, 'sessionId');
    assertNonEmpty(input.endedAt, 'endedAt');
    return withTransaction(this.database, () => {
      const existing = this.#getById(input.sessionId);
      if (existing === undefined) {
        throw new Error(`agent session not found: ${input.sessionId}`);
      }
      this.database
        .prepare(
          `UPDATE agent_sessions SET
             last_attempt_id = ?,
             attempt_id = ?,
             status = 'unresumable',
             exit_reason = ?,
             resumable = 0,
             last_used_at = ?,
             ended_at = ?
           WHERE id = ?`,
        )
        .run(
          String(input.attemptId),
          String(input.attemptId),
          input.reason,
          input.endedAt,
          input.endedAt,
          input.sessionId,
        );
      const row = this.#getById(input.sessionId);
      if (row === undefined) {
        throw new Error('failed to update agent session');
      }
      return sessionFromRow(row);
    });
  }

  public findResumable(
    input: FindResumableSessionInput,
  ): AgentSessionRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT
           id, task_id, role, agent_kind, conversation_id,
           attempt_id, adapter_version, adapter_platform, mode,
           permission_profile_hash, guard_decision_id, status,
           exit_reason, last_attempt_id, resumable,
           started_at, last_used_at, ended_at
         FROM agent_sessions
         WHERE task_id = ?
           AND agent_kind = ?
           AND conversation_id = ?
           AND adapter_version = ?
           AND adapter_platform = ?
           AND status = 'completed_persisted'
           AND resumable = 1
         ORDER BY COALESCE(ended_at, started_at) DESC
         LIMIT 1`,
      )
      .get(
        input.taskId,
        input.agentKind,
        String(input.conversationId),
        input.adapterVersion,
        input.adapterPlatform,
      ) as SessionRow | undefined;
    return row === undefined ? undefined : sessionFromRow(row);
  }

  public getById(sessionId: string): AgentSessionRecord | undefined {
    const row = this.#getById(sessionId);
    return row === undefined ? undefined : sessionFromRow(row);
  }

  #getById(sessionId: string): SessionRow | undefined {
    return this.database
      .prepare(
        `SELECT
           id, task_id, role, agent_kind, conversation_id,
           attempt_id, adapter_version, adapter_platform, mode,
           permission_profile_hash, guard_decision_id, status,
           exit_reason, last_attempt_id, resumable,
           started_at, last_used_at, ended_at
         FROM agent_sessions
         WHERE id = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
  }
}
