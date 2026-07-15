import type { AttemptId, BaselineId, TaskId } from '../domain/ids.js';
import type { AgentRole, RequirementVersion } from '../domain/task.js';

export const WORKFLOW_STATES = [
  'draft',
  'checking_environment',
  'planning',
  'awaiting_plan_approval',
  'implementing',
  'reviewing',
  'master_validation',
  'rework_requested',
  'paused_after_run',
  'interrupting',
  'interrupted_needs_inspection',
  'cleanup_failed',
  'awaiting_user',
  'completed',
  'cancelled',
  'failed',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const TERMINAL_STATES = ['completed', 'cancelled', 'failed'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

// One initial implementation may be followed by at most three rework attempts.
export const MAX_REWORKS = 3 as const;

export type StopIntent = 'interrupt' | 'cancel';

export type SafeExecutionState =
  | 'planning'
  | 'implementing'
  | 'reviewing'
  | 'master_validation';

export type ResumeTargetState =
  | SafeExecutionState
  | 'awaiting_plan_approval'
  | 'rework_requested'
  | 'awaiting_user'
  | 'interrupted_needs_inspection'
  | 'completed';

export interface PendingResumeAttempt {
  readonly attemptId: AttemptId;
  readonly baselineId: BaselineId;
  readonly role: AgentRole;
}

export interface ReworkRequestContext {
  readonly status: 'deferred' | 'pending';
  readonly reason: string;
  readonly nextReworkNumber: number;
}

export type AwaitingUserAction =
  | 'retry_environment'
  | 'continue'
  | 'cancel';

export interface WorkflowContext {
  readonly taskId: TaskId;
  readonly requirementVersion: RequirementVersion;
  readonly reworkCount: number;
  readonly maxReworks: typeof MAX_REWORKS;
  readonly pauseAfterAttempt: boolean;
  readonly resumeTargetState?: ResumeTargetState;
  readonly pendingResumeAttempt?: PendingResumeAttempt;
  readonly awaitingResumeTargetState?: SafeExecutionState;
  readonly inspectionResumeTargetState?: SafeExecutionState;
  readonly activeAttemptId?: AttemptId;
  readonly activeAttemptBaselineId?: BaselineId;
  readonly activeAttemptRole?: AgentRole;
  readonly stopIntent?: StopIntent;
  readonly awaitingReason?: string;
  readonly allowedAwaitingActions?: readonly AwaitingUserAction[];
  readonly reworkRequest?: ReworkRequestContext;
}

type SnapshotFor<State extends WorkflowState> = WorkflowContext & {
  readonly state: State;
};

export type WorkflowSnapshot = {
  [State in WorkflowState]: SnapshotFor<State>;
}[WorkflowState];

export function isTerminalState(state: WorkflowState): state is TerminalState {
  return (TERMINAL_STATES as readonly WorkflowState[]).includes(state);
}

export function isSafeExecutionState(
  state: ResumeTargetState,
): state is SafeExecutionState {
  return (
    state === 'planning' ||
    state === 'implementing' ||
    state === 'reviewing' ||
    state === 'master_validation'
  );
}

export function expectedRoleForExecutionState(
  state: SafeExecutionState,
): AgentRole {
  switch (state) {
    case 'planning':
    case 'master_validation':
      return 'master';
    case 'implementing':
      return 'implementer';
    case 'reviewing':
      return 'reviewer';
  }
}

export type WorkflowSnapshotValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

export function validateWorkflowSnapshot(
  snapshot: WorkflowSnapshot,
): WorkflowSnapshotValidation {
  const invalid = (reason: string): WorkflowSnapshotValidation => ({
    valid: false,
    reason,
  });
  const hasActiveIdentity =
    snapshot.activeAttemptId !== undefined &&
    snapshot.activeAttemptBaselineId !== undefined &&
    snapshot.activeAttemptRole !== undefined;
  const hasAnyActiveIdentity =
    snapshot.activeAttemptId !== undefined ||
    snapshot.activeAttemptBaselineId !== undefined ||
    snapshot.activeAttemptRole !== undefined;

  if (
    snapshot.reworkCount < 0 ||
    snapshot.reworkCount > snapshot.maxReworks
  ) {
    return invalid('reworkCount is outside the configured bounds');
  }

  if (
    snapshot.pauseAfterAttempt &&
    !isSafeExecutionState(snapshot.state as ResumeTargetState)
  ) {
    return invalid('pauseAfterAttempt is only valid during an external run');
  }

  if (isSafeExecutionState(snapshot.state as ResumeTargetState)) {
    const state = snapshot.state as SafeExecutionState;
    if (!hasActiveIdentity) {
      return invalid(`${state} requires a complete active attempt identity`);
    }
    if (snapshot.activeAttemptRole !== expectedRoleForExecutionState(state)) {
      return invalid(`${state} active attempt has the wrong role`);
    }
  } else if (snapshot.state === 'interrupting' || snapshot.state === 'cleanup_failed') {
    if (!hasActiveIdentity || snapshot.stopIntent === undefined) {
      return invalid(`${snapshot.state} requires stop intent and cleanup attempt identity`);
    }
  } else if (hasAnyActiveIdentity) {
    return invalid(`${snapshot.state} must not retain an active attempt identity`);
  }

  if (snapshot.state === 'paused_after_run') {
    const target = snapshot.resumeTargetState;
    if (target === undefined) {
      return invalid('paused_after_run requires resumeTargetState');
    }
    if (isSafeExecutionState(target)) {
      const pending = snapshot.pendingResumeAttempt;
      if (
        pending === undefined ||
        pending.role !== expectedRoleForExecutionState(target)
      ) {
        return invalid('paused external run requires a role-correct pending attempt');
      }
    }
    if (
      target === 'rework_requested' &&
      (snapshot.reworkRequest === undefined ||
        snapshot.reworkRequest.status !== 'deferred')
    ) {
      return invalid('paused rework requires deferred rework context');
    }
    if (target === 'awaiting_user') {
      if (
        snapshot.awaitingReason?.trim() === '' ||
        snapshot.awaitingReason === undefined ||
        snapshot.allowedAwaitingActions === undefined ||
        snapshot.allowedAwaitingActions.length === 0
      ) {
        return invalid('paused awaiting_user requires reason and allowed actions');
      }
      if (
        snapshot.allowedAwaitingActions.includes('continue') &&
        snapshot.awaitingResumeTargetState === undefined
      ) {
        return invalid('paused awaiting_user continue requires a safe nested target');
      }
    }
    if (
      target === 'interrupted_needs_inspection' &&
      snapshot.inspectionResumeTargetState === undefined
    ) {
      return invalid('paused inspection requires a safe inspection target');
    }
  }

  if (
    snapshot.state === 'interrupted_needs_inspection' &&
    (snapshot.resumeTargetState === undefined ||
      !isSafeExecutionState(snapshot.resumeTargetState))
  ) {
    return invalid('interrupted_needs_inspection requires a safe resume target');
  }

  if (snapshot.state === 'awaiting_user') {
    if (
      snapshot.awaitingReason?.trim() === '' ||
      snapshot.awaitingReason === undefined ||
      snapshot.allowedAwaitingActions === undefined ||
      snapshot.allowedAwaitingActions.length === 0
    ) {
      return invalid('awaiting_user requires reason and allowed actions');
    }
    if (
      snapshot.allowedAwaitingActions.includes('continue') &&
      (snapshot.resumeTargetState === undefined ||
        !isSafeExecutionState(snapshot.resumeTargetState))
    ) {
      return invalid('awaiting_user continue requires a safe resume target');
    }
  }

  if (snapshot.state === 'rework_requested') {
    if (
      snapshot.reworkRequest === undefined ||
      snapshot.reworkRequest.status !== 'pending' ||
      snapshot.reworkRequest.reason.trim() === ''
    ) {
      return invalid('rework_requested requires pending rework reason context');
    }
  }

  if (isTerminalState(snapshot.state)) {
    if (
      hasAnyActiveIdentity ||
      snapshot.stopIntent !== undefined ||
      snapshot.pauseAfterAttempt
    ) {
      return invalid('terminal workflow retains active control state');
    }
  }

  if (
    snapshot.state !== 'interrupting' &&
    snapshot.state !== 'cleanup_failed' &&
    snapshot.stopIntent !== undefined
  ) {
    return invalid(`${snapshot.state} must not retain stopIntent`);
  }

  return { valid: true };
}
