import { randomUUID } from 'node:crypto';

import type { RunAttempt } from '../domain/attempt.js';
import {
  asAttemptId,
  asTaskId,
  type AttemptId,
  type TaskId,
} from '../domain/ids.js';
import { ActionRepository } from '../persistence/action-repository.js';
import { AttemptRepository } from '../persistence/attempt-repository.js';
import type { ReadWriteDatabase } from '../persistence/database.js';
import { parseJsonValue, serializeJsonValue } from '../persistence/json-value.js';
import { TaskRepository } from '../persistence/task-repository.js';
import { withTransaction } from '../persistence/transaction.js';
import type { BaselineTrackerPort } from '../tracking/tracking-port.js';
import type { OrchestratorIdKind } from './task-orchestrator.js';
import {
  type ReconciliationActionEvidence,
  type ReconciliationBaselineEvidence,
  type ReconciliationEvidencePort,
  type ReconciliationLockEvidence,
  type ReconciliationMessageEvidence,
  type ReconciliationProcessEvidence,
  type StartupReconciliationDecision,
  type StartupReconciliationEvidence,
} from './reconciler.js';
import {
  isSafeExecutionState,
  type SafeExecutionState,
  type WorkflowSnapshot,
} from './states.js';
import { transition } from './workflow-engine.js';
import {
  WORKFLOW_EVENT_TYPES,
  type WorkflowEffect,
  type WorkflowEvent,
} from './transitions.js';

export type RecoveryProcessInspector = (
  attempt: RunAttempt,
) => ReconciliationProcessEvidence | Promise<ReconciliationProcessEvidence>;

export interface WorkflowRecoveryJournalOptions {
  readonly database: ReadWriteDatabase;
  readonly tracker: BaselineTrackerPort;
  readonly ownerInstanceId: string;
  readonly observedAt?: () => Date;
  readonly inspectProcess?: RecoveryProcessInspector;
  readonly idFactory?: (kind: OrchestratorIdKind) => string;
}

export type FeedForwardDecision = Extract<
  StartupReconciliationDecision,
  { readonly kind: 'feed_forward' }
>;

export type FeedForwardApplyResult = {
  readonly status: 'applied' | 'already_applied';
  readonly workflowSnapshot: WorkflowSnapshot;
};

interface ActionRow {
  readonly id: string;
  readonly idempotency_key: string;
  readonly action_type: string;
  readonly payload_json: string;
  readonly status: 'intent' | 'completed' | 'failed';
  readonly result_json: string | null;
}

interface BaselineRow {
  readonly status: string;
  readonly manifest_json: string | null;
}

interface MessageRow {
  readonly id: string;
  readonly status: string;
  readonly result_json: string | null;
}

interface PreparedRecoveryEffect {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly actionType: string;
  readonly effect: Exclude<WorkflowEffect, { readonly type: 'PersistTransition' }>;
  readonly reservedAttemptId?: AttemptId;
  readonly reservedBaselineId?: string;
}

const RELEVANT_COMPLETED_ACTIONS = new Set([
  'agent-run',
  'environment-check',
  'format-repair',
  'persist-rework-request',
  'process-cleanup',
  'stage-result',
]);

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const candidate = value?.[field];
  return typeof candidate === 'string' && candidate.trim() !== ''
    ? candidate
    : undefined;
}

function workflowEventFromUnknown(value: unknown): WorkflowEvent {
  const event = objectValue(value);
  if (
    event === undefined
    || typeof event.type !== 'string'
    || !(WORKFLOW_EVENT_TYPES as readonly string[]).includes(event.type)
  ) {
    throw new Error('feed-forward action contains an invalid workflow event');
  }
  return event as unknown as WorkflowEvent;
}

function eventAttemptId(event: WorkflowEvent): AttemptId | undefined {
  return 'attemptId' in event ? event.attemptId : undefined;
}

function effectAttemptId(
  effect: Exclude<WorkflowEffect, { readonly type: 'PersistTransition' }>,
): AttemptId | undefined {
  return 'attemptId' in effect ? effect.attemptId : undefined;
}

function effectActionType(
  effect: Exclude<WorkflowEffect, { readonly type: 'PersistTransition' }>,
): string {
  switch (effect.type) {
    case 'AcquireProjectLock':
      return 'acquire-project-lock';
    case 'RunEnvironmentCheck':
      return 'environment-check';
    case 'CreateAttemptBaseline':
      return 'create-attempt-baseline';
    case 'PrepareImplementationWorkspace':
      return 'prepare-implementation-workspace';
    case 'FinalizeCandidateChangeSet':
      return 'finalize-candidate-change-set';
    case 'PromoteCandidateWorkspace':
      return 'promote-candidate-workspace';
    case 'StartPlanning':
    case 'StartImplementation':
    case 'StartReview':
    case 'StartMasterValidation':
      return 'agent-run';
    case 'PersistReworkRequest':
      return 'persist-rework-request';
    case 'BeginProcessCleanup':
      return 'process-cleanup';
    case 'ReleaseProjectLock':
      return 'release-project-lock';
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

function inferResumeTarget(snapshot: WorkflowSnapshot): SafeExecutionState {
  if (isSafeExecutionState(snapshot.state as SafeExecutionState)) {
    return snapshot.state as SafeExecutionState;
  }
  if (
    snapshot.resumeTargetState !== undefined
    && isSafeExecutionState(snapshot.resumeTargetState)
  ) {
    return snapshot.resumeTargetState;
  }
  if (snapshot.state === 'rework_requested') return 'implementing';
  return 'planning';
}

function messageState(
  row: MessageRow,
  result: Record<string, unknown> | undefined,
): ReconciliationMessageEvidence['state'] {
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
  throw new Error(`user message has an invalid state: ${row.id}`);
}

export class WorkflowRecoveryJournal implements ReconciliationEvidencePort {
  readonly #database: ReadWriteDatabase;
  readonly #tasks: TaskRepository;
  readonly #attempts: AttemptRepository;
  readonly #actions: ActionRepository;
  readonly #tracker: BaselineTrackerPort;
  readonly #ownerInstanceId: string;
  readonly #observedAt: () => Date;
  readonly #inspectProcess?: RecoveryProcessInspector;
  readonly #idFactory: (kind: OrchestratorIdKind) => string;

  public constructor(options: WorkflowRecoveryJournalOptions) {
    if (options.ownerInstanceId.trim() === '') {
      throw new Error('ownerInstanceId must be non-empty');
    }
    this.#database = options.database;
    this.#tasks = new TaskRepository(options.database.connection);
    this.#attempts = new AttemptRepository(options.database.connection);
    this.#actions = new ActionRepository(options.database.connection);
    this.#tracker = options.tracker;
    this.#ownerInstanceId = options.ownerInstanceId;
    this.#observedAt = options.observedAt ?? (() => new Date());
    this.#inspectProcess = options.inspectProcess;
    this.#idFactory = options.idFactory ?? (() => randomUUID());
  }

  public async readStartupEvidence(
    taskId: TaskId,
  ): Promise<StartupReconciliationEvidence> {
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new Error(`task not found during reconcile: ${taskId}`);
    const actions = this.#readActions(taskId);
    const lastAttempt = this.#readLastAttempt(taskId);
    const process = await this.#readProcess(lastAttempt);
    return {
      taskId,
      ownerInstanceId: this.#ownerInstanceId,
      observedAt: this.#observedAt().toISOString(),
      resumeTargetState: inferResumeTarget(task.workflowSnapshot),
      actions,
      ...(lastAttempt === undefined ? {} : { lastAttempt }),
      process,
      lock: this.#readLock(taskId),
      baseline: this.#readBaseline(taskId, lastAttempt),
      messages: this.#readMessages(taskId, lastAttempt),
    };
  }

  public async applyFeedForward(
    decision: FeedForwardDecision,
  ): Promise<FeedForwardApplyResult> {
    const event = workflowEventFromUnknown(decision.workflowEvent);
    return withTransaction(this.#database.connection, () => {
      const current = this.#tasks.get(decision.taskId);
      if (current === undefined) {
        throw new Error(`task not found during feed-forward: ${decision.taskId}`);
      }
      if (this.#consumptionExists(decision.actionId, decision.idempotencyMarker)) {
        return {
          status: 'already_applied' as const,
          workflowSnapshot: current.workflowSnapshot,
        };
      }
      const action = this.#actions.get(decision.actionId);
      if (
        action === undefined
        || action.taskId !== decision.taskId
        || action.type !== 'stage-result'
        || action.status !== 'completed'
      ) {
        throw new Error('feed-forward action is not a completed stage result');
      }
      const result = objectValue(action.result);
      if (result === undefined) {
        throw new Error('feed-forward action result is not a durable object');
      }
      const persistedEvent = result?.workflowEvent;
      if (
        persistedEvent === undefined
        || serializeJsonValue(persistedEvent) !== serializeJsonValue(decision.workflowEvent)
      ) {
        throw new Error('feed-forward decision does not match the durable stage result');
      }
      const reduced = transition(current.workflowSnapshot, event);
      if (reduced.kind !== 'transitioned') {
        throw new Error(`feed-forward reducer rejected ${event.type}: ${reduced.reason}`);
      }
      const snapshot = canonicalSnapshot(reduced);
      const nextVersion = current.workflowVersion + 1;
      const now = this.#observedAt().toISOString();
      const serializedSnapshot = serializeJsonValue(snapshot);
      const prepared = reduced.effects
        .filter(
          (effect): effect is PreparedRecoveryEffect['effect'] =>
            effect.type !== 'PersistTransition',
        )
        .map((effect, index) =>
          this.#prepareEffect(
            decision,
            event,
            effect,
            nextVersion,
            index,
          ));
      const updated = this.#database.connection
        .prepare(
          `UPDATE tasks SET status = ?, workflow_version = ?, workflow_snapshot = ?, updated_at = ?
           WHERE id = ? AND workflow_version = ?`,
        )
        .run(
          snapshot.state,
          nextVersion,
          serializedSnapshot,
          now,
          decision.taskId,
          current.workflowVersion,
        );
      if (updated.changes !== 1) {
        throw new Error('feed-forward task workflow version changed concurrently');
      }
      this.#database.connection
        .prepare(
          `INSERT INTO workflow_transitions(
             task_id, from_state, to_state, event_type, workflow_version, snapshot_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.taskId,
          current.status,
          snapshot.state,
          event.type,
          nextVersion,
          serializedSnapshot,
          now,
        );
      this.#database.connection
        .prepare(
          'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          decision.taskId,
          event.type,
          serializeJsonValue({
            attemptId: eventAttemptId(event) ?? current.workflowSnapshot.activeAttemptId ?? null,
            event,
            workflowVersion: nextVersion,
            recoveredBy: decision.idempotencyMarker,
          }),
          now,
        );
      const related = this.#actionReferences(result);
      const durableAttemptId =
        eventAttemptId(event)
        ?? (() => {
          const persisted = stringField(objectValue(action.payload), 'attemptId');
          if (persisted === undefined) {
            throw new Error('feed-forward action has no durable attempt identity');
          }
          return asAttemptId(persisted);
        })();
      for (const reference of [
        {
          actionId: decision.actionId,
          attemptId: durableAttemptId,
        },
        ...related,
      ]) {
        if (!this.#consumptionExists(reference.actionId)) {
          this.#database.connection
            .prepare(
              'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
            )
            .run(
              decision.taskId,
              'ACTION_RESULT_CONSUMED',
              serializeJsonValue({
                attemptId: reference.attemptId,
                actionId: reference.actionId,
                workflowEvent: event.type,
                consumedByActionId: decision.actionId,
                idempotencyMarker: decision.idempotencyMarker,
              }),
              now,
            );
        }
      }
      this.#database.connection
        .prepare(
          'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          decision.taskId,
          'STARTUP_RECONCILIATION_DECISION',
          serializeJsonValue({
            attemptId: eventAttemptId(event) ?? null,
            decisionMarker: decision.decisionMarker,
            idempotencyMarker: decision.idempotencyMarker,
            kind: decision.kind,
            actionId: decision.actionId,
          }),
          now,
        );
      for (const pending of prepared) {
        this.#database.connection
          .prepare(
            `INSERT INTO pending_actions(
               id, task_id, idempotency_key, action_type, payload_json,
               status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'intent', ?, ?)`,
          )
          .run(
            pending.actionId,
            decision.taskId,
            pending.idempotencyKey,
            pending.actionType,
            serializeJsonValue({
              schemaVersion: 1,
              attemptId:
                pending.reservedAttemptId
                ?? effectAttemptId(pending.effect)
                ?? eventAttemptId(event)
                ?? null,
              baselineId: pending.reservedBaselineId ?? null,
              effect: pending.effect,
              replayPolicy:
                pending.actionType === 'agent-run'
                  ? 'never-auto-replay'
                  : 'reconcile-before-retry',
              recoveredBy: decision.idempotencyMarker,
            }),
            now,
            now,
          );
      }
      return { status: 'applied' as const, workflowSnapshot: snapshot };
    });
  }

  public persistDecision(decision: StartupReconciliationDecision): void {
    const existing = this.#database.connection
      .prepare(
        `SELECT 1 AS present FROM events
         WHERE event_type = 'STARTUP_RECONCILIATION_DECISION'
           AND json_extract(payload_json, '$.decisionMarker') = ?
         LIMIT 1`,
      )
      .get(decision.decisionMarker);
    if (existing !== undefined) return;
    this.#database.connection
      .prepare(
        'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        decision.taskId,
        'STARTUP_RECONCILIATION_DECISION',
        serializeJsonValue({
          attemptId: null,
          decisionMarker: decision.decisionMarker,
          kind: decision.kind,
          reason: decision.reason,
        }),
        this.#observedAt().toISOString(),
      );
  }

  #readActions(taskId: TaskId): readonly ReconciliationActionEvidence[] {
    const consumed = new Set(
      (
        this.#database.connection
          .prepare(
            `SELECT json_extract(payload_json, '$.actionId') AS actionId
             FROM events
             WHERE task_id = ? AND event_type = 'ACTION_RESULT_CONSUMED'`,
          )
          .all(taskId) as unknown as Array<{ readonly actionId: string | null }>
      )
        .map((row) => row.actionId)
        .filter((actionId): actionId is string => typeof actionId === 'string'),
    );
    const rows = this.#database.connection
      .prepare(
        `SELECT id, idempotency_key, action_type, payload_json, status, result_json
         FROM pending_actions WHERE task_id = ? ORDER BY created_at, id`,
      )
      .all(taskId) as unknown as ActionRow[];
    return rows
      .filter(
        (row) => row.status !== 'completed' || RELEVANT_COMPLETED_ACTIONS.has(row.action_type),
      )
      .map((row) => {
        const payload = objectValue(parseJsonValue(row.payload_json, 'action payload'));
        const result = row.result_json === null
          ? undefined
          : parseJsonValue(row.result_json, 'action result');
        const resultObject = objectValue(result);
        const safeToFeedForward =
          row.action_type === 'stage-result'
          && payload?.safeToFeedForward === true
          && resultObject?.workflowEvent !== undefined;
        return {
          actionId: row.id,
          type: row.action_type,
          idempotencyKey: row.idempotency_key,
          replayPolicy:
            safeToFeedForward || payload?.replayPolicy === 'idempotent'
              ? 'idempotent'
              : 'never-auto-replay',
          status: row.status,
          ...(result === undefined ? {} : { result }),
          safeToFeedForward,
          resultConsumed: consumed.has(row.id),
        } satisfies ReconciliationActionEvidence;
      });
  }

  #readLastAttempt(taskId: TaskId): RunAttempt | undefined {
    const row = this.#database.connection
      .prepare(
        `SELECT id FROM run_attempts WHERE task_id = ?
         ORDER BY started_at DESC, rowid DESC LIMIT 1`,
      )
      .get(taskId) as { readonly id: string } | undefined;
    return row === undefined ? undefined : this.#attempts.get(asAttemptId(row.id));
  }

  async #readProcess(
    attempt: RunAttempt | undefined,
  ): Promise<ReconciliationProcessEvidence> {
    if (attempt === undefined || attempt.status === 'completed') {
      return { identity: 'not_applicable', terminalState: 'not_applicable' };
    }
    if (this.#inspectProcess === undefined) {
      return {
        identity: 'unverifiable',
        terminalState: 'unknown',
        diagnostic: 'no process identity inspector is configured during startup recovery',
      };
    }
    return this.#inspectProcess(attempt);
  }

  #readLock(taskId: TaskId): ReconciliationLockEvidence {
    const rows = this.#database.connection
      .prepare(
        `SELECT owner_instance_id AS ownerInstanceId, lease_expires_at AS leaseExpiresAt
         FROM project_locks WHERE task_id = ? AND released_at IS NULL
         ORDER BY acquired_at, id`,
      )
      .all(taskId) as unknown as Array<{
        readonly ownerInstanceId: string | null;
        readonly leaseExpiresAt: string;
      }>;
    if (rows.length === 0) {
      return { status: 'missing', diagnostic: 'no active project lock row exists' };
    }
    if (rows.length !== 1 || rows[0]?.ownerInstanceId === null) {
      return {
        status: 'conflicting',
        diagnostic: 'multiple or legacy ownerless active project locks exist',
      };
    }
    return {
      status: 'present',
      ownerInstanceId: rows[0].ownerInstanceId,
      leaseExpiresAt: rows[0].leaseExpiresAt,
    };
  }

  #readBaseline(
    taskId: TaskId,
    attempt: RunAttempt | undefined,
  ): ReconciliationBaselineEvidence {
    if (attempt === undefined) {
      return { status: 'missing', diagnostic: 'task has no durable run attempt baseline' };
    }
    const row = this.#database.connection
      .prepare(
        `SELECT status, manifest_json FROM file_baselines
         WHERE id = ? AND task_id = ? AND attempt_id = ?`,
      )
      .get(attempt.baselineId, taskId, attempt.attemptId) as BaselineRow | undefined;
    if (row === undefined) {
      return { status: 'missing', diagnostic: 'attempt baseline database row is missing' };
    }
    if (row.status !== 'complete' || row.manifest_json === null) {
      return { status: 'incomplete', diagnostic: `attempt baseline status is ${row.status}` };
    }
    const loaded = this.#tracker.loadBaseline(attempt.baselineId);
    if (loaded.status !== 'loaded') {
      return { status: 'missing', diagnostic: loaded.diagnostic };
    }
    if (
      loaded.manifest.taskId !== taskId ||
      loaded.manifest.kind !== 'attempt' ||
      loaded.manifest.attemptId !== attempt.attemptId
    ) {
      return {
        status: 'incomplete',
        diagnostic: 'attempt baseline manifest identity does not match the run attempt',
      };
    }
    return {
      status: 'complete',
      taskId,
      baselineId: attempt.baselineId,
      attemptId: attempt.attemptId,
    };
  }

  #readMessages(
    taskId: TaskId,
    lastAttempt: RunAttempt | undefined,
  ): readonly ReconciliationMessageEvidence[] {
    const rows = this.#database.connection
      .prepare(
        `SELECT id, status, result_json FROM user_messages
         WHERE task_id = ? ORDER BY created_at, id`,
      )
      .all(taskId) as unknown as MessageRow[];
    return rows.map((row) => {
      const result = row.result_json === null
        ? undefined
        : objectValue(parseJsonValue(row.result_json, 'message result'));
      const persistedAttemptId = stringField(result, 'attemptId');
      if (persistedAttemptId === undefined && lastAttempt === undefined) {
        throw new Error(`user message has no durable attempt identity: ${row.id}`);
      }
      return {
        messageId: row.id,
        attemptId:
          persistedAttemptId === undefined
            ? lastAttempt!.attemptId
            : asAttemptId(persistedAttemptId),
        state: messageState(row, result),
      };
    });
  }

  #prepareEffect(
    decision: FeedForwardDecision,
    event: WorkflowEvent,
    effect: PreparedRecoveryEffect['effect'],
    workflowVersion: number,
    index: number,
  ): PreparedRecoveryEffect {
    const actionId = this.#nextId('action');
    const reworkIdentity = effect.type === 'PersistReworkRequest'
      ? {
          reservedAttemptId: asAttemptId(this.#nextId('attempt')),
          reservedBaselineId: this.#nextId('baseline'),
        }
      : {};
    return {
      actionId,
      actionType: effectActionType(effect),
      idempotencyKey: [
        decision.taskId,
        'recovered',
        String(workflowVersion),
        effect.type,
        effectAttemptId(effect) ?? eventAttemptId(event) ?? String(index),
      ].join(':'),
      effect,
      ...reworkIdentity,
    };
  }

  #actionReferences(
    result: Record<string, unknown>,
  ): readonly { readonly actionId: string; readonly attemptId: AttemptId }[] {
    const derived = objectValue(result.derivedEvidence);
    const references = derived?.actionReferences;
    if (!Array.isArray(references)) return [];
    return references.flatMap((reference) => {
      const value = objectValue(reference);
      const actionId = stringField(value, 'actionId');
      const attemptId = stringField(value, 'attemptId');
      return actionId === undefined || attemptId === undefined
        ? []
        : [{ actionId, attemptId: asAttemptId(attemptId) }];
    });
  }

  #consumptionExists(actionId: string, idempotencyMarker?: string): boolean {
    const row = this.#database.connection
      .prepare(
        `SELECT 1 AS present FROM events
         WHERE event_type = 'ACTION_RESULT_CONSUMED'
           AND (
             json_extract(payload_json, '$.actionId') = ?
             OR (? IS NOT NULL AND json_extract(payload_json, '$.idempotencyMarker') = ?)
           )
         LIMIT 1`,
      )
      .get(actionId, idempotencyMarker ?? null, idempotencyMarker ?? null);
    return row !== undefined;
  }

  #nextId(kind: OrchestratorIdKind): string {
    const value = this.#idFactory(kind).trim();
    if (value === '') throw new Error(`idFactory returned an empty ${kind} ID`);
    return value;
  }
}
