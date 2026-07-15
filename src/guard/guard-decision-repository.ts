import type { DatabaseSync } from 'node:sqlite';

import type { TaskId } from '../domain/ids.js';
import { ActionRepository } from '../persistence/action-repository.js';
import type { GuardDecision, GuardDecisionMode, GuardScope } from './project-guard.js';
import type { AgentRole } from '../domain/task.js';
import type { GuardCapabilityEvidence } from './project-guard.js';

const GUARD_DECISION_ACTION_TYPE = 'guard_decision';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseGuardDecision(payload: unknown): GuardDecision | undefined {
  if (!isRecord(payload)) return undefined;
  const id = payload.id;
  const mode = payload.mode;
  const scope = payload.scope;
  const reason = payload.reason;
  const attemptId = payload.attemptId;
  const createdAt = payload.createdAt;
  const expiresAt = payload.expiresAt;
  const capabilityEvidence = payload.capabilityEvidence;
  const role = payload.role;
  const userConfirmationRequired = payload.userConfirmationRequired;
  if (
    typeof id !== 'string'
    || typeof mode !== 'string'
    || !isRecord(scope)
    || typeof reason !== 'string'
    || typeof attemptId !== 'string'
    || typeof createdAt !== 'string'
    || !(expiresAt === null || typeof expiresAt === 'string')
    || !isRecord(capabilityEvidence)
    || typeof role !== 'string'
    || typeof userConfirmationRequired !== 'boolean'
  ) {
    return undefined;
  }
  return {
    id,
    mode: mode as GuardDecisionMode,
    scope: scope as GuardScope,
    reason,
    attemptId,
    createdAt,
    expiresAt,
    capabilityEvidence: capabilityEvidence as unknown as GuardCapabilityEvidence,
    role: role as AgentRole,
    userConfirmationRequired,
  };
}

/**
 * Guard decision plus the task binding recorded at persistence time.
 * Start-gate verification requires taskId === request.taskId.
 */
export interface StoredGuardDecision {
  readonly decision: GuardDecision;
  readonly taskId?: TaskId;
}

/**
 * Persists Task 9 {@link GuardDecision} objects for later fail-closed verification.
 * Backed by pending_actions so decisions are durable and queryable by id.
 * Preserves and exposes the taskId binding used at put().
 */
export class GuardDecisionRepository {
  readonly #actions: ActionRepository;

  public constructor(database: DatabaseSync) {
    this.#actions = new ActionRepository(database);
  }

  public put(
    decision: GuardDecision,
    options: { readonly taskId?: TaskId } = {},
  ): GuardDecision {
    const existing = this.getStored(decision.id);
    if (existing !== undefined) {
      // Idempotent put of the same decision; conflicting payload fails closed.
      if (JSON.stringify(existing.decision) !== JSON.stringify(decision)) {
        throw new Error(
          `guard decision id already stored with different payload: ${decision.id}`,
        );
      }
      if (
        options.taskId !== undefined
        && existing.taskId !== undefined
        && existing.taskId !== options.taskId
      ) {
        throw new Error(
          `guard decision id already bound to a different task: ${decision.id}`,
        );
      }
      return existing.decision;
    }
    this.#actions.recordIntent({
      actionId: decision.id,
      ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
      idempotencyKey: `guard-decision:${decision.id}`,
      type: GUARD_DECISION_ACTION_TYPE,
      payload: decision,
    });
    return decision;
  }

  public get(decisionId: string): GuardDecision | undefined {
    return this.getStored(decisionId)?.decision;
  }

  /**
   * Full stored binding: decision payload + taskId column from pending_actions.
   */
  public getStored(decisionId: string): StoredGuardDecision | undefined {
    const action = this.#actions.get(decisionId);
    if (action === undefined) return undefined;
    if (action.type !== GUARD_DECISION_ACTION_TYPE) return undefined;
    const decision = parseGuardDecision(action.payload);
    if (decision === undefined) return undefined;
    return {
      decision,
      ...(action.taskId === undefined ? {} : { taskId: action.taskId }),
    };
  }
}
