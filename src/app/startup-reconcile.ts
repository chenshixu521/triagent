import type { DatabaseSync } from 'node:sqlite';

import { asAttemptId, asBaselineId, asTaskId, type TaskId } from '../domain/ids.js';
import type { OpenedDatabase } from '../persistence/database.js';
import { parseAndVerifyBaselineManifest } from '../tracking/baseline-manifest.js';
import {
  decideStartupReconciliation,
  type ReconciliationActionEvidence,
  type ReconciliationBaselineEvidence,
  type ReconciliationLockEvidence,
  type ReconciliationMessageEvidence,
  type ReconciliationProcessEvidence,
  type StartupReconciliationDecision,
  type StartupReconciliationEvidence,
} from '../workflow/reconciler.js';
import {
  isTerminalState,
  type SafeExecutionState,
  type WorkflowState,
} from '../workflow/states.js';

export type RecoveryOperatorAction =
  | 'inspect'
  | 'retry'
  | 'continue'
  | 'cancel'
  | 'await_user';

export interface StartupReconcileProcessIdentity {
  readonly pid?: number;
  readonly jobObjectId?: string;
  readonly processStartedAt?: string;
  readonly launchEvidence?: string;
  readonly identity: ReconciliationProcessEvidence['identity'];
  readonly terminalState: ReconciliationProcessEvidence['terminalState'];
}

export interface StartupReconcileBaselineIds {
  readonly taskId: string;
  readonly attemptId?: string;
  readonly baselineId?: string;
}

export type BaselineEvidenceStatus =
  | 'complete'
  | 'missing'
  | 'incomplete'
  | 'invalid'
  | 'mismatched';

export interface StartupReconcileBaselineEvidence {
  readonly status: BaselineEvidenceStatus;
  readonly diagnostic?: string;
  readonly baselineId?: string;
  readonly attemptId?: string;
  readonly taskId?: string;
}

export interface StartupReconcileItem {
  readonly taskId: string;
  readonly status: WorkflowState;
  readonly pendingActions: readonly {
    readonly actionId: string;
    readonly type: string;
    readonly status: 'intent' | 'completed' | 'failed';
    readonly idempotencyKey: string;
    readonly replayPolicy: 'idempotent' | 'never-auto-replay';
  }[];
  readonly processIdentity: StartupReconcileProcessIdentity;
  readonly projectLock: ReconciliationLockEvidence;
  readonly baselineIds: StartupReconcileBaselineIds;
  readonly baselineEvidence: StartupReconcileBaselineEvidence;
  readonly queuedMessages: readonly ReconciliationMessageEvidence[];
  readonly requirementVersion?: number;
  readonly reviewVersions?: readonly number[];
  readonly watcherHealth: 'unknown' | 'healthy' | 'unhealthy' | 'not_started';
  readonly allowedNextActions: readonly RecoveryOperatorAction[];
  /** True only for safe idempotent completed intents with durable evidence. */
  readonly autoResume: boolean;
  readonly decision: StartupReconciliationDecision;
  readonly evidenceLines: readonly string[];
}

export interface StartupReconcileReport {
  readonly observedAt: string;
  readonly ownerInstanceId: string;
  readonly items: readonly StartupReconcileItem[];
  readonly incompleteTaskCount: number;
}

export interface RunStartupReconcileOptions {
  readonly database: OpenedDatabase;
  readonly ownerInstanceId: string;
  readonly observedAt?: () => Date;
  /**
   * Optional process inspector. When omitted, active attempts are treated as
   * unverifiable (fail closed → recovery / awaiting_user).
   */
  readonly inspectProcess?: (
    pid: number,
    processStartedAt: string,
  ) => Promise<ReconciliationProcessEvidence> | ReconciliationProcessEvidence;
}

interface TaskRow {
  readonly id: string;
  readonly status: string;
  readonly workflow_snapshot: string;
  readonly workflow_version: number;
}

interface ActionRow {
  readonly id: string;
  readonly action_type: string;
  readonly idempotency_key: string;
  readonly status: string;
  readonly payload_json: string;
  readonly result_json: string | null;
}

interface AttemptRow {
  readonly id: string;
  readonly status: string;
  readonly role: string | null;
  readonly pid: number | null;
  readonly process_started_at: string | null;
  readonly started_at: string;
  readonly baseline_id: string;
  readonly requirement_version: number;
}

interface LockRow {
  readonly owner_instance_id: string;
  readonly lease_expires_at: string;
  readonly task_id: string | null;
}

function parseSnapshot(raw: string): {
  readonly requirementVersion?: number;
  readonly resumeTargetState?: SafeExecutionState;
  readonly activeAttemptId?: string;
  readonly activeAttemptBaselineId?: string;
} {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      requirementVersion:
        typeof parsed.requirementVersion === 'number'
          ? parsed.requirementVersion
          : undefined,
      resumeTargetState:
        typeof parsed.resumeTargetState === 'string'
          ? (parsed.resumeTargetState as SafeExecutionState)
          : typeof parsed.inspectionResumeTargetState === 'string'
            ? (parsed.inspectionResumeTargetState as SafeExecutionState)
            : typeof parsed.awaitingResumeTargetState === 'string'
              ? (parsed.awaitingResumeTargetState as SafeExecutionState)
              : undefined,
      activeAttemptId:
        typeof parsed.activeAttemptId === 'string'
          ? parsed.activeAttemptId
          : undefined,
      activeAttemptBaselineId:
        typeof parsed.activeAttemptBaselineId === 'string'
          ? parsed.activeAttemptBaselineId
          : undefined,
    };
  } catch {
    return {};
  }
}

function objectPayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

function replayPolicyFor(
  actionType: string,
  payload: Record<string, unknown>,
): 'idempotent' | 'never-auto-replay' {
  if (payload.replayPolicy === 'idempotent') return 'idempotent';
  if (payload.replayPolicy === 'never-auto-replay') return 'never-auto-replay';
  if (
    actionType === 'process-cleanup'
    || actionType === 'agent-run'
    || actionType === 'budget-stop'
  ) {
    return 'never-auto-replay';
  }
  if (actionType === 'stage-result' || actionType === 'format-repair') {
    return 'idempotent';
  }
  return 'never-auto-replay';
}

function listIncompleteTasks(connection: DatabaseSync): readonly TaskRow[] {
  return connection
    .prepare(
      `SELECT id, status, workflow_snapshot, workflow_version
       FROM tasks
       ORDER BY updated_at DESC, id ASC`,
    )
    .all() as unknown as TaskRow[];
}

function readActions(
  connection: DatabaseSync,
  taskId: string,
): readonly ReconciliationActionEvidence[] {
  const rows = connection
    .prepare(
      `SELECT id, action_type, idempotency_key, status, payload_json, result_json
       FROM pending_actions
       WHERE task_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(taskId) as unknown as ActionRow[];

  return rows.map((row) => {
    const payload = objectPayload(row.payload_json);
    const result =
      row.result_json === null ? undefined : objectPayload(row.result_json);
    const resultConsumed = Boolean(
      connection
        .prepare(
          `SELECT 1 AS ok FROM events
           WHERE task_id = ? AND event_type = 'ACTION_RESULT_CONSUMED'
             AND instr(payload_json, ?) > 0
           LIMIT 1`,
        )
        .get(taskId, row.id),
    );
    const status = row.status as 'intent' | 'completed' | 'failed';
    const replayPolicy = replayPolicyFor(row.action_type, payload);
    const safeToFeedForward =
      status === 'completed'
      && row.action_type === 'stage-result'
      && result !== undefined
      && result.workflowEvent !== undefined;
    return {
      actionId: row.id,
      type: row.action_type,
      idempotencyKey: row.idempotency_key,
      replayPolicy,
      status,
      ...(result === undefined ? {} : { result }),
      safeToFeedForward,
      resultConsumed,
    };
  });
}

function readLastAttempt(
  connection: DatabaseSync,
  taskId: string,
): AttemptRow | undefined {
  return connection
    .prepare(
      `SELECT id, status, role, pid, process_started_at, started_at,
              baseline_id, requirement_version
       FROM run_attempts
       WHERE task_id = ?
       ORDER BY started_at DESC, id DESC
       LIMIT 1`,
    )
    .get(taskId) as unknown as AttemptRow | undefined;
}

function readLock(
  connection: DatabaseSync,
  taskId: string,
): ReconciliationLockEvidence {
  // Prefer lease-aware schema when present; fall back to missing.
  try {
    const row = connection
      .prepare(
        `SELECT owner_instance_id, lease_expires_at, task_id
         FROM project_locks
         WHERE task_id = ? AND (released_at IS NULL OR released_at = '')
         ORDER BY acquired_at DESC
         LIMIT 1`,
      )
      .get(taskId) as unknown as LockRow | undefined;
    if (row === undefined) {
      return { status: 'missing', diagnostic: 'no active project lock row' };
    }
    return {
      status: 'present',
      ownerInstanceId: row.owner_instance_id,
      leaseExpiresAt: row.lease_expires_at,
    };
  } catch {
    return {
      status: 'missing',
      diagnostic: 'project lock table unavailable or schema mismatch',
    };
  }
}

function readMessages(
  connection: DatabaseSync,
  taskId: string,
  attemptId: string | undefined,
): readonly ReconciliationMessageEvidence[] {
  if (attemptId === undefined) return [];
  try {
    const rows = connection
      .prepare(
        `SELECT id, status AS state
         FROM user_messages
         WHERE task_id = ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(taskId) as unknown as { readonly id: string; readonly state: string }[];
    return rows.map((row) => ({
      messageId: row.id,
      attemptId: asAttemptId(attemptId),
      state: (row.state === 'queued'
        || row.state === 'delivered'
        || row.state === 'failed'
        ? row.state
        : 'queued') as ReconciliationMessageEvidence['state'],
    }));
  } catch {
    return [];
  }
}

function extractJobObjectId(
  actions: readonly ReconciliationActionEvidence[],
  attempt: AttemptRow | undefined,
): string | undefined {
  for (const action of actions) {
    const result = action.result as Record<string, unknown> | undefined;
    if (result !== undefined && typeof result.jobObjectId === 'string') {
      return result.jobObjectId;
    }
  }
  // Payload may carry job identity for cleanup intents.
  void attempt;
  return undefined;
}

function extractJobFromPayload(
  connection: DatabaseSync,
  taskId: string,
): string | undefined {
  try {
    const row = connection
      .prepare(
        `SELECT payload_json FROM pending_actions
         WHERE task_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 5`,
      )
      .all(taskId) as unknown as { readonly payload_json: string }[];
    for (const entry of row) {
      const payload = objectPayload(entry.payload_json);
      if (typeof payload.jobObjectId === 'string') {
        return payload.jobObjectId;
      }
      if (typeof payload.job_object_id === 'string') {
        return payload.job_object_id;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

interface BaselineRow {
  readonly id: string;
  readonly task_id: string;
  readonly attempt_id: string;
  readonly status: string;
  readonly manifest_json: string | null;
  readonly completed_at: string | null;
}

/**
 * Query file_baselines for the referenced baseline ID and validate durable
 * ownership/completeness. Never labels a baseline complete merely because the
 * ID appears in the workflow snapshot or run_attempts row.
 */
function readBaselineEvidence(
  connection: DatabaseSync,
  taskId: string,
  attempt: AttemptRow | undefined,
): {
  readonly reconciliation: ReconciliationBaselineEvidence;
  readonly evidence: StartupReconcileBaselineEvidence;
} {
  if (attempt === undefined) {
    return {
      reconciliation: {
        status: 'missing',
        diagnostic: 'no run attempt baseline',
      },
      evidence: {
        status: 'missing',
        diagnostic: 'no run attempt baseline',
      },
    };
  }

  const baselineId = attempt.baseline_id;
  const attemptId = attempt.id;
  const row = connection
    .prepare(
      `SELECT id, task_id, attempt_id, status, manifest_json, completed_at
       FROM file_baselines
       WHERE id = ?`,
    )
    .get(baselineId) as unknown as BaselineRow | undefined;

  if (row === undefined) {
    return {
      reconciliation: {
        status: 'missing',
        diagnostic: `file_baselines row missing for baseline ${baselineId}`,
      },
      evidence: {
        status: 'missing',
        diagnostic: `file_baselines row missing for baseline ${baselineId}`,
        baselineId,
        attemptId,
        taskId,
      },
    };
  }

  if (row.task_id !== taskId) {
    return {
      reconciliation: {
        status: 'incomplete',
        diagnostic:
          `baseline ${baselineId} belongs to task ${row.task_id}, not ${taskId}`,
      },
      evidence: {
        status: 'mismatched',
        diagnostic:
          `baseline ${baselineId} belongs to task ${row.task_id}, not ${taskId}`,
        baselineId,
        attemptId,
        taskId: row.task_id,
      },
    };
  }

  if (row.attempt_id !== attemptId) {
    return {
      reconciliation: {
        status: 'incomplete',
        diagnostic:
          `baseline ${baselineId} belongs to attempt ${row.attempt_id}, not ${attemptId}`,
      },
      evidence: {
        status: 'mismatched',
        diagnostic:
          `baseline ${baselineId} belongs to attempt ${row.attempt_id}, not ${attemptId}`,
        baselineId,
        attemptId: row.attempt_id,
        taskId,
      },
    };
  }

  if (row.status === 'pending' || row.status === 'failed') {
    return {
      reconciliation: {
        status: 'incomplete',
        diagnostic: `baseline status is ${row.status}`,
      },
      evidence: {
        status: 'incomplete',
        diagnostic: `baseline status is ${row.status}`,
        baselineId,
        attemptId,
        taskId,
      },
    };
  }

  if (row.status !== 'complete') {
    return {
      reconciliation: {
        status: 'incomplete',
        diagnostic: `baseline status is ${row.status}`,
      },
      evidence: {
        status: 'invalid',
        diagnostic: `baseline status is ${row.status}`,
        baselineId,
        attemptId,
        taskId,
      },
    };
  }

  // Strict: complete rows require a valid completed_at timestamp.
  if (row.completed_at === null || row.completed_at.trim() === '') {
    return {
      reconciliation: {
        status: 'incomplete',
        diagnostic: 'baseline status is complete but completed_at is missing',
      },
      evidence: {
        status: 'incomplete',
        diagnostic: 'baseline status is complete but completed_at is missing',
        baselineId,
        attemptId,
        taskId,
      },
    };
  }
  const completedAt = new Date(row.completed_at);
  if (Number.isNaN(completedAt.valueOf())) {
    return {
      reconciliation: {
        status: 'incomplete',
        diagnostic: 'baseline completed_at is not a valid timestamp',
      },
      evidence: {
        status: 'invalid',
        diagnostic: 'baseline completed_at is not a valid timestamp',
        baselineId,
        attemptId,
        taskId,
      },
    };
  }

  if (row.manifest_json === null || row.manifest_json.trim() === '') {
    return {
      reconciliation: {
        status: 'incomplete',
        diagnostic: 'baseline complete but manifest_json is missing',
      },
      evidence: {
        status: 'incomplete',
        diagnostic: 'baseline complete but manifest_json is missing',
        baselineId,
        attemptId,
        taskId,
      },
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(row.manifest_json) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      reconciliation: {
        status: 'incomplete',
        diagnostic: `baseline manifest JSON parse failed: ${message}`,
      },
      evidence: {
        status: 'invalid',
        diagnostic: `baseline manifest JSON parse failed: ${message}`,
        baselineId,
        attemptId,
        taskId,
      },
    };
  }

  if (
    parsedJson === null
    || typeof parsedJson !== 'object'
    || Array.isArray(parsedJson)
    || Object.keys(parsedJson as object).length === 0
  ) {
    return {
      reconciliation: {
        status: 'incomplete',
        diagnostic: 'baseline manifest is empty or not an object',
      },
      evidence: {
        status: 'invalid',
        diagnostic: 'baseline manifest is empty or not an object',
        baselineId,
        attemptId,
        taskId,
      },
    };
  }

  // Canonical tracking-service validation + checksum recomputation.
  try {
    parseAndVerifyBaselineManifest(parsedJson, {
      baselineId,
      taskId,
      attemptId,
      kind: 'attempt',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLocaleLowerCase('en-US');
    const status: BaselineEvidenceStatus =
      lower.includes('checksum')
        ? 'invalid'
        : lower.includes('does not match') || lower.includes('identity')
          ? 'mismatched'
          : lower.includes('incomplete') || lower.includes('missing')
            ? 'incomplete'
            : 'invalid';
    return {
      reconciliation: {
        status: 'incomplete',
        diagnostic: `baseline manifest invalid: ${message}`,
      },
      evidence: {
        status,
        diagnostic: `baseline manifest invalid: ${message}`,
        baselineId,
        attemptId,
        taskId,
      },
    };
  }

  return {
    reconciliation: {
      status: 'complete',
      taskId: asTaskId(taskId),
      baselineId: asBaselineId(baselineId),
      attemptId: asAttemptId(attemptId),
    },
    evidence: {
      status: 'complete',
      baselineId,
      attemptId,
      taskId,
    },
  };
}

function buildEvidenceLines(item: {
  readonly taskId: string;
  readonly status: string;
  readonly pendingActions: StartupReconcileItem['pendingActions'];
  readonly processIdentity: StartupReconcileProcessIdentity;
  readonly projectLock: ReconciliationLockEvidence;
  readonly baselineIds: StartupReconcileBaselineIds;
  readonly baselineEvidence: StartupReconcileBaselineEvidence;
  readonly allowedNextActions: readonly RecoveryOperatorAction[];
  readonly decision: StartupReconciliationDecision;
}): readonly string[] {
  const lines: string[] = [
    `Task ${item.taskId} status=${item.status}`,
    `Decision: ${item.decision.kind} — ${item.decision.reason}`,
  ];
  if (item.processIdentity.pid !== undefined) {
    lines.push(
      `Process identity: pid=${item.processIdentity.pid}`
        + (item.processIdentity.jobObjectId !== undefined
          ? ` job=${item.processIdentity.jobObjectId}`
          : '')
        + (item.processIdentity.processStartedAt !== undefined
          ? ` started=${item.processIdentity.processStartedAt}`
          : ''),
    );
  } else {
    lines.push('Process identity: none / unverifiable');
  }
  lines.push(
    `Project lock: ${item.projectLock.status}`,
    `Baseline: attempt=${item.baselineIds.attemptId ?? 'n/a'} baseline=${item.baselineIds.baselineId ?? 'n/a'} evidence=${item.baselineEvidence.status}`
      + (item.baselineEvidence.diagnostic !== undefined
        ? ` (${item.baselineEvidence.diagnostic})`
        : ''),
  );
  for (const action of item.pendingActions.slice(0, 8)) {
    lines.push(
      `Pending action ${action.type} id=${action.actionId} status=${action.status} policy=${action.replayPolicy}`,
    );
  }
  lines.push(`Allowed next actions: ${item.allowedNextActions.join(', ')}`);
  return lines;
}

function allowedActionsFor(
  decision: StartupReconciliationDecision,
  baselineOk: boolean,
): readonly RecoveryOperatorAction[] {
  if (decision.kind === 'blocked') {
    return decision.operatorActions;
  }
  if (!baselineOk) {
    return ['inspect', 'cancel'];
  }
  if (decision.kind === 'feed_forward' || decision.kind === 'retry_idempotent') {
    return ['continue', 'inspect', 'cancel'];
  }
  return ['inspect', 'continue', 'cancel'];
}

/**
 * Startup reconcile: list each incomplete task with evidence and a typed
 * decision. Never auto-resumes unknown or non-idempotent work. Safe
 * idempotent completed intents may mark autoResume only with durable evidence
 * (feed_forward / retry_idempotent decisions). Uncertain state → recovery.
 */
export async function runStartupReconcile(
  options: RunStartupReconcileOptions,
): Promise<StartupReconcileReport> {
  const observedAt = (options.observedAt ?? (() => new Date()))().toISOString();
  if (options.database.mode !== 'read-write') {
    return {
      observedAt,
      ownerInstanceId: options.ownerInstanceId,
      items: [],
      incompleteTaskCount: 0,
    };
  }

  const connection = options.database.connection;
  const tasks = listIncompleteTasks(connection);
  const items: StartupReconcileItem[] = [];

  for (const task of tasks) {
    if (isTerminalState(task.status as WorkflowState) || task.status === 'draft') {
      continue;
    }

    const taskId = asTaskId(task.id);
    const snapshot = parseSnapshot(task.workflow_snapshot);
    const actions = readActions(connection, task.id);
    const lastAttempt = readLastAttempt(connection, task.id);
    const lock = readLock(connection, task.id);
    const messages = readMessages(connection, task.id, lastAttempt?.id);

    let processEvidence: ReconciliationProcessEvidence;
    if (lastAttempt === undefined || lastAttempt.status === 'completed') {
      processEvidence = {
        identity: 'not_applicable',
        terminalState: 'not_applicable',
      };
    } else if (
      lastAttempt.status === 'active'
      && lastAttempt.pid !== null
      && lastAttempt.process_started_at !== null
      && options.inspectProcess !== undefined
    ) {
      processEvidence = await options.inspectProcess(
        lastAttempt.pid,
        lastAttempt.process_started_at,
      );
    } else if (lastAttempt.status === 'pending') {
      processEvidence = {
        identity: 'not_applicable',
        terminalState: 'not_applicable',
      };
    } else {
      processEvidence = {
        identity: 'unverifiable',
        terminalState: 'unknown',
        diagnostic: 'no process inspector available at startup',
      };
    }

    const baselineRead = readBaselineEvidence(connection, task.id, lastAttempt);
    const baseline = baselineRead.reconciliation;
    const baselineEvidence = baselineRead.evidence;

    const evidence: StartupReconciliationEvidence = {
      taskId,
      ownerInstanceId: options.ownerInstanceId,
      observedAt,
      resumeTargetState:
        snapshot.resumeTargetState
        ?? 'implementing',
      actions,
      ...(lastAttempt === undefined || lastAttempt.status === 'pending'
        ? lastAttempt === undefined
          ? {}
          : {
              lastAttempt: {
                status: 'pending' as const,
                attemptId: asAttemptId(lastAttempt.id),
                startedAt: lastAttempt.started_at,
                baselineId: asBaselineId(lastAttempt.baseline_id),
                requirementVersion: lastAttempt.requirement_version,
              },
            }
        : lastAttempt.status === 'active' && lastAttempt.pid !== null && lastAttempt.process_started_at !== null && lastAttempt.role !== null
          ? {
              lastAttempt: {
                status: 'active' as const,
                attemptId: asAttemptId(lastAttempt.id),
                startedAt: lastAttempt.started_at,
                baselineId: asBaselineId(lastAttempt.baseline_id),
                requirementVersion: lastAttempt.requirement_version,
                role: lastAttempt.role as 'master' | 'implementer' | 'reviewer',
                pid: lastAttempt.pid,
                processStartedAt: lastAttempt.process_started_at,
              },
            }
          : {}),
      process: processEvidence,
      lock,
      baseline,
      messages,
    };

    const decision = decideStartupReconciliation(evidence);
    if (
      lastAttempt === undefined
      && task.status === 'awaiting_user'
      && lock.status === 'missing'
      && baseline.status === 'missing'
      && decision.kind === 'noop'
    ) {
      continue;
    }
    const jobObjectId =
      extractJobObjectId(actions, lastAttempt)
      ?? extractJobFromPayload(connection, task.id);

    let resolvedJob = jobObjectId;
    if (resolvedJob === undefined) {
      try {
        const event = connection
          .prepare(
            `SELECT payload_json FROM events
             WHERE task_id = ? AND event_type = 'PROCESS_LAUNCH'
             ORDER BY id DESC LIMIT 1`,
          )
          .get(task.id) as unknown as { readonly payload_json: string } | undefined;
        if (event !== undefined) {
          const payload = objectPayload(event.payload_json);
          if (typeof payload.jobObjectId === 'string') {
            resolvedJob = payload.jobObjectId;
          }
        }
      } catch {
        // ignore
      }
    }

    const processIdentity: StartupReconcileProcessIdentity = {
      identity: processEvidence.identity,
      terminalState: processEvidence.terminalState,
      ...(lastAttempt?.pid !== null && lastAttempt?.pid !== undefined
        ? { pid: lastAttempt.pid }
        : processEvidence.identity === 'matched' && 'pid' in processEvidence
          ? { pid: processEvidence.pid }
          : {}),
      ...(resolvedJob !== undefined ? { jobObjectId: resolvedJob } : {}),
      ...(lastAttempt?.process_started_at !== null
        && lastAttempt?.process_started_at !== undefined
        ? { processStartedAt: lastAttempt.process_started_at }
        : {}),
      ...(processEvidence.identity === 'matched' || processEvidence.identity === 'mismatched'
        || processEvidence.identity === 'unverifiable'
        ? {
            launchEvidence:
              'diagnostic' in processEvidence
                ? processEvidence.diagnostic
                : 'persisted attempt identity',
          }
        : {}),
    };

    const pendingActions = actions.map((action) => ({
      actionId: action.actionId,
      type: action.type,
      status: action.status,
      idempotencyKey: action.idempotencyKey,
      replayPolicy: action.replayPolicy,
    }));

    const baselineOk = baselineEvidence.status === 'complete';
    const allowedNextActions = allowedActionsFor(decision, baselineOk);
    const autoResume =
      baselineOk
      && (decision.kind === 'feed_forward' || decision.kind === 'retry_idempotent');

    const baselineIds: StartupReconcileBaselineIds = {
      taskId: task.id,
      ...(lastAttempt !== undefined
        ? { attemptId: lastAttempt.id, baselineId: lastAttempt.baseline_id }
        : snapshot.activeAttemptId !== undefined
          ? {
              attemptId: snapshot.activeAttemptId,
              ...(snapshot.activeAttemptBaselineId !== undefined
                ? { baselineId: snapshot.activeAttemptBaselineId }
                : {}),
            }
          : {}),
    };

    const itemBase = {
      taskId: task.id,
      status: task.status as WorkflowState,
      pendingActions,
      processIdentity,
      projectLock: lock,
      baselineIds,
      baselineEvidence,
      queuedMessages: messages,
      ...(snapshot.requirementVersion !== undefined
        ? { requirementVersion: snapshot.requirementVersion }
        : lastAttempt !== undefined
          ? { requirementVersion: lastAttempt.requirement_version }
          : {}),
      reviewVersions: [] as const,
      watcherHealth: 'not_started' as const,
      allowedNextActions,
      autoResume,
      decision,
    };

    items.push({
      ...itemBase,
      evidenceLines: buildEvidenceLines(itemBase),
    });
  }

  // Best-effort workspace retention: promoted / expired abandoned|rejected only.
  // recovery_required and uncertain promoting rows are never auto-deleted.
  try {
    const table = connection.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name = 'implementation_workspaces'`,
    ).get() as { readonly name?: string } | undefined;
    if (table?.name === 'implementation_workspaces') {
      const { ImplementationWorkspaceRepository } = await import(
        '../workspace/implementation-workspace-repository.js'
      );
      const { housekeepImplementationWorkspaces } = await import(
        '../workspace/implementation-workspace-service.js'
      );
      housekeepImplementationWorkspaces(
        new ImplementationWorkspaceRepository(connection),
        observedAt,
      );
    }
  } catch {
    // Housekeeping is best-effort; reconcile report remains authoritative.
  }

  return {
    observedAt,
    ownerInstanceId: options.ownerInstanceId,
    items,
    incompleteTaskCount: items.length,
  };
}

export function listTaskIdsNeedingRecovery(
  report: StartupReconcileReport,
): readonly TaskId[] {
  return report.items
    .filter((item) => !item.autoResume)
    .map((item) => asTaskId(item.taskId));
}
