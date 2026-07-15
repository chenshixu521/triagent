import type { AgentMessageState } from '../agents/agent-adapter.js';
import type { RunAttempt } from '../domain/attempt.js';
import type { AttemptId, BaselineId, TaskId } from '../domain/ids.js';
import type { SafeExecutionState, WorkflowState } from './states.js';

export type ReconciliationReplayPolicy =
  | 'idempotent'
  | 'never-auto-replay';

export interface ReconciliationActionEvidence {
  readonly actionId: string;
  readonly type: string;
  readonly idempotencyKey: string;
  readonly replayPolicy: ReconciliationReplayPolicy;
  readonly status: 'intent' | 'completed' | 'failed';
  readonly result?: unknown;
  readonly safeToFeedForward: boolean;
  readonly resultConsumed: boolean;
}

export type ReconciliationProcessEvidence =
  | {
      readonly identity: 'not_applicable';
      readonly terminalState: 'not_applicable';
    }
  | {
      readonly identity: 'matched';
      readonly terminalState: 'running' | 'exited' | 'unknown';
      readonly pid: number;
      readonly processStartedAt: string;
    }
  | {
      readonly identity: 'mismatched';
      readonly terminalState: 'unknown';
      readonly diagnostic: string;
    }
  | {
      readonly identity: 'unverifiable';
      readonly terminalState: 'unknown';
      readonly diagnostic: string;
    };

export type ReconciliationLockEvidence =
  | {
      readonly status: 'present';
      readonly ownerInstanceId: string;
      readonly leaseExpiresAt: string;
    }
  | {
      readonly status: 'missing';
      readonly diagnostic: string;
    }
  | {
      readonly status: 'conflicting';
      readonly diagnostic: string;
    };

export type ReconciliationBaselineEvidence =
  | {
      readonly status: 'complete';
      readonly taskId: TaskId;
      readonly baselineId: BaselineId;
      readonly attemptId?: AttemptId;
    }
  | {
      readonly status: 'missing';
      readonly diagnostic: string;
    }
  | {
      readonly status: 'incomplete';
      readonly diagnostic: string;
    };

export interface ReconciliationMessageEvidence {
  readonly messageId: string;
  readonly attemptId: AttemptId;
  readonly state: AgentMessageState;
}

export interface StartupReconciliationEvidence {
  readonly taskId: TaskId;
  readonly ownerInstanceId: string;
  readonly observedAt: string;
  readonly resumeTargetState: SafeExecutionState;
  readonly actions: readonly ReconciliationActionEvidence[];
  readonly lastAttempt?: RunAttempt;
  readonly process: ReconciliationProcessEvidence;
  readonly lock: ReconciliationLockEvidence;
  readonly baseline: ReconciliationBaselineEvidence;
  readonly messages: readonly ReconciliationMessageEvidence[];
}

export interface ReconciliationEvidencePort {
  readStartupEvidence(taskId: TaskId): Promise<StartupReconciliationEvidence>;
}

export type ReconciliationMessageDisposition =
  | 'keep_queued'
  | 'do_not_resend'
  | 'already_applied';

export interface ReconciliationMessageDirective {
  readonly messageId: string;
  readonly disposition: ReconciliationMessageDisposition;
}

export type ReconciliationOperatorAction =
  | 'inspect'
  | 'retry'
  | 'continue'
  | 'cancel';

export type ReconciliationReasonCode =
  | 'project_lock_missing'
  | 'project_lock_conflicting'
  | 'project_lock_owner_mismatch'
  | 'project_lock_stale'
  | 'baseline_missing'
  | 'baseline_incomplete'
  | 'baseline_identity_mismatch'
  | 'process_identity_mismatch'
  | 'process_identity_unverifiable'
  | 'process_terminal_state_unknown'
  | 'process_still_running'
  | 'pending_attempt_unresolved'
  | 'unknown_non_idempotent_result'
  | 'unsafe_completed_action'
  | 'failed_action_requires_inspection'
  | 'message_delivery_ambiguous';

interface ReconciliationDecisionBase {
  readonly taskId: TaskId;
  readonly decisionMarker: string;
  readonly reason: string;
  readonly automaticExternalExecution: false;
  readonly messageDirectives: readonly ReconciliationMessageDirective[];
}

export type StartupReconciliationDecision =
  | (ReconciliationDecisionBase & {
      readonly kind: 'blocked';
      readonly targetState: Extract<
        WorkflowState,
        'interrupted_needs_inspection' | 'awaiting_user'
      >;
      readonly resumeTargetState: SafeExecutionState;
      readonly reasonCode: ReconciliationReasonCode;
      readonly operatorActions: readonly ReconciliationOperatorAction[];
    })
  | (ReconciliationDecisionBase & {
      readonly kind: 'feed_forward';
      readonly actionId: string;
      readonly workflowEvent: unknown;
      readonly idempotencyMarker: string;
    })
  | (ReconciliationDecisionBase & {
      readonly kind: 'retry_idempotent';
      readonly actionId: string;
      readonly idempotencyMarker: string;
    })
  | (ReconciliationDecisionBase & {
      readonly kind: 'noop';
    });

function messageDirectives(
  messages: readonly ReconciliationMessageEvidence[],
): readonly ReconciliationMessageDirective[] {
  return messages.map((message) => {
    switch (message.state) {
      case 'queued':
        return { messageId: message.messageId, disposition: 'keep_queued' };
      case 'applied':
        return { messageId: message.messageId, disposition: 'already_applied' };
      case 'delivered':
      case 'acknowledged':
      case 'failed':
        return { messageId: message.messageId, disposition: 'do_not_resend' };
    }
  });
}

function blockedDecision(
  evidence: StartupReconciliationEvidence,
  directives: readonly ReconciliationMessageDirective[],
  targetState: 'interrupted_needs_inspection' | 'awaiting_user',
  reasonCode: ReconciliationReasonCode,
  reason: string,
): StartupReconciliationDecision {
  return {
    kind: 'blocked',
    taskId: evidence.taskId,
    decisionMarker: `reconcile:${evidence.taskId}:blocked:${reasonCode}`,
    reason,
    reasonCode,
    targetState,
    resumeTargetState: evidence.resumeTargetState,
    automaticExternalExecution: false,
    messageDirectives: directives,
    operatorActions: evidence.lastAttempt === undefined
      ? ['cancel']
      : ['inspect', 'cancel'],
  };
}

function diagnosticSuffix(diagnostic: string | undefined): string {
  return diagnostic === undefined || diagnostic.trim() === ''
    ? ''
    : `: ${diagnostic}`;
}

function workflowEventFromResult(result: unknown): unknown | undefined {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return undefined;
  }
  return (result as { readonly workflowEvent?: unknown }).workflowEvent;
}

function validateLock(
  evidence: StartupReconciliationEvidence,
  directives: readonly ReconciliationMessageDirective[],
): StartupReconciliationDecision | undefined {
  if (evidence.lock.status === 'missing') {
    if (evidence.lastAttempt === undefined) return undefined;
    return blockedDecision(
      evidence,
      directives,
      'awaiting_user',
      'project_lock_missing',
      `project lock is missing${diagnosticSuffix(evidence.lock.diagnostic)}`,
    );
  }
  if (evidence.lock.status === 'conflicting') {
    return blockedDecision(
      evidence,
      directives,
      'awaiting_user',
      'project_lock_conflicting',
      `project lock conflicts with another owner${diagnosticSuffix(evidence.lock.diagnostic)}`,
    );
  }
  const observedAt = Date.parse(evidence.observedAt);
  const leaseExpiresAt = Date.parse(evidence.lock.leaseExpiresAt);
  if (
    !Number.isFinite(observedAt) ||
    !Number.isFinite(leaseExpiresAt) ||
    leaseExpiresAt <= observedAt
  ) {
    return blockedDecision(
      evidence,
      directives,
      'awaiting_user',
      'project_lock_stale',
      'project lock lease is stale or cannot be verified',
    );
  }
  if (evidence.lock.ownerInstanceId !== evidence.ownerInstanceId) {
    return blockedDecision(
      evidence,
      directives,
      'awaiting_user',
      'project_lock_owner_mismatch',
      'project lock is owned by a different application instance',
    );
  }
  return undefined;
}

function validateBaseline(
  evidence: StartupReconciliationEvidence,
  directives: readonly ReconciliationMessageDirective[],
): StartupReconciliationDecision | undefined {
  if (evidence.baseline.status === 'missing') {
    if (evidence.lastAttempt === undefined) return undefined;
    return blockedDecision(
      evidence,
      directives,
      'awaiting_user',
      'baseline_missing',
      `baseline manifest is missing${diagnosticSuffix(evidence.baseline.diagnostic)}`,
    );
  }
  if (evidence.baseline.status === 'incomplete') {
    return blockedDecision(
      evidence,
      directives,
      'awaiting_user',
      'baseline_incomplete',
      `baseline manifest is incomplete${diagnosticSuffix(evidence.baseline.diagnostic)}`,
    );
  }
  const attempt = evidence.lastAttempt;
  if (
    evidence.baseline.taskId !== evidence.taskId ||
    (attempt !== undefined && evidence.baseline.baselineId !== attempt.baselineId) ||
    (
      attempt !== undefined &&
      evidence.baseline.attemptId !== undefined &&
      evidence.baseline.attemptId !== attempt.attemptId
    )
  ) {
    return blockedDecision(
      evidence,
      directives,
      'awaiting_user',
      'baseline_identity_mismatch',
      'baseline manifest identity does not match the task and last attempt',
    );
  }
  return undefined;
}

function validateAttemptProcess(
  evidence: StartupReconciliationEvidence,
  directives: readonly ReconciliationMessageDirective[],
): StartupReconciliationDecision | undefined {
  const attempt = evidence.lastAttempt;
  if (attempt === undefined || attempt.status === 'completed') return undefined;
  if (attempt.status === 'pending') {
    return blockedDecision(
      evidence,
      directives,
      'interrupted_needs_inspection',
      'pending_attempt_unresolved',
      'the last run attempt never acquired a durable process identity',
    );
  }
  const process = evidence.process;
  if (process.identity === 'unverifiable' || process.identity === 'not_applicable') {
    return blockedDecision(
      evidence,
      directives,
      'interrupted_needs_inspection',
      'process_identity_unverifiable',
      `active attempt process identity cannot be verified${diagnosticSuffix(
        process.identity === 'unverifiable' ? process.diagnostic : undefined,
      )}`,
    );
  }
  if (
    process.identity === 'mismatched' ||
    process.pid !== attempt.pid ||
    process.processStartedAt !== attempt.processStartedAt
  ) {
    return blockedDecision(
      evidence,
      directives,
      'interrupted_needs_inspection',
      'process_identity_mismatch',
      `active attempt process identity does not match the durable attempt${diagnosticSuffix(
        process.identity === 'mismatched' ? process.diagnostic : undefined,
      )}`,
    );
  }
  if (process.terminalState === 'running') {
    return blockedDecision(
      evidence,
      directives,
      'interrupted_needs_inspection',
      'process_still_running',
      'the verified attempt process is still running',
    );
  }
  if (process.terminalState === 'unknown') {
    return blockedDecision(
      evidence,
      directives,
      'interrupted_needs_inspection',
      'process_terminal_state_unknown',
      'the verified attempt process has an unknown terminal state',
    );
  }
  return undefined;
}

export function decideStartupReconciliation(
  evidence: StartupReconciliationEvidence,
): StartupReconciliationDecision {
  const directives = messageDirectives(evidence.messages);

  const lockDecision = validateLock(evidence, directives);
  if (lockDecision !== undefined) return lockDecision;

  const baselineDecision = validateBaseline(evidence, directives);
  if (baselineDecision !== undefined) return baselineDecision;

  const attemptDecision = validateAttemptProcess(evidence, directives);
  if (attemptDecision !== undefined) return attemptDecision;

  const ambiguousMessage = evidence.messages.find(
    (message) =>
      message.state === 'delivered' ||
      message.state === 'acknowledged' ||
      message.state === 'failed',
  );
  if (ambiguousMessage !== undefined) {
    return blockedDecision(
      evidence,
      directives,
      'awaiting_user',
      'message_delivery_ambiguous',
      `message ${ambiguousMessage.messageId} must not be resent without inspection`,
    );
  }

  const feedForward = evidence.actions.find(
    (action) =>
      action.status === 'completed' &&
      action.safeToFeedForward &&
      !action.resultConsumed,
  );
  if (feedForward !== undefined) {
    const workflowEvent = workflowEventFromResult(feedForward.result);
    if (workflowEvent === undefined) {
      return blockedDecision(
        evidence,
        directives,
        'awaiting_user',
        'unsafe_completed_action',
        `completed action ${feedForward.actionId} has no durable workflow event`,
      );
    }
    const idempotencyMarker =
      `reconcile:${evidence.taskId}:${feedForward.idempotencyKey}:consume`;
    return {
      kind: 'feed_forward',
      taskId: evidence.taskId,
      actionId: feedForward.actionId,
      workflowEvent,
      idempotencyMarker,
      decisionMarker: idempotencyMarker,
      reason: 'a durable stage result is ready for exactly-once reducer consumption',
      automaticExternalExecution: false,
      messageDirectives: directives,
    };
  }

  const unsafeCompleted = evidence.actions.find(
    (action) =>
      action.status === 'completed' &&
      !action.safeToFeedForward &&
      !action.resultConsumed,
  );
  if (unsafeCompleted !== undefined) {
    return blockedDecision(
      evidence,
      directives,
      'interrupted_needs_inspection',
      'unsafe_completed_action',
      `completed action ${unsafeCompleted.actionId} cannot be reduced directly`,
    );
  }

  const failedAction = evidence.actions.find(
    (action) => action.status === 'failed' && !action.resultConsumed,
  );
  if (failedAction !== undefined) {
    return blockedDecision(
      evidence,
      directives,
      'awaiting_user',
      'failed_action_requires_inspection',
      `failed action ${failedAction.actionId} requires explicit inspection`,
    );
  }

  const unknownNonIdempotent = evidence.actions.find(
    (action) =>
      action.status === 'intent' &&
      action.replayPolicy === 'never-auto-replay',
  );
  if (unknownNonIdempotent !== undefined) {
    return blockedDecision(
      evidence,
      directives,
      'interrupted_needs_inspection',
      'unknown_non_idempotent_result',
      `action ${unknownNonIdempotent.actionId} has an intent but no durable result and must not be replayed`,
    );
  }

  const retryable = evidence.actions.find(
    (action) =>
      action.status === 'intent' && action.replayPolicy === 'idempotent',
  );
  if (retryable !== undefined) {
    return {
      kind: 'retry_idempotent',
      taskId: evidence.taskId,
      actionId: retryable.actionId,
      idempotencyMarker: retryable.idempotencyKey,
      decisionMarker: `reconcile:${evidence.taskId}:${retryable.idempotencyKey}:retry`,
      reason: `idempotent action ${retryable.actionId} may be retried by the orchestrator`,
      automaticExternalExecution: false,
      messageDirectives: directives,
    };
  }

  return {
    kind: 'noop',
    taskId: evidence.taskId,
    decisionMarker: `reconcile:${evidence.taskId}:noop`,
    reason: 'no unsafe or unapplied durable recovery work was found',
    automaticExternalExecution: false,
    messageDirectives: directives,
  };
}

export async function reconcileStartup(
  port: ReconciliationEvidencePort,
  taskId: TaskId,
): Promise<StartupReconciliationDecision> {
  const evidence = await port.readStartupEvidence(taskId);
  return decideStartupReconciliation(evidence);
}
