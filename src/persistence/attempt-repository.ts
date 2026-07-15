import type { DatabaseSync } from 'node:sqlite';

import {
  asAttemptId,
  asBaselineId,
  asConversationId,
  type AttemptId,
  type TaskId,
} from '../domain/ids.js';
import type {
  ActiveRunAttempt,
  CompletedRunAttempt,
  PendingRunAttempt,
  RunAttempt,
  RunExitReason,
} from '../domain/attempt.js';
import { AGENT_ROLES, type AgentRole } from '../domain/task.js';
import { withTransaction } from './transaction.js';

interface AttemptRow {
  readonly id: string;
  readonly status: string;
  readonly role: string | null;
  readonly pid: number | null;
  readonly process_started_at: string | null;
  readonly started_at: string;
  readonly ended_at: string | null;
  readonly exit_reason: string | null;
  readonly baseline_id: string;
  readonly requirement_version: number;
  readonly conversation_id: string | null;
}

const EXIT_REASONS: readonly RunExitReason[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'timed_out',
];

function assertNonEmpty(value: string, field: string): void {
  if (value.trim() === '') {
    throw new Error(`${field} must be non-empty`);
  }
}

function attemptFromRow(row: AttemptRow): RunAttempt {
  const base = {
    attemptId: asAttemptId(row.id),
    startedAt: row.started_at,
    baselineId: asBaselineId(row.baseline_id),
    requirementVersion: row.requirement_version,
  };
  if (
    !Number.isSafeInteger(row.requirement_version) ||
    row.requirement_version <= 0 ||
    row.started_at.trim() === ''
  ) {
    throw new Error('invalid run attempt base fields');
  }
  if (row.status === 'pending') {
    if (row.conversation_id !== null) {
      throw new Error(
        'invalid pending run attempt conversation identity: conversation_id must be null',
      );
    }
    if (
      row.role !== null ||
      row.pid !== null ||
      row.process_started_at !== null ||
      row.ended_at !== null ||
      row.exit_reason !== null
    ) {
      throw new Error('invalid pending run attempt fields');
    }
    return { status: 'pending', ...base };
  }
  if (
    row.status !== 'active' &&
    row.status !== 'completed'
  ) {
    throw new Error(`invalid run attempt status: ${row.status}`);
  }
  if (
    row.role === null ||
    !(AGENT_ROLES as readonly string[]).includes(row.role) ||
    row.pid === null ||
    !Number.isSafeInteger(row.pid) ||
    row.pid <= 0 ||
    row.process_started_at === null ||
    row.process_started_at.trim() === ''
  ) {
    throw new Error(`invalid ${row.status} run attempt fields`);
  }
  const activeFields = {
    ...base,
    role: row.role as AgentRole,
    pid: row.pid,
    processStartedAt: row.process_started_at,
    ...(row.conversation_id === null
      ? {}
      : { conversationId: asConversationId(row.conversation_id) }),
  };
  if (row.status === 'active') {
    if (row.ended_at !== null || row.exit_reason !== null) {
      throw new Error('invalid active run attempt completion fields');
    }
    return { status: 'active', ...activeFields };
  }
  if (
    row.ended_at === null ||
    row.ended_at.trim() === '' ||
    row.exit_reason === null ||
    !(EXIT_REASONS as readonly string[]).includes(row.exit_reason)
  ) {
    throw new Error('invalid completed run attempt fields');
  }
  return {
    status: 'completed',
    ...activeFields,
    endedAt: row.ended_at,
    exitReason: row.exit_reason as RunExitReason,
  };
}

const SELECT_ATTEMPT = `SELECT id, status, role, pid, process_started_at, started_at,
  ended_at, exit_reason, baseline_id, requirement_version, conversation_id
  FROM run_attempts`;

export class AttemptRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(taskId: TaskId, attempt: PendingRunAttempt): void {
    if (attempt.status !== 'pending') {
      throw new Error('new run attempt must have pending status');
    }
    assertNonEmpty(attempt.startedAt, 'startedAt');
    if (!Number.isSafeInteger(attempt.requirementVersion) || attempt.requirementVersion <= 0) {
      throw new Error('requirement version must be a positive integer');
    }
    withTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO run_attempts(
            id, task_id, status, started_at, baseline_id, requirement_version
          ) VALUES (?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          attempt.attemptId,
          taskId,
          attempt.startedAt,
          attempt.baselineId,
          attempt.requirementVersion,
        );
    });
  }

  public markActive(
    attemptId: AttemptId,
    process: Pick<
      ActiveRunAttempt,
      'role' | 'pid' | 'processStartedAt' | 'conversationId'
    >,
  ): void {
    if (!(AGENT_ROLES as readonly string[]).includes(process.role)) {
      throw new Error('invalid run attempt role');
    }
    if (!Number.isSafeInteger(process.pid) || process.pid <= 0) {
      throw new Error('run attempt pid must be a positive integer');
    }
    assertNonEmpty(process.processStartedAt, 'processStartedAt');
    withTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE run_attempts
           SET status = 'active', role = ?, pid = ?, process_started_at = ?, conversation_id = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(
          process.role,
          process.pid,
          process.processStartedAt,
          process.conversationId ?? null,
          attemptId,
        );
      if (result.changes !== 1) {
        throw new Error(`pending run attempt not found: ${attemptId}`);
      }
    });
  }

  public markCompleted(
    attemptId: AttemptId,
    completion: Pick<CompletedRunAttempt, 'endedAt' | 'exitReason'>,
  ): void {
    assertNonEmpty(completion.endedAt, 'endedAt');
    if (!(EXIT_REASONS as readonly string[]).includes(completion.exitReason)) {
      throw new Error('invalid run attempt exit reason');
    }
    withTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE run_attempts
           SET status = 'completed', ended_at = ?, exit_reason = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(completion.endedAt, completion.exitReason, attemptId);
      if (result.changes !== 1) {
        throw new Error(`active run attempt not found: ${attemptId}`);
      }
    });
  }

  public get(attemptId: AttemptId): RunAttempt | undefined {
    const row = this.database
      .prepare(`${SELECT_ATTEMPT} WHERE id = ?`)
      .get(attemptId) as unknown as AttemptRow | undefined;
    return row === undefined ? undefined : attemptFromRow(row);
  }

  public listIncomplete(taskId?: TaskId): readonly RunAttempt[] {
    const statement = taskId === undefined
      ? this.database.prepare(`${SELECT_ATTEMPT} WHERE status != 'completed' ORDER BY started_at, id`)
      : this.database.prepare(
          `${SELECT_ATTEMPT} WHERE task_id = ? AND status != 'completed' ORDER BY started_at, id`,
        );
    const rows = (taskId === undefined ? statement.all() : statement.all(taskId)) as unknown as AttemptRow[];
    return rows.map(attemptFromRow);
  }
}
