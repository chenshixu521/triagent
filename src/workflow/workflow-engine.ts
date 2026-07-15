import type { AttemptId, BaselineId, TaskId } from '../domain/ids.js';
import {
  expectedRoleForExecutionState,
  isSafeExecutionState,
  isTerminalState,
  MAX_REWORKS,
  type ResumeTargetState,
  type SafeExecutionState,
  type WorkflowContext,
  type WorkflowSnapshot,
  type WorkflowState,
  validateWorkflowSnapshot,
} from './states.js';
import type { WorkflowEffect, WorkflowEvent } from './transitions.js';

export type Transitioned = WorkflowSnapshot & {
  readonly kind: 'transitioned';
  readonly effects: readonly WorkflowEffect[];
};

export type IllegalTransition = WorkflowSnapshot & {
  readonly kind: 'illegal-transition';
  readonly effects: readonly [];
  readonly reason: string;
};

export type InvalidSnapshot = WorkflowSnapshot & {
  readonly kind: 'invalid-snapshot';
  readonly effects: readonly [];
  readonly reason: string;
};

export type TransitionResult = Transitioned | IllegalTransition | InvalidSnapshot;

const CLEAR_ACTIVE_ATTEMPT: Partial<WorkflowContext> = {
  activeAttemptId: undefined,
  activeAttemptBaselineId: undefined,
  activeAttemptRole: undefined,
};

function activeAttemptContext(
  state: SafeExecutionState,
  attemptId: AttemptId,
  baselineId: BaselineId,
): Partial<WorkflowContext> {
  return {
    activeAttemptId: attemptId,
    activeAttemptBaselineId: baselineId,
    activeAttemptRole: expectedRoleForExecutionState(state),
  };
}

export function createInitialWorkflow(taskId: TaskId): WorkflowSnapshot {
  return {
    state: 'draft',
    taskId,
    requirementVersion: 1,
    reworkCount: 0,
    maxReworks: MAX_REWORKS,
    pauseAfterAttempt: false,
  };
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union member: ${JSON.stringify(value)}`);
}

function illegal(
  snapshot: WorkflowSnapshot,
  event: WorkflowEvent,
  detail?: string,
): IllegalTransition {
  return {
    ...snapshot,
    kind: 'illegal-transition',
    effects: [],
    reason:
      detail ?? `Event ${event.type} is illegal while workflow is ${snapshot.state}`,
  };
}

function invalidSnapshot(
  snapshot: WorkflowSnapshot,
  reason: string,
): InvalidSnapshot {
  return {
    ...snapshot,
    kind: 'invalid-snapshot',
    effects: [],
    reason: `Invalid workflow snapshot: ${reason}`,
  };
}

function persistTransition(
  snapshot: WorkflowSnapshot,
  nextState: WorkflowState,
  event: WorkflowEvent,
): WorkflowEffect {
  return {
    type: 'PersistTransition',
    taskId: snapshot.taskId,
    from: snapshot.state,
    to: nextState,
    event: event.type,
  };
}

function moved(
  snapshot: WorkflowSnapshot,
  event: WorkflowEvent,
  nextState: WorkflowState,
  patch: Partial<WorkflowContext> = {},
  effects: readonly WorkflowEffect[] = [],
): Transitioned {
  return {
    ...snapshot,
    awaitingReason: undefined,
    allowedAwaitingActions: undefined,
    resumeTargetState: undefined,
    pendingResumeAttempt: undefined,
    awaitingResumeTargetState: undefined,
    inspectionResumeTargetState: undefined,
    reworkRequest: undefined,
    stopIntent: undefined,
    ...patch,
    state: nextState,
    kind: 'transitioned',
    effects: [...effects, persistTransition(snapshot, nextState, event)],
  } as Transitioned;
}

function waitingForUser(
  snapshot: WorkflowSnapshot,
  event: WorkflowEvent,
  reason: string,
  allowedAwaitingActions: WorkflowContext['allowedAwaitingActions'],
  resumeTargetState?: ResumeTargetState,
  effects: readonly WorkflowEffect[] = [],
): Transitioned {
  return moved(
    snapshot,
    event,
    'awaiting_user',
    {
      awaitingReason: reason,
      allowedAwaitingActions,
      resumeTargetState,
      pauseAfterAttempt: false,
      ...CLEAR_ACTIVE_ATTEMPT,
    },
    effects,
  );
}

function attemptEffects(
  snapshot: WorkflowSnapshot,
  attemptId: AttemptId,
  baselineId: BaselineId,
): readonly WorkflowEffect[] {
  return effectsForNewAttempt(
    snapshot,
    'implementing',
    attemptId,
    baselineId,
  );
}

function createAttemptBaselineEffect(
  snapshot: WorkflowSnapshot,
  attemptId: AttemptId,
  baselineId: BaselineId,
): WorkflowEffect {
  return {
    type: 'CreateAttemptBaseline',
    taskId: snapshot.taskId,
    attemptId,
    baselineId,
    requirementVersion: snapshot.requirementVersion,
  };
}

function effectsForExecutionState(
  snapshot: WorkflowSnapshot,
  targetState: SafeExecutionState,
  attemptId: AttemptId,
  baselineId: BaselineId,
): readonly WorkflowEffect[] {
  switch (targetState) {
    case 'planning':
      return [
        {
          type: 'StartPlanning',
          taskId: snapshot.taskId,
          attemptId,
          baselineId,
          requirementVersion: snapshot.requirementVersion,
          role: 'master',
        },
      ];
    case 'implementing':
      return [
        {
          type: 'PrepareImplementationWorkspace',
          taskId: snapshot.taskId,
          attemptId,
          baselineId,
          requirementVersion: snapshot.requirementVersion,
        },
        {
          type: 'StartImplementation',
          taskId: snapshot.taskId,
          attemptId,
          baselineId,
          requirementVersion: snapshot.requirementVersion,
          role: 'implementer',
        },
      ];
    case 'reviewing':
      return [
        {
          type: 'StartReview',
          taskId: snapshot.taskId,
          attemptId,
          baselineId,
          requirementVersion: snapshot.requirementVersion,
          role: 'reviewer',
        },
      ];
    case 'master_validation':
      return [
        {
          type: 'StartMasterValidation',
          taskId: snapshot.taskId,
          attemptId,
          baselineId,
          requirementVersion: snapshot.requirementVersion,
          role: 'master',
        },
      ];
    default:
      return assertNever(targetState);
  }
}

function effectsForNewAttempt(
  snapshot: WorkflowSnapshot,
  targetState: SafeExecutionState,
  attemptId: AttemptId,
  baselineId: BaselineId,
): readonly WorkflowEffect[] {
  const startEffects = effectsForExecutionState(
    snapshot,
    targetState,
    attemptId,
    baselineId,
  );

  return [
    createAttemptBaselineEffect(snapshot, attemptId, baselineId),
    ...startEffects,
  ];
}

function cancel(
  snapshot: WorkflowSnapshot,
  event: Extract<WorkflowEvent, { type: 'CANCEL' | 'AWAITING_USER_CANCEL' }>,
): TransitionResult {
  if (snapshot.state === 'cleanup_failed') {
    return illegal(snapshot, event, 'Cleanup must succeed before cancellation');
  }

  if (snapshot.activeAttemptId !== undefined) {
    return moved(
      snapshot,
      event,
      'interrupting',
      { stopIntent: 'cancel' },
      [
        {
          type: 'BeginProcessCleanup',
          taskId: snapshot.taskId,
          attemptId: snapshot.activeAttemptId,
          stopIntent: 'cancel',
        },
      ],
    );
  }

  return moved(snapshot, event, 'cancelled', {}, [
    { type: 'ReleaseProjectLock', taskId: snapshot.taskId },
  ]);
}

export function transition(
  snapshot: WorkflowSnapshot,
  event: WorkflowEvent,
): TransitionResult {
  const validation = validateWorkflowSnapshot(snapshot);
  if (!validation.valid) {
    return invalidSnapshot(snapshot, validation.reason);
  }

  if (isTerminalState(snapshot.state)) {
    return illegal(snapshot, event, `Terminal state ${snapshot.state} cannot transition`);
  }

  switch (event.type) {
    case 'START':
      if (snapshot.state !== 'draft') return illegal(snapshot, event);
      return moved(snapshot, event, 'checking_environment', {}, [
        { type: 'AcquireProjectLock', taskId: snapshot.taskId },
        { type: 'RunEnvironmentCheck', taskId: snapshot.taskId },
      ]);

    case 'ENVIRONMENT_READY':
      if (snapshot.state !== 'checking_environment') return illegal(snapshot, event);
      return moved(
        snapshot,
        event,
        'planning',
        activeAttemptContext('planning', event.attemptId, event.baselineId),
        effectsForNewAttempt(
          snapshot,
          'planning',
          event.attemptId,
          event.baselineId,
        ),
      );

    case 'ENVIRONMENT_FAILED':
      if (snapshot.state !== 'checking_environment') return illegal(snapshot, event);
      return waitingForUser(snapshot, event, event.reason, [
        'retry_environment',
        'cancel',
      ], undefined, [
        { type: 'ReleaseProjectLock', taskId: snapshot.taskId },
      ]);

    case 'PLAN_READY':
      if (snapshot.state !== 'planning') return illegal(snapshot, event);
      if (snapshot.activeAttemptId !== event.attemptId) {
        return illegal(snapshot, event, 'Plan result does not match activeAttemptId');
      }
      if (snapshot.pauseAfterAttempt) {
        if (event.requiresApproval) {
          return moved(snapshot, event, 'paused_after_run', {
            ...CLEAR_ACTIVE_ATTEMPT,
            pauseAfterAttempt: false,
            resumeTargetState: 'awaiting_plan_approval',
          });
        }
        return moved(snapshot, event, 'paused_after_run', {
          ...CLEAR_ACTIVE_ATTEMPT,
          pauseAfterAttempt: false,
          resumeTargetState: 'implementing',
          pendingResumeAttempt: {
            attemptId: event.implementationAttemptId,
            baselineId: event.implementationBaselineId,
            role: 'implementer',
          },
        });
      }
      if (event.requiresApproval) {
        return moved(snapshot, event, 'awaiting_plan_approval', {
          ...CLEAR_ACTIVE_ATTEMPT,
        });
      }
      return moved(
        snapshot,
        event,
        'implementing',
        activeAttemptContext(
          'implementing',
          event.implementationAttemptId,
          event.implementationBaselineId,
        ),
        attemptEffects(
          snapshot,
          event.implementationAttemptId,
          event.implementationBaselineId,
        ),
      );

    case 'PLAN_FAILED':
      if (snapshot.state !== 'planning') return illegal(snapshot, event);
      if (snapshot.activeAttemptId !== event.attemptId) {
        return illegal(snapshot, event, 'Plan failure does not match activeAttemptId');
      }
      return waitingForUser(
        snapshot,
        event,
        event.reason,
        ['continue', 'cancel'],
        'planning',
      );

    case 'PLAN_APPROVED':
      if (snapshot.state !== 'awaiting_plan_approval') return illegal(snapshot, event);
      return moved(
        snapshot,
        event,
        'implementing',
        activeAttemptContext('implementing', event.attemptId, event.baselineId),
        attemptEffects(snapshot, event.attemptId, event.baselineId),
      );

    case 'PLAN_REVISION_REQUESTED':
      if (snapshot.state !== 'awaiting_plan_approval') return illegal(snapshot, event);
      return moved(
        snapshot,
        event,
        'planning',
        {
          requirementVersion: snapshot.requirementVersion + 1,
          ...activeAttemptContext('planning', event.attemptId, event.baselineId),
        },
        effectsForNewAttempt(
          {
            ...snapshot,
            requirementVersion: snapshot.requirementVersion + 1,
          } as WorkflowSnapshot,
          'planning',
          event.attemptId,
          event.baselineId,
        ),
      );

    case 'IMPLEMENTATION_COMPLETED':
      if (snapshot.state !== 'implementing') return illegal(snapshot, event);
      if (snapshot.activeAttemptId !== event.attemptId) {
        return illegal(snapshot, event, 'Completed attempt does not match activeAttemptId');
      }
      if (snapshot.pauseAfterAttempt) {
        return moved(snapshot, event, 'paused_after_run', {
          ...CLEAR_ACTIVE_ATTEMPT,
          pauseAfterAttempt: false,
          resumeTargetState: 'reviewing',
          pendingResumeAttempt: {
            attemptId: event.reviewAttemptId,
            baselineId: event.reviewBaselineId,
            role: 'reviewer',
          },
        });
      }
      return moved(
        snapshot,
        event,
        'reviewing',
        activeAttemptContext(
          'reviewing',
          event.reviewAttemptId,
          event.reviewBaselineId,
        ),
        [
          {
            type: 'FinalizeCandidateChangeSet',
            taskId: snapshot.taskId,
            attemptId: event.attemptId,
            baselineId: snapshot.activeAttemptBaselineId ?? event.reviewBaselineId,
          },
          ...effectsForNewAttempt(
            snapshot,
            'reviewing',
            event.reviewAttemptId,
            event.reviewBaselineId,
          ),
        ],
      );

    case 'IMPLEMENTATION_FAILED':
      if (snapshot.state !== 'implementing') return illegal(snapshot, event);
      if (snapshot.activeAttemptId !== event.attemptId) {
        return illegal(
          snapshot,
          event,
          'Implementation failure does not match activeAttemptId',
        );
      }
      return moved(snapshot, event, 'interrupted_needs_inspection', {
        ...CLEAR_ACTIVE_ATTEMPT,
        awaitingReason: event.reason,
        resumeTargetState: 'implementing',
        pauseAfterAttempt: false,
      });

    case 'REVIEW_COMPLETED':
      if (snapshot.state !== 'reviewing') return illegal(snapshot, event);
      if (snapshot.activeAttemptId !== event.attemptId) {
        return illegal(snapshot, event, 'Review result does not match activeAttemptId');
      }
      if (snapshot.pauseAfterAttempt) {
        return moved(snapshot, event, 'paused_after_run', {
          ...CLEAR_ACTIVE_ATTEMPT,
          pauseAfterAttempt: false,
          resumeTargetState: 'master_validation',
          pendingResumeAttempt: {
            attemptId: event.masterAttemptId,
            baselineId: event.masterBaselineId,
            role: 'master',
          },
        });
      }
      return moved(
        snapshot,
        event,
        'master_validation',
        activeAttemptContext(
          'master_validation',
          event.masterAttemptId,
          event.masterBaselineId,
        ),
        effectsForNewAttempt(
          snapshot,
          'master_validation',
          event.masterAttemptId,
          event.masterBaselineId,
        ),
      );

    case 'REVIEW_INVALIDATED':
      if (snapshot.state !== 'reviewing') return illegal(snapshot, event);
      if (snapshot.activeAttemptId !== event.attemptId) {
        return illegal(
          snapshot,
          event,
          'Invalidated review does not match activeAttemptId',
        );
      }
      return waitingForUser(
        snapshot,
        event,
        event.reason,
        ['continue', 'cancel'],
        'reviewing',
      );

    case 'REVIEW_FAILED':
      if (snapshot.state !== 'reviewing') return illegal(snapshot, event);
      if (snapshot.activeAttemptId !== event.attemptId) {
        return illegal(snapshot, event, 'Review failure does not match activeAttemptId');
      }
      return waitingForUser(
        snapshot,
        event,
        event.reason,
        ['continue', 'cancel'],
        'reviewing',
      );

    case 'REVIEW_REWORK_REQUESTED':
      if (snapshot.state !== 'reviewing') return illegal(snapshot, event);
      if (snapshot.activeAttemptId !== event.attemptId) {
        return illegal(
          snapshot,
          event,
          'Review rework request does not match activeAttemptId',
        );
      }
      if (snapshot.reworkCount >= snapshot.maxReworks) {
        return waitingForUser(
          snapshot,
          event,
          `Automatic rework limit reached (${snapshot.maxReworks} reworks)`,
          ['cancel'],
        );
      }
      {
        const reworkRequest = {
          reason: event.reason,
          nextReworkNumber: snapshot.reworkCount + 1,
        };
        return moved(
          snapshot,
          event,
          'rework_requested',
          {
            ...CLEAR_ACTIVE_ATTEMPT,
            pauseAfterAttempt: false,
            reworkRequest: { ...reworkRequest, status: 'pending' },
          },
          [
            {
              type: 'PersistReworkRequest',
              taskId: snapshot.taskId,
              ...reworkRequest,
            },
          ],
        );
      }

    case 'MASTER_APPROVED':
      if (snapshot.state !== 'master_validation') return illegal(snapshot, event);
      if (snapshot.activeAttemptId !== event.attemptId) {
        return illegal(snapshot, event, 'Master result does not match activeAttemptId');
      }
      if (snapshot.pauseAfterAttempt) {
        return moved(snapshot, event, 'paused_after_run', {
          ...CLEAR_ACTIVE_ATTEMPT,
          pauseAfterAttempt: false,
          resumeTargetState: 'completed',
        });
      }
      return moved(
        snapshot,
        event,
        'completed',
        { ...CLEAR_ACTIVE_ATTEMPT, pauseAfterAttempt: false },
        [
          {
            type: 'PromoteCandidateWorkspace',
            taskId: snapshot.taskId,
            attemptId: event.attemptId,
          },
          { type: 'ReleaseProjectLock', taskId: snapshot.taskId },
        ],
      );

    case 'MASTER_REJECTED':
      if (snapshot.state !== 'master_validation') return illegal(snapshot, event);
      if (snapshot.activeAttemptId !== event.attemptId) {
        return illegal(snapshot, event, 'Master result does not match activeAttemptId');
      }
      if (snapshot.reworkCount >= snapshot.maxReworks) {
        const reason = `Automatic rework limit reached (${snapshot.maxReworks} reworks)`;
        if (snapshot.pauseAfterAttempt) {
          return moved(snapshot, event, 'paused_after_run', {
            ...CLEAR_ACTIVE_ATTEMPT,
            pauseAfterAttempt: false,
            resumeTargetState: 'awaiting_user',
            awaitingReason: reason,
            allowedAwaitingActions: ['cancel'],
          });
        }
        return waitingForUser(
          snapshot,
          event,
          reason,
          ['cancel'],
        );
      }
      {
        const reworkRequest = {
          reason: event.reason,
          nextReworkNumber: snapshot.reworkCount + 1,
        };
        const reworkEffect: WorkflowEffect = {
          type: 'PersistReworkRequest',
          taskId: snapshot.taskId,
          ...reworkRequest,
        };
        if (snapshot.pauseAfterAttempt) {
          return moved(
            snapshot,
            event,
            'paused_after_run',
            {
              ...CLEAR_ACTIVE_ATTEMPT,
              pauseAfterAttempt: false,
              resumeTargetState: 'rework_requested',
              reworkRequest: { ...reworkRequest, status: 'deferred' },
            },
          );
        }
        return moved(
          snapshot,
          event,
          'rework_requested',
          {
            ...CLEAR_ACTIVE_ATTEMPT,
            reworkRequest: { ...reworkRequest, status: 'pending' },
          },
          [reworkEffect],
        );
      }

    case 'MASTER_FAILED':
      if (snapshot.state !== 'master_validation') return illegal(snapshot, event);
      if (snapshot.activeAttemptId !== event.attemptId) {
        return illegal(snapshot, event, 'Master failure does not match activeAttemptId');
      }
      return waitingForUser(
        snapshot,
        event,
        event.reason,
        ['continue', 'cancel'],
        'master_validation',
      );

    case 'RESULT_PARSE_FAILED':
      if (
        snapshot.state !== 'planning' &&
        snapshot.state !== 'implementing' &&
        snapshot.state !== 'reviewing' &&
        snapshot.state !== 'master_validation'
      ) {
        return illegal(snapshot, event);
      }
      if (snapshot.activeAttemptId !== event.attemptId) {
        return illegal(
          snapshot,
          event,
          'Parse failure does not match activeAttemptId',
        );
      }
      return waitingForUser(
        snapshot,
        event,
        event.reason,
        ['continue', 'cancel'],
        snapshot.state,
      );

    case 'REWORK_CONTEXT_PERSISTED':
      if (snapshot.state !== 'rework_requested') return illegal(snapshot, event);
      if (snapshot.reworkRequest?.status !== 'pending') {
        return illegal(snapshot, event, 'Rework request is not pending persistence');
      }
      if (snapshot.reworkCount >= snapshot.maxReworks) {
        return illegal(snapshot, event, 'Rework limit has already been reached');
      }
      return moved(
        snapshot,
        event,
        'implementing',
        {
          ...activeAttemptContext('implementing', event.attemptId, event.baselineId),
          reworkCount: snapshot.reworkCount + 1,
          reworkRequest: undefined,
        },
        attemptEffects(snapshot, event.attemptId, event.baselineId),
      );

    case 'PAUSE_AFTER_ATTEMPT_REQUESTED':
      if (
        snapshot.state !== 'planning' &&
        snapshot.state !== 'implementing' &&
        snapshot.state !== 'reviewing' &&
        snapshot.state !== 'master_validation'
      ) {
        return illegal(snapshot, event);
      }
      return moved(snapshot, event, snapshot.state, { pauseAfterAttempt: true });

    case 'RESUME': {
      if (snapshot.state !== 'paused_after_run') return illegal(snapshot, event);
      const targetState = snapshot.resumeTargetState;
      if (targetState === undefined) {
        return illegal(snapshot, event, 'Paused workflow has no resumeTargetState');
      }
      switch (targetState) {
        case 'awaiting_plan_approval':
          return moved(snapshot, event, targetState, { pauseAfterAttempt: false });
        case 'rework_requested': {
          const reworkRequest = snapshot.reworkRequest;
          if (reworkRequest?.status !== 'deferred') {
            return illegal(snapshot, event, 'Paused workflow has no deferred rework');
          }
          return moved(
            snapshot,
            event,
            'rework_requested',
            {
              pauseAfterAttempt: false,
              reworkRequest: { ...reworkRequest, status: 'pending' },
            },
            [
              {
                type: 'PersistReworkRequest',
                taskId: snapshot.taskId,
                reason: reworkRequest.reason,
                nextReworkNumber: reworkRequest.nextReworkNumber,
              },
            ],
          );
        }
        case 'planning':
        case 'implementing':
        case 'reviewing':
        case 'master_validation': {
          const pendingAttempt = snapshot.pendingResumeAttempt;
          if (pendingAttempt === undefined) {
            return illegal(
              snapshot,
              event,
              `Paused ${targetState} has no pending attempt baseline`,
            );
          }
          return moved(
            snapshot,
            event,
            targetState,
            {
              ...activeAttemptContext(
                targetState,
                pendingAttempt.attemptId,
                pendingAttempt.baselineId,
              ),
              pauseAfterAttempt: false,
            },
            effectsForNewAttempt(
              snapshot,
              targetState,
              pendingAttempt.attemptId,
              pendingAttempt.baselineId,
            ),
          );
        }
        case 'awaiting_user':
          return moved(snapshot, event, 'awaiting_user', {
            pauseAfterAttempt: false,
            awaitingReason: snapshot.awaitingReason,
            allowedAwaitingActions: snapshot.allowedAwaitingActions,
            resumeTargetState: snapshot.awaitingResumeTargetState,
          });
        case 'interrupted_needs_inspection':
          return moved(snapshot, event, 'interrupted_needs_inspection', {
            pauseAfterAttempt: false,
            resumeTargetState: snapshot.inspectionResumeTargetState,
          });
        case 'completed':
          return moved(
            snapshot,
            event,
            'completed',
            { pauseAfterAttempt: false },
            [{ type: 'ReleaseProjectLock', taskId: snapshot.taskId }],
          );
        default:
          return assertNever(targetState);
      }
    }

    case 'CANCEL':
      return cancel(snapshot, event);

    case 'INTERRUPT':
      if (snapshot.activeAttemptId === undefined) {
        return illegal(snapshot, event, 'No active attempt can be interrupted');
      }
      if (
        snapshot.state !== 'planning' &&
        snapshot.state !== 'implementing' &&
        snapshot.state !== 'reviewing' &&
        snapshot.state !== 'master_validation'
      ) {
        return illegal(snapshot, event, 'Active state has no safe inspection target');
      }
      return moved(
        snapshot,
        event,
        'interrupting',
        { stopIntent: 'interrupt', resumeTargetState: snapshot.state },
        [
          {
            type: 'BeginProcessCleanup',
            taskId: snapshot.taskId,
            attemptId: snapshot.activeAttemptId,
            stopIntent: 'interrupt',
          },
        ],
      );

    case 'PROCESS_TREE_CLEAN':
      if (snapshot.state !== 'interrupting' || snapshot.stopIntent === undefined) {
        return illegal(snapshot, event);
      }
      if (snapshot.stopIntent === 'cancel') {
        return moved(snapshot, event, 'cancelled', { ...CLEAR_ACTIVE_ATTEMPT }, [
          { type: 'ReleaseProjectLock', taskId: snapshot.taskId },
        ]);
      }
      return moved(snapshot, event, 'interrupted_needs_inspection', {
        ...CLEAR_ACTIVE_ATTEMPT,
        awaitingReason: 'Interrupted attempt requires file inspection',
        resumeTargetState: snapshot.resumeTargetState,
      });

    case 'PROCESS_CLEANUP_FAILED':
      if (snapshot.state !== 'interrupting') return illegal(snapshot, event);
      return moved(snapshot, event, 'cleanup_failed', {
        activeAttemptId: snapshot.activeAttemptId,
        activeAttemptBaselineId: snapshot.activeAttemptBaselineId,
        activeAttemptRole: snapshot.activeAttemptRole,
        stopIntent: snapshot.stopIntent,
        awaitingReason: event.reason,
        resumeTargetState: snapshot.resumeTargetState,
      });

    case 'RETRY_CLEANUP':
      if (
        snapshot.state !== 'cleanup_failed' ||
        snapshot.activeAttemptId === undefined ||
        snapshot.stopIntent === undefined
      ) {
        return illegal(snapshot, event);
      }
      return moved(
        snapshot,
        event,
        'interrupting',
        {
          stopIntent: snapshot.stopIntent,
          resumeTargetState: snapshot.resumeTargetState,
        },
        [
          {
            type: 'BeginProcessCleanup',
            taskId: snapshot.taskId,
            attemptId: snapshot.activeAttemptId,
            stopIntent: snapshot.stopIntent,
          },
        ],
      );

    case 'INSPECTION_CONTINUE': {
      if (snapshot.state !== 'interrupted_needs_inspection') {
        return illegal(snapshot, event);
      }
      const targetState = snapshot.resumeTargetState;
      if (targetState === undefined || !isSafeExecutionState(targetState)) {
        return illegal(snapshot, event, 'Inspection has no safe resume target');
      }
      const effects = effectsForNewAttempt(
        snapshot,
        targetState,
        event.attemptId,
        event.baselineId,
      );
      if (effects === undefined) return illegal(snapshot, event);
      return moved(
        snapshot,
        event,
        targetState,
        activeAttemptContext(targetState, event.attemptId, event.baselineId),
        effects,
      );
    }

    case 'INSPECTION_VIEW':
      if (snapshot.state !== 'interrupted_needs_inspection') {
        return illegal(snapshot, event);
      }
      return waitingForUser(
        snapshot,
        event,
        'Inspection view requested; explicit continue or cancel is required',
        ['continue', 'cancel'],
        snapshot.resumeTargetState,
      );

    case 'INSPECTION_CANCEL':
      if (snapshot.state !== 'interrupted_needs_inspection') {
        return illegal(snapshot, event);
      }
      return moved(snapshot, event, 'cancelled', {}, [
        { type: 'ReleaseProjectLock', taskId: snapshot.taskId },
      ]);

    case 'AWAITING_USER_RETRY_ENVIRONMENT':
      if (
        snapshot.state !== 'awaiting_user' ||
        !snapshot.allowedAwaitingActions?.includes('retry_environment')
      ) {
        return illegal(snapshot, event);
      }
      return moved(snapshot, event, 'checking_environment', {}, [
        { type: 'AcquireProjectLock', taskId: snapshot.taskId },
        { type: 'RunEnvironmentCheck', taskId: snapshot.taskId },
      ]);

    case 'AWAITING_USER_CONTINUE': {
      if (
        snapshot.state !== 'awaiting_user' ||
        !snapshot.allowedAwaitingActions?.includes('continue')
      ) {
        return illegal(snapshot, event);
      }
      const targetState = snapshot.resumeTargetState;
      if (targetState === undefined || !isSafeExecutionState(targetState)) {
        return illegal(snapshot, event, 'Awaiting workflow has no safe resume target');
      }
      if (event.attemptId === undefined || event.baselineId === undefined) {
        return illegal(
          snapshot,
          event,
          'Continuing implementation requires a new attempt and baseline',
        );
      }
      const effects = effectsForNewAttempt(
        snapshot,
        targetState,
        event.attemptId,
        event.baselineId,
      );
      if (effects === undefined) return illegal(snapshot, event);
      return moved(
        snapshot,
        event,
        targetState,
        activeAttemptContext(targetState, event.attemptId, event.baselineId),
        effects,
      );
    }

    case 'AWAITING_USER_CANCEL':
      return snapshot.state === 'awaiting_user' &&
        snapshot.allowedAwaitingActions?.includes('cancel')
        ? cancel(snapshot, event)
        : illegal(snapshot, event);

    case 'FATAL_ERROR':
      if (snapshot.activeAttemptId !== undefined) {
        return illegal(
          snapshot,
          event,
          'An active process must be cleaned before entering failed',
        );
      }
      return moved(
        snapshot,
        event,
        'failed',
        { awaitingReason: event.reason },
        [{ type: 'ReleaseProjectLock', taskId: snapshot.taskId }],
      );

    default:
      return assertNever(event);
  }
}
