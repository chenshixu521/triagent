import type { AgentCapabilities } from '../agents/agent-capabilities.js';
import type { AgentKind, AgentRole, RequirementVersion } from './task.js';
import type {
  AttemptId,
  BaselineId,
  ConversationId,
} from './ids.js';

export interface ConversationSession {
  readonly conversationId: ConversationId;
  readonly adapter: AgentKind;
  readonly capabilities: AgentCapabilities;
  readonly startedAt: string;
  readonly lastUsedAt?: string;
}

interface RunAttemptBase {
  readonly attemptId: AttemptId;
  readonly startedAt: string;
  readonly baselineId: BaselineId;
  readonly requirementVersion: RequirementVersion;
}

export interface PendingRunAttempt extends RunAttemptBase {
  readonly status: 'pending';
}

export interface ActiveRunAttempt extends RunAttemptBase {
  readonly status: 'active';
  readonly role: AgentRole;
  readonly pid: number;
  readonly processStartedAt: string;
  readonly conversationId?: ConversationId;
}

export type RunExitReason =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'timed_out';

export interface CompletedRunAttempt extends RunAttemptBase {
  readonly status: 'completed';
  readonly role: AgentRole;
  readonly pid: number;
  readonly processStartedAt: string;
  readonly conversationId?: ConversationId;
  readonly endedAt: string;
  readonly exitReason: RunExitReason;
}

export type RunAttempt =
  | PendingRunAttempt
  | ActiveRunAttempt
  | CompletedRunAttempt;

export function createPendingRunAttempt(
  attempt: Omit<PendingRunAttempt, 'status'>,
): PendingRunAttempt {
  return Object.freeze({
    status: 'pending',
    attemptId: attempt.attemptId,
    startedAt: attempt.startedAt,
    baselineId: attempt.baselineId,
    requirementVersion: attempt.requirementVersion,
  });
}

export function activateRunAttempt(
  pending: PendingRunAttempt,
  process: Pick<
    ActiveRunAttempt,
    'role' | 'pid' | 'processStartedAt' | 'conversationId'
  >,
): ActiveRunAttempt {
  if (!Number.isInteger(process.pid) || process.pid <= 0) {
    throw new Error('active run attempt pid must be a positive integer');
  }

  return Object.freeze({
    status: 'active',
    attemptId: pending.attemptId,
    startedAt: pending.startedAt,
    baselineId: pending.baselineId,
    requirementVersion: pending.requirementVersion,
    role: process.role,
    pid: process.pid,
    processStartedAt: process.processStartedAt,
    ...(process.conversationId === undefined
      ? {}
      : { conversationId: process.conversationId }),
  });
}

export function completeRunAttempt(
  active: ActiveRunAttempt,
  completion: Pick<CompletedRunAttempt, 'endedAt' | 'exitReason'>,
): CompletedRunAttempt {
  return Object.freeze({
    status: 'completed',
    attemptId: active.attemptId,
    startedAt: active.startedAt,
    baselineId: active.baselineId,
    requirementVersion: active.requirementVersion,
    role: active.role,
    pid: active.pid,
    processStartedAt: active.processStartedAt,
    ...(active.conversationId === undefined
      ? {}
      : { conversationId: active.conversationId }),
    endedAt: completion.endedAt,
    exitReason: completion.exitReason,
  });
}
