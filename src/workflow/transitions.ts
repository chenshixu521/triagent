import type {
  AttemptId,
  BaselineId,
  TaskId,
} from '../domain/ids.js';
import type { RequirementVersion } from '../domain/task.js';
import type { StopIntent, WorkflowState } from './states.js';

export const WORKFLOW_EVENT_TYPES = [
  'START',
  'ENVIRONMENT_READY',
  'ENVIRONMENT_FAILED',
  'PLAN_READY',
  'PLAN_FAILED',
  'PLAN_APPROVED',
  'PLAN_REVISION_REQUESTED',
  'IMPLEMENTATION_COMPLETED',
  'IMPLEMENTATION_FAILED',
  'REVIEW_COMPLETED',
  'REVIEW_INVALIDATED',
  'REVIEW_FAILED',
  'REVIEW_REWORK_REQUESTED',
  'MASTER_APPROVED',
  'MASTER_REJECTED',
  'MASTER_FAILED',
  'RESULT_PARSE_FAILED',
  'REWORK_CONTEXT_PERSISTED',
  'PAUSE_AFTER_ATTEMPT_REQUESTED',
  'RESUME',
  'CANCEL',
  'INTERRUPT',
  'PROCESS_TREE_CLEAN',
  'PROCESS_CLEANUP_FAILED',
  'RETRY_CLEANUP',
  'INSPECTION_CONTINUE',
  'INSPECTION_VIEW',
  'INSPECTION_CANCEL',
  'AWAITING_USER_RETRY_ENVIRONMENT',
  'AWAITING_USER_CONTINUE',
  'AWAITING_USER_CANCEL',
  'FATAL_ERROR',
] as const;

export type WorkflowEvent =
  | { readonly type: 'START' }
  | {
      readonly type: 'ENVIRONMENT_READY';
      readonly attemptId: AttemptId;
      readonly baselineId: BaselineId;
    }
  | { readonly type: 'ENVIRONMENT_FAILED'; readonly reason: string }
  | {
      readonly type: 'PLAN_READY';
      readonly requiresApproval: true;
      readonly attemptId: AttemptId;
    }
  | {
      readonly type: 'PLAN_READY';
      readonly requiresApproval: false;
      readonly attemptId: AttemptId;
      readonly implementationAttemptId: AttemptId;
      readonly implementationBaselineId: BaselineId;
    }
  | {
      readonly type: 'PLAN_FAILED';
      readonly attemptId: AttemptId;
      readonly reason: string;
    }
  | {
      readonly type: 'PLAN_APPROVED';
      readonly attemptId: AttemptId;
      readonly baselineId: BaselineId;
    }
  | {
      readonly type: 'PLAN_REVISION_REQUESTED';
      readonly attemptId: AttemptId;
      readonly baselineId: BaselineId;
      readonly reason?: string;
    }
  | {
      readonly type: 'IMPLEMENTATION_COMPLETED';
      readonly attemptId: AttemptId;
      readonly reviewAttemptId: AttemptId;
      readonly reviewBaselineId: BaselineId;
    }
  | {
      readonly type: 'IMPLEMENTATION_FAILED';
      readonly attemptId: AttemptId;
      readonly reason: string;
    }
  | {
      readonly type: 'REVIEW_COMPLETED';
      readonly attemptId: AttemptId;
      readonly masterAttemptId: AttemptId;
      readonly masterBaselineId: BaselineId;
    }
  | {
      readonly type: 'REVIEW_INVALIDATED';
      readonly attemptId: AttemptId;
      readonly reason: string;
    }
  | {
      readonly type: 'REVIEW_FAILED';
      readonly attemptId: AttemptId;
      readonly reason: string;
    }
  | {
      readonly type: 'REVIEW_REWORK_REQUESTED';
      readonly attemptId: AttemptId;
      readonly reason: string;
    }
  | { readonly type: 'MASTER_APPROVED'; readonly attemptId: AttemptId }
  | {
      readonly type: 'MASTER_REJECTED';
      readonly attemptId: AttemptId;
      readonly reason: string;
    }
  | {
      readonly type: 'MASTER_FAILED';
      readonly attemptId: AttemptId;
      readonly reason: string;
    }
  | {
      readonly type: 'RESULT_PARSE_FAILED';
      readonly attemptId: AttemptId;
      readonly reason: string;
    }
  | {
      readonly type: 'REWORK_CONTEXT_PERSISTED';
      readonly attemptId: AttemptId;
      readonly baselineId: BaselineId;
    }
  | { readonly type: 'PAUSE_AFTER_ATTEMPT_REQUESTED' }
  | { readonly type: 'RESUME' }
  | { readonly type: 'CANCEL' }
  | { readonly type: 'INTERRUPT' }
  | { readonly type: 'PROCESS_TREE_CLEAN' }
  | { readonly type: 'PROCESS_CLEANUP_FAILED'; readonly reason: string }
  | { readonly type: 'RETRY_CLEANUP' }
  | {
      readonly type: 'INSPECTION_CONTINUE';
      readonly attemptId: AttemptId;
      readonly baselineId: BaselineId;
    }
  | { readonly type: 'INSPECTION_VIEW' }
  | { readonly type: 'INSPECTION_CANCEL' }
  | { readonly type: 'AWAITING_USER_RETRY_ENVIRONMENT' }
  | {
      readonly type: 'AWAITING_USER_CONTINUE';
      readonly attemptId?: AttemptId;
      readonly baselineId?: BaselineId;
    }
  | { readonly type: 'AWAITING_USER_CANCEL' }
  | { readonly type: 'FATAL_ERROR'; readonly reason: string };

export type WorkflowEffect =
  | { readonly type: 'AcquireProjectLock'; readonly taskId: TaskId }
  | { readonly type: 'RunEnvironmentCheck'; readonly taskId: TaskId }
  | {
      readonly type: 'StartPlanning';
      readonly taskId: TaskId;
      readonly attemptId: AttemptId;
      readonly baselineId: BaselineId;
      readonly requirementVersion: RequirementVersion;
      readonly role: 'master';
    }
  | {
      readonly type: 'CreateAttemptBaseline';
      readonly taskId: TaskId;
      readonly attemptId: AttemptId;
      readonly baselineId: BaselineId;
      readonly requirementVersion: RequirementVersion;
    }
  | {
      readonly type: 'StartImplementation';
      readonly taskId: TaskId;
      readonly attemptId: AttemptId;
      readonly baselineId: BaselineId;
      readonly requirementVersion: RequirementVersion;
      readonly role: 'implementer';
    }
  | {
      readonly type: 'PrepareImplementationWorkspace';
      readonly taskId: TaskId;
      readonly attemptId: AttemptId;
      readonly baselineId: BaselineId;
      readonly requirementVersion: RequirementVersion;
    }
  | {
      readonly type: 'FinalizeCandidateChangeSet';
      readonly taskId: TaskId;
      readonly attemptId: AttemptId;
      readonly baselineId: BaselineId;
    }
  | {
      readonly type: 'StartReview';
      readonly taskId: TaskId;
      readonly attemptId: AttemptId;
      readonly baselineId: BaselineId;
      readonly requirementVersion: RequirementVersion;
      readonly role: 'reviewer';
    }
  | {
      readonly type: 'StartMasterValidation';
      readonly taskId: TaskId;
      readonly attemptId: AttemptId;
      readonly baselineId: BaselineId;
      readonly requirementVersion: RequirementVersion;
      readonly role: 'master';
    }
  | {
      readonly type: 'PromoteCandidateWorkspace';
      readonly taskId: TaskId;
      readonly attemptId: AttemptId;
    }
  | {
      readonly type: 'PersistReworkRequest';
      readonly taskId: TaskId;
      readonly reason: string;
      readonly nextReworkNumber: number;
    }
  | {
      readonly type: 'BeginProcessCleanup';
      readonly taskId: TaskId;
      readonly attemptId: AttemptId;
      readonly stopIntent: StopIntent;
    }
  | { readonly type: 'ReleaseProjectLock'; readonly taskId: TaskId }
  | {
      readonly type: 'PersistTransition';
      readonly taskId: TaskId;
      readonly from: WorkflowState;
      readonly to: WorkflowState;
      readonly event: WorkflowEvent['type'];
    };

export type PendingActionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed';

export interface PendingAction<Effect extends WorkflowEffect = WorkflowEffect> {
  readonly idempotencyKey: string;
  readonly effect: Effect;
  readonly status: PendingActionStatus;
}
