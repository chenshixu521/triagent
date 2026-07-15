import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { AgentAdapter, AgentRequest } from '../agents/agent-adapter.js';
import type { BudgetController } from '../budget/budget-controller.js';
import {
  asAttemptId,
  asBaselineId,
  type AttemptId,
  type BaselineId,
  type ConversationId,
  type TaskId,
} from '../domain/ids.js';
import { createPendingRunAttempt } from '../domain/attempt.js';
import type { AgentRole, TaskDefinition } from '../domain/task.js';
import type { JsonlLog } from '../logging/jsonl-log.js';
import { ActionRepository } from '../persistence/action-repository.js';
import type { AgentSessionRepository } from '../persistence/agent-session-repository.js';
import { AttemptRepository } from '../persistence/attempt-repository.js';
import type { ReadWriteDatabase } from '../persistence/database.js';
import { serializeJsonValue } from '../persistence/json-value.js';
import { TaskRepository, type PersistedTask } from '../persistence/task-repository.js';
import { withTransaction } from '../persistence/transaction.js';
import { canonicalizeProjectPath } from '../project/canonical-path.js';
import { ProjectLockService } from '../project/project-lock-service.js';
import {
  parseAgentResult,
  type AgentResultParseOutcome,
} from '../protocol/result-parser.js';
import type { AgentResult } from '../protocol/result-schema.js';
import type { ChangeSet } from '../tracking/diff-service.js';
import { DiffService } from '../tracking/diff-service.js';
import { sha256 } from '../tracking/hash.js';
import type {
  BaselineTrackerPort,
  TrackingBaselineManifest,
} from '../tracking/tracking-port.js';
import {
  buildImmutableReviewBundleFromCandidateChangeSet,
  classifyCandidateReviewResult,
  type ImmutableReviewBundle,
} from '../protocol/review-bundle.js';
import { PatchApplier } from '../guard/patch-applier.js';
import { ProjectGuard } from '../guard/project-guard.js';
import type { WorkspaceCandidateChangeSet } from '../workspace/implementation-workspace-types.js';
import { ImplementationWorkspaceRepository } from '../workspace/implementation-workspace-repository.js';
import { ImplementationWorkspaceService } from '../workspace/implementation-workspace-service.js';
import {
  buildWorkspaceCandidateChangeSet,
  type WorkspaceFileSnapshot,
} from '../workspace/workspace-change-set.js';
import {
  hashCanonicalManifest,
  WorkspacePromotionService,
  type CanonicalFileFingerprint,
} from '../workspace/workspace-promotion-service.js';
import type { ProcessSupervisorPort } from '../process/process-supervisor-port.js';
import {
  CommandRunner,
  type AgentLaunchPreparer,
  type CommandRunnerHooks,
  type PersistedAgentRun,
} from './command-runner.js';
import {
  createInitialWorkflow,
  transition,
  type Transitioned,
} from './workflow-engine.js';
import {
  isSafeExecutionState,
  isTerminalState,
  type SafeExecutionState,
  type WorkflowSnapshot,
} from './states.js';
import type { WorkflowEffect, WorkflowEvent } from './transitions.js';

export type ProcessTreeVerification =
  | { readonly clean: true }
  | { readonly clean: false; readonly reason: string };

function isUnsupervisedAttemptError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not supervised|unknown attempt|no active|not found/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export type OrchestratorIdKind =
  | 'action'
  | 'attempt'
  | 'baseline'
  | 'task-baseline'
  | 'change-set'
  | 'review';

export interface TaskOrchestratorHooks {
  readonly commandRunner?: CommandRunnerHooks;
  readonly afterReadyEventPersisted?: (context: {
    readonly actionId: string;
    readonly attemptId: AttemptId;
    readonly event: WorkflowEvent;
  }) => void | Promise<void>;
}

export interface TaskOrchestratorOptions {
  readonly database: ReadWriteDatabase;
  readonly taskDefinition: TaskDefinition;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly requirements: string;
  readonly tracker: BaselineTrackerPort;
  readonly adapters: Readonly<Record<AgentRole, AgentAdapter>>;
  readonly log: JsonlLog;
  readonly ownerInstanceId: string;
  readonly leaseDurationMs?: number;
  readonly requiresPlanApproval?: boolean;
  readonly idFactory?: (kind: OrchestratorIdKind) => string;
  readonly now?: () => Date;
  readonly hooks?: TaskOrchestratorHooks;
  /** Optional Task 10 budget controller; gates Adapter launches when provided. */
  readonly budget?: BudgetController;
  /** Optional Task 13 two-phase gate used by real Adapter runtimes. */
  readonly launchPreparer?: AgentLaunchPreparer;
  /**
   * App-owned root for isolated implementation workspaces. Required when the
   * implementer adapter is Grok; ignored for live-project implementers.
   */
  readonly implementationWorkspacesDirectory?: string;
  /**
   * Optional operator mid-run context (queued user messages) injected into
   * every subsequent stage prompt. Read at prompt-build time.
   */
  readonly getOperatorContext?: () => readonly string[];
  /**
   * Store-backed agent sessions for implementer conversation-id resume (MVP).
   */
  readonly agentSessions?: AgentSessionRepository;
  /**
   * Process supervisor used by BeginProcessCleanup (INTERRUPT / CANCEL with
   * an active attempt). Optional for pure offline fixtures that never interrupt.
   */
  readonly processSupervisor?: ProcessSupervisorPort;
  /** Grace window after cooperative stop before force (ms). Default 0. */
  readonly cleanupGracePeriodMs?: number;
  /**
   * Test seam: advance a fake clock so FakeProcessSupervisor cleanup plans settle.
   */
  readonly advanceCleanupClock?: (milliseconds: number) => void;
  /**
   * Optional fail-closed tree verification after force stop.
   * When omitted, cleanup treats successful force (or unsupervised) as clean.
   */
  readonly verifyProcessTreeGone?: (
    attemptId: AttemptId,
  ) => ProcessTreeVerification | Promise<ProcessTreeVerification>;
}

interface PreparedEffect {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly actionType: string;
  readonly effect: Exclude<WorkflowEffect, { readonly type: 'PersistTransition' }>;
  readonly reservedAttemptId?: AttemptId;
  readonly reservedBaselineId?: BaselineId;
}

export interface PreparedWorkflowEffectIntent {
  readonly actionId: string;
  readonly idempotencyKey: string;
  readonly actionType: string;
  readonly effect: Exclude<WorkflowEffect, { readonly type: 'PersistTransition' }>;
}

type StartEffect = Extract<
  WorkflowEffect,
  {
    readonly type:
      | 'StartPlanning'
      | 'StartImplementation'
      | 'StartReview'
      | 'StartMasterValidation';
  }
>;

export type StagePromptStage =
  | 'planning'
  | 'implementation'
  | 'review'
  | 'master_validation';

export interface StagePromptInput {
  readonly stage: StagePromptStage;
  readonly role: AgentRole;
  readonly attemptId: string;
  readonly requirementVersion: number;
  readonly projectRoot: string;
  readonly requirements: string;
}

/**
 * Stage-specific instructions keep a read-only master from interpreting the
 * user requirement as its own implementation assignment.
 */
export function buildStagePrompt(input: StagePromptInput): string {
  const stageInstructions: readonly string[] = (() => {
    switch (input.stage) {
      case 'planning':
        return [
          'You are the master planner. Do not modify project files or attempt implementation.',
          'Inspect only as needed, then provide a concise executable plan for the implementer.',
          'When the requirements are clear, return status "completed" and nextAction "implement".',
          'For this planning stage, changedFiles must be [], commandsRun must list only any read-only inspection commands, and issues must be [].',
        ];
      case 'implementation':
        return [
          'You are the implementer. Make only the changes required by the requirements, then verify them.',
          'When implementation and verification succeed, return status "completed" and nextAction "review".',
        ];
      case 'review':
        return [
          'You are the independent reviewer. Do not modify project files.',
          'Inspect the implementation and its derived evidence. When it passes, return status "completed" and nextAction "master_validation".',
          'If it does not pass, return the appropriate issues and nextAction "rework".',
        ];
      case 'master_validation':
        return [
          'You are the master validator. Do not modify project files.',
          'Validate the final implementation and review evidence against the inspection root given in the launch context (candidate workspace when isolated).',
          'Do not reject solely because the canonical project is still unchanged before promotion.',
          'When the inspected implementation satisfies the requirements, return status "completed" and nextAction "complete".',
          'If it needs changes, return the appropriate issues and nextAction "rework".',
        ];
    }
  })();
  return [
    `Stage: ${input.stage}`,
    `Role: ${input.role}`,
    `Attempt: ${input.attemptId}`,
    `Requirement version: ${String(input.requirementVersion)}`,
    `Project: ${input.projectRoot}`,
    `Requirements: ${input.requirements}`,
    ...stageInstructions,
    'Return only a result matching schemas/agent-result.schema.json.',
  ].join('\n');
}

interface DerivedEvidence {
  readonly changeSetId: string;
  readonly baselineId: BaselineId;
  readonly changedFiles: readonly string[];
  readonly commandRecords: readonly PersistedAgentRun['commandRecord'][];
  readonly logReferences: PersistedAgentRun['logReferences'];
  readonly actionReferences: readonly {
    readonly actionId: string;
    readonly attemptId: AttemptId;
  }[];
}

interface FormatRepairEvidence {
  readonly originalAttemptId: AttemptId;
  readonly attemptId: AttemptId;
  readonly baselineId: BaselineId;
  readonly firstFailure: string;
  readonly run: PersistedAgentRun;
}

interface ConsumedActionResult {
  readonly actionId: string;
  readonly attemptId: AttemptId;
  readonly relatedActions?: readonly {
    readonly actionId: string;
    readonly attemptId: AttemptId;
  }[];
}

function effectActionType(effect: PreparedEffect['effect']): string {
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

function effectAttemptId(effect: PreparedEffect['effect']): AttemptId | null {
  return 'attemptId' in effect ? effect.attemptId : null;
}

function eventAttemptId(event: WorkflowEvent): AttemptId | null {
  return 'attemptId' in event ? event.attemptId ?? null : null;
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

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((entry, index) => entry === normalizedRight[index]);
}

function reviewReason(result: AgentResult): string {
  if (result.issues.length === 0) return result.summary;
  return result.issues.map((issue) => issue.message).join('; ');
}

export class TaskOrchestrator {
  readonly #database: ReadWriteDatabase;
  readonly #tasks: TaskRepository;
  readonly #actions: ActionRepository;
  readonly #attempts: AttemptRepository;
  readonly #lockService: ProjectLockService;
  readonly #commandRunner: CommandRunner;
  readonly #diff: DiffService;
  readonly #taskDefinition: TaskDefinition;
  readonly #projectId: string;
  readonly #projectRoot: string;
  readonly #requirements: string;
  readonly #tracker: BaselineTrackerPort;
  readonly #adapters: Readonly<Record<AgentRole, AgentAdapter>>;
  readonly #ownerInstanceId: string;
  readonly #leaseDurationMs: number;
  readonly #requiresPlanApproval: boolean;
  readonly #idFactory: (kind: OrchestratorIdKind) => string;
  readonly #now: () => Date;
  readonly #hooks: TaskOrchestratorHooks;
  readonly #implementationWorkspacesDirectory: string | undefined;
  readonly #getOperatorContext: (() => readonly string[]) | undefined;
  readonly #agentSessions: AgentSessionRepository | undefined;
  readonly #processSupervisor: ProcessSupervisorPort | undefined;
  readonly #cleanupGracePeriodMs: number;
  readonly #advanceCleanupClock: ((milliseconds: number) => void) | undefined;
  readonly #verifyProcessTreeGone:
    | ((
        attemptId: AttemptId,
      ) => ProcessTreeVerification | Promise<ProcessTreeVerification>)
    | undefined;
  readonly #workspaces: ImplementationWorkspaceRepository;
  #taskBaselineId?: string;
  #lockId?: string;
  #planAttemptId?: AttemptId;
  /** Latest isolated workspace authorization issued for the implementer attempt. */
  #activeWorkspaceAuthorization?: {
    readonly workspaceId: string;
    readonly authorizationId: string;
    readonly sourceManifestHash: string;
    readonly executionRoot: string;
    readonly attemptId: string;
  };
  /** Last finalized candidate change-set + immutable review bundle (isolated path). */
  #lastCandidateEvidence?: {
    readonly changeSet: WorkspaceCandidateChangeSet;
    readonly reviewBundle: ImmutableReviewBundle;
    readonly candidateRoot: string;
    readonly candidateManifestHash: string;
  };

  public constructor(options: TaskOrchestratorOptions) {
    if (options.projectId.trim() === '' || options.requirements.trim() === '') {
      throw new Error('projectId and requirements must be non-empty');
    }
    if (options.ownerInstanceId.trim() === '') {
      throw new Error('ownerInstanceId must be non-empty');
    }
    if (options.tracker.projectRoot !== options.projectRoot) {
      throw new Error('tracker project root does not match orchestrator project root');
    }
    this.#database = options.database;
    this.#tasks = new TaskRepository(options.database.connection);
    this.#actions = new ActionRepository(options.database.connection);
    this.#attempts = new AttemptRepository(options.database.connection);
    this.#lockService = new ProjectLockService(options.database);
    this.#workspaces = new ImplementationWorkspaceRepository(options.database.connection);
    this.#commandRunner = new CommandRunner({
      database: options.database,
      log: options.log,
      hooks: options.hooks?.commandRunner,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.launchPreparer === undefined
        ? {}
        : { launchPreparer: options.launchPreparer }),
    });
    this.#diff = new DiffService(options.tracker);
    this.#taskDefinition = options.taskDefinition;
    this.#projectId = options.projectId;
    this.#projectRoot = options.projectRoot;
    this.#requirements = options.requirements;
    this.#tracker = options.tracker;
    this.#adapters = options.adapters;
    this.#implementationWorkspacesDirectory =
      options.implementationWorkspacesDirectory === undefined
        ? undefined
        : resolve(options.implementationWorkspacesDirectory);
    this.#ownerInstanceId = options.ownerInstanceId;
    this.#leaseDurationMs = options.leaseDurationMs ?? 60_000;
    this.#requiresPlanApproval = options.requiresPlanApproval ?? true;
    this.#idFactory = options.idFactory ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
    this.#hooks = options.hooks ?? {};
    this.#getOperatorContext = options.getOperatorContext;
    this.#agentSessions = options.agentSessions;
    this.#processSupervisor = options.processSupervisor;
    this.#cleanupGracePeriodMs = options.cleanupGracePeriodMs ?? 0;
    this.#advanceCleanupClock = options.advanceCleanupClock;
    this.#verifyProcessTreeGone = options.verifyProcessTreeGone;
  }

  public initialize(): void {
    const { taskId, requirementVersion, roles } = this.#taskDefinition;
    if (requirementVersion !== 1) {
      throw new Error('new TaskOrchestrator tasks must start at requirement version 1');
    }
    if (
      this.#adapters.master.kind !== roles.master
      || this.#adapters.implementer.kind !== roles.implementer
      || this.#adapters.reviewer.kind !== roles.reviewer
    ) {
      throw new Error('adapter assignments do not match the task definition');
    }
    const projectId = this.#tasks.createProject({
      projectId: this.#projectId,
      rootPath: this.#projectRoot,
    });
    this.#tasks.create({
      taskId,
      projectId,
      workflowSnapshot: createInitialWorkflow(taskId),
      workflowVersion: 1,
      status: 'draft',
    });
    this.#database.connection
      .prepare(
        `INSERT INTO requirement_versions(task_id, version, requirements, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        taskId,
        requirementVersion,
        serializeJsonValue({
          requirements: this.#requirements,
          roles,
          planVersion: requirementVersion,
          approved: false,
        }),
        this.#now().toISOString(),
      );
  }

  public currentTask(): PersistedTask {
    const task = this.#tasks.get(this.#taskDefinition.taskId);
    if (task === undefined) throw new Error('task is not initialized');
    return task;
  }

  public async start(): Promise<WorkflowSnapshot> {
    if (this.currentTask().status !== 'draft') {
      throw new Error('start is only valid for a draft task');
    }
    return this.#applyEvent({ type: 'START' });
  }

  public async approvePlan(): Promise<WorkflowSnapshot> {
    const current = this.currentTask();
    if (current.status !== 'awaiting_plan_approval') {
      throw new Error('plan approval is only valid while awaiting approval');
    }
    const attemptId = this.#nextAttemptId();
    const baselineId = this.#nextBaselineId();
    this.#persistPlanApproval(attemptId);
    return this.#applyEvent({ type: 'PLAN_APPROVED', attemptId, baselineId });
  }

  /**
   * Workflow-level interrupt: transitions to interrupting, runs
   * BeginProcessCleanup, then interrupted_needs_inspection (or cleanup_failed).
   */
  public async requestInterrupt(): Promise<WorkflowSnapshot> {
    const task = this.currentTask();
    if (task.workflowSnapshot.activeAttemptId === undefined) {
      throw new Error('interrupt requires an active attempt');
    }
    if (!isSafeExecutionState(task.status as SafeExecutionState)) {
      throw new Error(
        `interrupt is not valid while workflow is ${task.status}`,
      );
    }
    return this.#applyEvent({ type: 'INTERRUPT' });
  }

  /**
   * Same-task operator continue after mid-run interrupt ([Q] hold → [C]).
   * Never creates a new taskId. Settles a killed stage when needed, then
   * re-drives the resume target (enabling implementer conversation resume).
   */
  public async continueAfterOperatorHold(): Promise<WorkflowSnapshot> {
    let task = this.currentTask();
    if (isTerminalState(task.status)) {
      throw new Error(
        `cannot continue a terminal task in state ${task.status}`,
      );
    }

    // Mid-flight after process stop: settle the active stage as operator interrupt.
    if (
      isSafeExecutionState(task.status as SafeExecutionState)
      && task.workflowSnapshot.activeAttemptId !== undefined
    ) {
      const attemptId = asAttemptId(task.workflowSnapshot.activeAttemptId);
      const settleEvent = this.#operatorInterruptSettleEvent(
        task.status as SafeExecutionState,
        attemptId,
      );
      try {
        await this.#applyEvent(settleEvent);
      } catch (error) {
        // Concurrent drive may already have settled this attempt.
        const message = error instanceof Error ? error.message : String(error);
        if (!/rejected|does not match|illegal|Terminal/i.test(message)) {
          throw error;
        }
      }
      task = this.currentTask();
    }

    if (task.status === 'draft') {
      return this.start();
    }
    if (task.status === 'awaiting_plan_approval') {
      return task.workflowSnapshot;
    }
    if (task.status === 'paused_after_run') {
      return this.#applyEvent({ type: 'RESUME' });
    }
    if (task.status === 'checking_environment') {
      // Soft retry: re-enter environment check via awaiting-user retry is not
      // available here; START is invalid. Surface for operator cancel/recreate.
      throw new Error(
        'cannot continue while still checking environment — cancel and recreate if stuck',
      );
    }
    if (
      task.status === 'awaiting_user'
      && task.workflowSnapshot.allowedAwaitingActions?.includes('continue')
    ) {
      const attemptId = this.#nextAttemptId();
      const baselineId = this.#nextBaselineId();
      return this.#applyEvent({
        type: 'AWAITING_USER_CONTINUE',
        attemptId,
        baselineId,
      });
    }
    if (task.status === 'interrupted_needs_inspection') {
      const attemptId = this.#nextAttemptId();
      const baselineId = this.#nextBaselineId();
      return this.#applyEvent({
        type: 'INSPECTION_CONTINUE',
        attemptId,
        baselineId,
      });
    }
    if (task.status === 'rework_requested') {
      // PersistReworkRequest path is driven by effects already in flight; if we
      // land here after interrupt, re-drive via a fresh implement attempt after
      // treating rework as inspection resume target is not automatic — surface.
      throw new Error(
        'cannot auto-continue rework_requested — use recovery continue after rework context is persisted',
      );
    }

    throw new Error(
      `cannot continue from workflow state ${task.status}`,
    );
  }

  #operatorInterruptSettleEvent(
    state: SafeExecutionState,
    attemptId: AttemptId,
  ): WorkflowEvent {
    const reason = 'operator interrupt — stage stopped; same-task continue requested';
    switch (state) {
      case 'planning':
        return { type: 'PLAN_FAILED', attemptId, reason };
      case 'implementing':
        return { type: 'IMPLEMENTATION_FAILED', attemptId, reason };
      case 'reviewing':
        return { type: 'REVIEW_FAILED', attemptId, reason };
      case 'master_validation':
        return { type: 'MASTER_FAILED', attemptId, reason };
    }
  }

  public async executePreparedEffects(
    intents: readonly PreparedWorkflowEffectIntent[],
  ): Promise<void> {
    for (const intent of intents) {
      const action = this.#actions.get(intent.actionId);
      if (action === undefined) {
        throw new Error(`prepared recovery action not found: ${intent.actionId}`);
      }
      if (action.taskId !== this.#taskDefinition.taskId) {
        throw new Error(`prepared recovery action belongs to another task: ${intent.actionId}`);
      }
      if (
        action.idempotencyKey !== intent.idempotencyKey ||
        action.type !== intent.actionType
      ) {
        throw new Error(`prepared recovery action identity changed: ${intent.actionId}`);
      }
      if (action.status === 'completed') continue;
      if (action.status === 'failed') {
        throw new Error(
          `prepared recovery action already failed: ${intent.actionId}: ${action.error ?? 'unknown error'}`,
        );
      }
      await this.#executeEffect({
        actionId: intent.actionId,
        idempotencyKey: intent.idempotencyKey,
        actionType: intent.actionType,
        effect: intent.effect,
      });
    }
  }

  async #applyEvent(
    event: WorkflowEvent,
    consumedAction?: ConsumedActionResult,
  ): Promise<WorkflowSnapshot> {
    const current = this.currentTask();
    const reduced = transition(current.workflowSnapshot, event);
    if (reduced.kind !== 'transitioned') {
      throw new Error(`workflow rejected ${event.type}: ${reduced.reason}`);
    }
    const snapshot = canonicalSnapshot(reduced);
    const inheritedIdentity = event.type === 'START'
      ? {
          attemptId: this.#nextAttemptId(),
          baselineId: this.#nextBaselineId(),
        }
      : eventAttemptId(event) === null
        ? consumedAction === undefined
          ? undefined
          : { attemptId: consumedAction.attemptId }
        : { attemptId: eventAttemptId(event)! };
    const prepared = reduced.effects
      .filter(
        (effect): effect is PreparedEffect['effect'] => effect.type !== 'PersistTransition',
      )
      .map((effect, index) =>
        this.#prepareEffect(
          effect,
          current.workflowVersion + 1,
          index,
          inheritedIdentity,
        ));
    this.#persistTransitionAndIntents(
      current,
      snapshot,
      event,
      prepared,
      consumedAction,
    );

    for (const effect of prepared) {
      await this.#executeEffect(effect);
    }
    return this.currentTask().workflowSnapshot;
  }

  #prepareEffect(
    effect: PreparedEffect['effect'],
    workflowVersion: number,
    index: number,
    inheritedIdentity?: {
      readonly attemptId: AttemptId;
      readonly baselineId?: BaselineId;
    },
  ): PreparedEffect {
    const actionId = this.#nextId('action');
    const attemptId = effectAttemptId(effect);
    const reworkIdentity = effect.type === 'PersistReworkRequest'
      ? {
          reservedAttemptId: this.#nextAttemptId(),
          reservedBaselineId: this.#nextBaselineId(),
        }
      : effectAttemptId(effect) === null && inheritedIdentity !== undefined
        ? {
            reservedAttemptId: inheritedIdentity.attemptId,
            ...(inheritedIdentity.baselineId === undefined
              ? {}
              : { reservedBaselineId: inheritedIdentity.baselineId }),
          }
        : effect.type === 'RunEnvironmentCheck'
          ? {
              reservedAttemptId: this.#nextAttemptId(),
              reservedBaselineId: this.#nextBaselineId(),
            }
        : {};
    return {
      actionId,
      actionType: effectActionType(effect),
      idempotencyKey: [
        this.#taskDefinition.taskId,
        String(workflowVersion),
        effect.type,
        attemptId ?? String(index),
      ].join(':'),
      effect,
      ...reworkIdentity,
    };
  }

  #persistTransitionAndIntents(
    current: PersistedTask,
    snapshot: WorkflowSnapshot,
    event: WorkflowEvent,
    prepared: readonly PreparedEffect[],
    consumedAction?: ConsumedActionResult,
  ): void {
    const nextVersion = current.workflowVersion + 1;
    const now = this.#now().toISOString();
    const serializedSnapshot = serializeJsonValue(snapshot);
    withTransaction(this.#database.connection, () => {
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
          current.taskId,
          current.workflowVersion,
        );
      if (updated.changes !== 1) {
        throw new Error(
          `stale workflow version for task ${current.taskId}: expected ${String(current.workflowVersion)}`,
        );
      }
      this.#database.connection
        .prepare(
          `INSERT INTO workflow_transitions(
             task_id, from_state, to_state, event_type, workflow_version, snapshot_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          current.taskId,
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
          current.taskId,
          event.type,
          serializeJsonValue({
            attemptId:
              eventAttemptId(event)
              ?? prepared.find((action) => action.reservedAttemptId !== undefined)
                ?.reservedAttemptId
              ?? current.workflowSnapshot.activeAttemptId
              ?? null,
            event,
            workflowVersion: nextVersion,
          }),
          now,
        );
      if (consumedAction !== undefined) {
        const consumptions = [
          {
            actionId: consumedAction.actionId,
            attemptId: consumedAction.attemptId,
          },
          ...(consumedAction.relatedActions ?? []),
        ];
        for (const consumption of consumptions) {
          const duplicate = this.#database.connection
            .prepare(
              `SELECT 1 AS present FROM events
               WHERE event_type = 'ACTION_RESULT_CONSUMED'
                 AND json_extract(payload_json, '$.actionId') = ?
               LIMIT 1`,
            )
            .get(consumption.actionId);
          if (duplicate !== undefined) {
            throw new Error(
              `action result was already consumed: ${consumption.actionId}`,
            );
          }
          this.#database.connection
            .prepare(
              'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
            )
            .run(
              current.taskId,
              'ACTION_RESULT_CONSUMED',
              serializeJsonValue({
                attemptId: consumption.attemptId,
                actionId: consumption.actionId,
                workflowEvent: event.type,
                consumedByActionId: consumedAction.actionId,
              }),
              now,
            );
        }
      }
      for (const action of prepared) {
        this.#database.connection
          .prepare(
            `INSERT INTO pending_actions(
               id, task_id, idempotency_key, action_type, payload_json,
               status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'intent', ?, ?)`,
          )
          .run(
            action.actionId,
            current.taskId,
            action.idempotencyKey,
            action.actionType,
            serializeJsonValue({
              schemaVersion: 1,
              attemptId:
                action.reservedAttemptId ?? effectAttemptId(action.effect),
              baselineId: action.reservedBaselineId ?? null,
              effect: action.effect,
              replayPolicy:
                action.actionType === 'agent-run'
                  ? 'never-auto-replay'
                  : 'reconcile-before-retry',
            }),
            now,
            now,
          );
      }
    });
  }

  async #executeEffect(prepared: PreparedEffect): Promise<void> {
    switch (prepared.effect.type) {
      case 'AcquireProjectLock':
        this.#acquireProjectLock(prepared);
        return;
      case 'RunEnvironmentCheck':
        await this.#runEnvironmentCheck(prepared);
        return;
      case 'CreateAttemptBaseline':
        this.#createAttemptBaseline(prepared);
        return;
      case 'PrepareImplementationWorkspace':
        this.#prepareImplementationWorkspace(prepared);
        return;
      case 'FinalizeCandidateChangeSet':
        this.#finalizeCandidateChangeSet(prepared);
        return;
      case 'PromoteCandidateWorkspace':
        this.#promoteCandidateWorkspace(prepared);
        return;
      case 'StartPlanning':
      case 'StartImplementation':
      case 'StartReview':
      case 'StartMasterValidation':
        await this.#runStage(prepared, prepared.effect);
        return;
      case 'PersistReworkRequest':
        await this.#persistReworkRequest(prepared);
        return;
      case 'BeginProcessCleanup':
        await this.#beginProcessCleanup(prepared);
        return;
      case 'ReleaseProjectLock':
        this.#releaseProjectLock(prepared);
        return;
    }
  }

  /**
   * Execute process-cleanup for INTERRUPT / CANCEL: cooperative stop, optional
   * grace, force tree stop, optional verification, then PROCESS_TREE_CLEAN or
   * PROCESS_CLEANUP_FAILED. Completes the process-cleanup pending action.
   */
  async #beginProcessCleanup(prepared: PreparedEffect): Promise<void> {
    if (prepared.effect.type !== 'BeginProcessCleanup') {
      throw new Error('prepared effect is not BeginProcessCleanup');
    }
    const { attemptId, stopIntent } = prepared.effect;
    let failureReason: string | undefined;

    if (this.#processSupervisor !== undefined) {
      try {
        await this.#processSupervisor.requestGracefulStop(attemptId);
      } catch (error) {
        if (!isUnsupervisedAttemptError(error)) {
          // Cooperative stop failed; still attempt force.
          failureReason = undefined;
        }
      }

      const grace = this.#cleanupGracePeriodMs;
      if (this.#advanceCleanupClock !== undefined) {
        this.#advanceCleanupClock(Math.max(grace, 1));
      } else if (grace > 0) {
        await delay(grace);
      }

      try {
        await this.#processSupervisor.forceStopTree(attemptId);
        if (this.#advanceCleanupClock !== undefined) {
          this.#advanceCleanupClock(Math.max(2, Math.floor(grace / 5) || 2));
        }
      } catch (error) {
        if (!isUnsupervisedAttemptError(error)) {
          failureReason =
            `force Job close failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      if (this.#verifyProcessTreeGone !== undefined) {
        try {
          const tree = await this.#verifyProcessTreeGone(attemptId);
          if (!tree.clean) {
            failureReason =
              `process tree cleanup verification failed: ${tree.reason}`;
          } else {
            failureReason = undefined;
          }
        } catch (error) {
          failureReason =
            `tree verification failed closed: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else if (failureReason !== undefined) {
        // No verifier: if force threw but process may already be gone, leave
        // failureReason set so we fail closed rather than claim clean.
      }
    }

    if (failureReason !== undefined) {
      this.#actions.markFailed(prepared.actionId, { error: failureReason });
      await this.#applyEvent({
        type: 'PROCESS_CLEANUP_FAILED',
        reason: failureReason,
      });
      return;
    }

    this.#actions.markCompleted(prepared.actionId, {
      result: {
        attemptId,
        stopIntent,
        status:
          stopIntent === 'cancel' ? 'cancelled' : 'interrupted_needs_inspection',
      },
    });
    await this.#applyEvent({ type: 'PROCESS_TREE_CLEAN' });
  }

  #acquireProjectLock(prepared: PreparedEffect): void {
    if (prepared.reservedAttemptId === undefined) {
      throw new Error('project lock action has no attempt evidence identity');
    }
    const result = this.#lockService.acquire(
      this.#taskDefinition.taskId,
      canonicalizeProjectPath(this.#projectRoot),
      this.#ownerInstanceId,
      this.#now(),
      this.#leaseDurationMs,
    );
    if (result.status !== 'acquired') {
      this.#actions.markFailed(prepared.actionId, {
        error: `project lock conflict with task ${result.conflict.taskId ?? 'unknown'}`,
        result,
      });
      throw new Error('project lock acquisition failed');
    }
    this.#lockId = result.lock.lockId;
    this.#actions.markCompleted(prepared.actionId, {
      result: {
        attemptId: prepared.reservedAttemptId,
        lockId: result.lock.lockId,
        leaseExpiresAt: result.lock.leaseExpiresAt,
      },
    });
  }

  async #runEnvironmentCheck(prepared: PreparedEffect): Promise<void> {
    const attemptId = prepared.reservedAttemptId ?? this.#nextAttemptId();
    const baselineId = prepared.reservedBaselineId ?? this.#nextBaselineId();
    const health = await Promise.all(
      (['master', 'implementer', 'reviewer'] as const).map(async (role) => ({
        role,
        adapter: this.#adapters[role].kind,
        health: await this.#adapters[role].checkAvailability(),
        capabilities: await this.#adapters[role].discoverCapabilities(),
      })),
    );
    const unavailable = health.find((entry) => entry.health.status === 'unavailable');
    if (unavailable !== undefined) {
      const reason = unavailable.health.status === 'unavailable'
        ? `${unavailable.role} adapter unavailable: ${unavailable.health.reason}`
        : `${unavailable.role} adapter unavailable`;
      this.#actions.markCompleted(prepared.actionId, {
        result: { attemptId, baselineId, ready: false, reason, health },
      });
      await this.#applyEvent(
        { type: 'ENVIRONMENT_FAILED', reason },
        { actionId: prepared.actionId, attemptId },
      );
      return;
    }

    const taskBaselineId = this.#nextId('task-baseline');
    const taskBaseline = this.#tracker.captureTaskBaseline({
      taskId: this.#taskDefinition.taskId,
      baselineId: taskBaselineId,
      createdAt: this.#now(),
    });
    this.#taskBaselineId = taskBaselineId;
    this.#actions.markCompleted(prepared.actionId, {
      result: {
        attemptId,
        baselineId,
        taskBaselineId,
        taskBaselineChecksum: taskBaseline.checksum,
        ready: true,
        health,
      },
    });
    await this.#applyEvent(
      { type: 'ENVIRONMENT_READY', attemptId, baselineId },
      { actionId: prepared.actionId, attemptId },
    );
  }

  #createAttemptBaseline(prepared: PreparedEffect): void {
    const effect = prepared.effect;
    if (effect.type !== 'CreateAttemptBaseline') {
      throw new Error('prepared effect is not a baseline action');
    }
    const taskBaselineId = this.#resolveTaskBaselineId();
    const attemptNumber = Number(
      (
        this.#database.connection
          .prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE task_id = ?')
          .get(effect.taskId) as { readonly count: number }
      ).count,
    ) + 1;
    this.#attempts.create(
      effect.taskId,
      createPendingRunAttempt({
        attemptId: effect.attemptId,
        baselineId: effect.baselineId,
        requirementVersion: effect.requirementVersion,
        startedAt: this.#now().toISOString(),
      }),
    );
    const manifest = this.#tracker.captureAttemptBaseline({
      taskId: effect.taskId,
      baselineId: effect.baselineId,
      attemptId: effect.attemptId,
      attemptNumber,
      parentTaskBaselineId: taskBaselineId,
      createdAt: this.#now(),
    });
    const taskBaseline = this.#requireBaseline(taskBaselineId);
    withTransaction(this.#database.connection, () => {
      this.#database.connection
        .prepare(
          `INSERT OR IGNORE INTO file_baselines(
             id, task_id, attempt_id, status, manifest_json, created_at, completed_at
           ) VALUES (?, ?, ?, 'complete', ?, ?, ?)`,
        )
        .run(
          taskBaselineId,
          effect.taskId,
          effect.attemptId,
          serializeJsonValue(taskBaseline),
          taskBaseline.createdAt,
          taskBaseline.createdAt,
        );
      this.#database.connection
        .prepare(
          `INSERT INTO file_baselines(
             id, task_id, attempt_id, status, manifest_json, created_at, completed_at
           ) VALUES (?, ?, ?, 'complete', ?, ?, ?)`,
        )
        .run(
          effect.baselineId,
          effect.taskId,
          effect.attemptId,
          serializeJsonValue(manifest),
          manifest.createdAt,
          manifest.createdAt,
        );
    });
    this.#actions.markCompleted(prepared.actionId, {
      result: {
        attemptId: effect.attemptId,
        baselineId: effect.baselineId,
        manifestChecksum: manifest.checksum,
        taskBaselineId,
      },
    });
  }

  #usesIsolatedGrokImplementer(): boolean {
    return this.#adapters.implementer.kind === 'grok'
      && this.#taskDefinition.roles.implementer === 'grok';
  }

  #isolatedLaunchFields(
    effect: StartEffect,
  ): Partial<AgentRequest> {
    if (!this.#usesIsolatedGrokImplementer()) {
      return {};
    }
    if (effect.type === 'StartImplementation') {
      const auth = this.#activeWorkspaceAuthorization;
      if (
        auth === undefined
        || auth.attemptId !== String(effect.attemptId)
      ) {
        throw new Error(
          'isolated Grok implementation requires a prepared workspace authorization for this attempt',
        );
      }
      // Prompt and execution root must never expose canonical write authority.
      return {
        executionScope: 'isolated_implementation',
        workspaceAuthorizationId: auth.authorizationId,
        sourceManifestHash: auth.sourceManifestHash,
        executionRoot: auth.executionRoot,
        prompt: this.#isolatedImplementationPrompt(auth.executionRoot),
      };
    }
    if (effect.type === 'StartReview' || effect.type === 'StartMasterValidation') {
      const evidence = this.#lastCandidateEvidence;
      if (evidence === undefined) {
        throw new Error(
          'isolated Grok review/master validation requires a finalized candidate change-set',
        );
      }
      // Keep projectRoot as the canonical identity root for launch guards.
      // Point adapter cwd/tool scope at the candidate so validators do not
      // false-reject the intentionally-unchanged live project.
      return {
        inspectionRoot: evidence.candidateRoot,
        prompt: this.#isolatedCandidateValidationPrompt(effect.type, evidence),
      };
    }
    return {};
  }

  #isolatedImplementationPrompt(executionRoot: string): string {
    return [
      'You are the implementer operating ONLY inside the candidate project root below.',
      'Do not reference or modify any other filesystem location.',
      `Candidate project root: ${executionRoot}`,
      'Requirements:',
      this.#requirements,
      'When finished, write the required files with Edit/Write tools, then end your turn.',
      'If you can, also print a final JSON object with fields:',
      'status, summary, changedFiles, commandsRun, verification, issues, nextAction.',
      'Use status "completed" and nextAction "review" when the candidate is ready for review.',
    ].join('\n');
  }

  #isolatedCandidateValidationPrompt(
    stage: 'StartReview' | 'StartMasterValidation',
    evidence: {
      readonly candidateRoot: string;
      readonly candidateManifestHash: string;
    },
  ): string {
    const evidenceDir = resolve(evidence.candidateRoot, '..');
    const changeSetPath = join(evidenceDir, 'change-set.json');
    const reviewBundlePath = join(evidenceDir, 'review-bundle.json');
    const isMaster = stage === 'StartMasterValidation';
    return [
      isMaster
        ? 'You are the master validator for an ISOLATED candidate workspace.'
        : 'You are the independent reviewer for an ISOLATED candidate workspace.',
      'Do not modify any files.',
      `Candidate project root (validate ONLY this tree): ${evidence.candidateRoot}`,
      `Canonical project root (intentionally UNCHANGED until promotion — do NOT reject because required files are missing there): ${this.#projectRoot}`,
      `Candidate manifest hash: ${evidence.candidateManifestHash}`,
      `Change-set evidence: ${changeSetPath}`,
      `Review-bundle evidence: ${reviewBundlePath}`,
      'Requirements:',
      this.#requirements,
      isMaster
        ? 'If the candidate satisfies the requirements and the prior review evidence is consistent, return status "completed", nextAction "complete", verification.passed true, and issues [].'
        : 'If the candidate satisfies the requirements, return status "completed", nextAction "master_validation", verification.passed true, and issues [].',
      isMaster
        ? 'Return nextAction "rework" only for real requirement failures inside the candidate tree.'
        : 'Return nextAction "rework" only for real requirement failures inside the candidate tree.',
      'Return only a result matching schemas/agent-result.schema.json.',
    ].join('\n');
  }

  #prepareImplementationWorkspace(prepared: PreparedEffect): void {
    const effect = prepared.effect;
    if (effect.type !== 'PrepareImplementationWorkspace') {
      throw new Error('prepared effect is not PrepareImplementationWorkspace');
    }
    // Live-project implementers (Codex/Claude) skip isolation; Grok requires it.
    if (!this.#usesIsolatedGrokImplementer()) {
      this.#actions.markCompleted(prepared.actionId, {
        result: {
          skipped: true,
          reason: 'implementer is not Grok; live-project path unchanged',
          attemptId: effect.attemptId,
        },
      });
      return;
    }
    if (this.#implementationWorkspacesDirectory === undefined) {
      this.#actions.markFailed(prepared.actionId, {
        error: 'implementationWorkspacesDirectory is required for Grok implementer',
        result: { attemptId: effect.attemptId },
      });
      throw new Error('implementationWorkspacesDirectory is required for Grok implementer');
    }

    const taskBaselineId = this.#resolveTaskBaselineId();
    const taskBaseline = this.#requireBaseline(taskBaselineId);
    const nowIso = this.#now().toISOString();
    const expiresAt = new Date(this.#now().getTime() + 60 * 60 * 1000).toISOString();
    const authorizationId = `workspace-auth-${String(effect.attemptId)}`;

    // Rework: reuse the existing candidate root and issue a fresh single-use authorization.
    const reusable = this.#findReusableCandidateWorkspace(String(effect.taskId));
    if (reusable !== undefined) {
      try {
        this.#reissueWorkspaceAuthorization({
          workspaceId: reusable.workspaceId,
          authorizationId,
          attemptId: String(effect.attemptId),
          sourceManifestHash: reusable.sourceManifestHash,
          executionRoot: reusable.workspaceRoot,
          expiresAt,
          nowIso,
        });
        this.#activeWorkspaceAuthorization = {
          workspaceId: reusable.workspaceId,
          authorizationId,
          sourceManifestHash: reusable.sourceManifestHash,
          executionRoot: reusable.workspaceRoot,
          attemptId: String(effect.attemptId),
        };
        this.#actions.markCompleted(prepared.actionId, {
          result: {
            reused: true,
            workspaceId: reusable.workspaceId,
            authorizationId,
            workspaceRoot: reusable.workspaceRoot,
            sourceManifestHash: reusable.sourceManifestHash,
            attemptId: effect.attemptId,
          },
        });
        return;
      } catch (error) {
        this.#actions.markFailed(prepared.actionId, {
          error: error instanceof Error ? error.message : String(error),
          result: { attemptId: effect.attemptId },
        });
        throw error;
      }
    }

    const workspaceId = `workspace-${String(effect.attemptId)}`;

    // Minimal AppPaths-like surface for the materializer.
    const paths = {
      root: resolve(this.#implementationWorkspacesDirectory, '..'),
      databasePath: join(resolve(this.#implementationWorkspacesDirectory, '..'), 'triagent.db'),
      logsDirectory: join(resolve(this.#implementationWorkspacesDirectory, '..'), 'logs'),
      snapshotsDirectory: this.#tracker.snapshotStore,
      implementationWorkspacesDirectory: this.#implementationWorkspacesDirectory,
      nativeDiagnosticsDirectory: join(
        resolve(this.#implementationWorkspacesDirectory, '..'),
        'native-diagnostics',
      ),
      settingsPath: join(resolve(this.#implementationWorkspacesDirectory, '..'), 'settings.json'),
      cliCompatibilityCachePath: join(
        resolve(this.#implementationWorkspacesDirectory, '..'),
        'cli-compatibility-cache.json',
      ),
    } as const;

    mkdirSync(this.#implementationWorkspacesDirectory, { recursive: true });
    const service = new ImplementationWorkspaceService({
      database: this.#database.connection,
      paths,
      tracker: this.#tracker,
    });

    try {
      const materialized = service.materializeFromBaseline({
        workspaceId,
        taskId: String(effect.taskId),
        attemptId: String(effect.attemptId),
        sourceBaselineId: taskBaselineId,
        sourceManifestHash: taskBaseline.checksum,
        authorizationId,
        authorizationExpiresAt: expiresAt,
        nowIso,
        canonicalProjectRoot: this.#projectRoot,
      });
      this.#activeWorkspaceAuthorization = {
        workspaceId,
        authorizationId,
        sourceManifestHash: taskBaseline.checksum,
        executionRoot: materialized.record.workspaceRoot,
        attemptId: String(effect.attemptId),
      };
      this.#actions.markCompleted(prepared.actionId, {
        result: {
          workspaceId,
          authorizationId,
          workspaceRoot: materialized.record.workspaceRoot,
          candidateManifestHash: materialized.candidateManifestHash,
          sourceManifestHash: taskBaseline.checksum,
          attemptId: effect.attemptId,
        },
      });
    } catch (error) {
      this.#actions.markFailed(prepared.actionId, {
        error: error instanceof Error ? error.message : String(error),
        result: { attemptId: effect.attemptId },
      });
      throw error;
    }
  }

  #findReusableCandidateWorkspace(taskId: string): {
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly sourceManifestHash: string;
  } | undefined {
    // Prefer the in-memory active workspace from a prior attempt on this task.
    if (
      this.#activeWorkspaceAuthorization !== undefined
      && existsSync(this.#activeWorkspaceAuthorization.executionRoot)
    ) {
      const record = this.#workspaces.get(this.#activeWorkspaceAuthorization.workspaceId);
      if (
        record !== undefined
        && record.taskId === taskId
        && (
          record.status === 'candidate_ready'
          || record.status === 'under_review'
          || record.status === 'running'
          || record.status === 'ready'
          || record.status === 'approved'
          || record.status === 'recovery_required'
        )
      ) {
        return {
          workspaceId: record.workspaceId,
          workspaceRoot: record.workspaceRoot,
          sourceManifestHash: record.sourceManifestHash,
        };
      }
    }
    return undefined;
  }

  #reissueWorkspaceAuthorization(input: {
    readonly workspaceId: string;
    readonly authorizationId: string;
    readonly attemptId: string;
    readonly sourceManifestHash: string;
    readonly executionRoot: string;
    readonly expiresAt: string;
    readonly nowIso: string;
  }): void {
    const current = this.#workspaces.get(input.workspaceId);
    if (current === undefined) {
      throw new Error(`workspace not found for re-authorization: ${input.workspaceId}`);
    }
    // Rework reuses the candidate tree: refresh single-use authorization,
    // rebind attempt_id to the new implementer attempt (peek/consume require it),
    // and return the durable row to ready for Grok on the same root.
    this.#database.connection.prepare(
      `UPDATE implementation_workspaces
       SET authorization_id = ?,
           authorization_expires_at = ?,
           authorization_consumed_at = NULL,
           attempt_id = ?,
           status = 'ready',
           last_error = NULL,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      input.authorizationId,
      input.expiresAt,
      input.attemptId,
      input.nowIso,
      input.workspaceId,
    );
  }

  #finalizeCandidateChangeSet(prepared: PreparedEffect): void {
    const effect = prepared.effect;
    if (effect.type !== 'FinalizeCandidateChangeSet') {
      throw new Error('prepared effect is not FinalizeCandidateChangeSet');
    }
    if (!this.#usesIsolatedGrokImplementer()) {
      this.#actions.markCompleted(prepared.actionId, {
        result: {
          skipped: true,
          reason: 'no isolated workspace for non-Grok implementer',
          attemptId: effect.attemptId,
        },
      });
      return;
    }
    const auth = this.#activeWorkspaceAuthorization;
    if (auth === undefined || auth.attemptId !== String(effect.attemptId)) {
      this.#actions.markFailed(prepared.actionId, {
        error: 'missing active isolated workspace for finalize',
      });
      throw new Error('missing active isolated workspace for finalize');
    }
    const workspace = this.#workspaces.get(auth.workspaceId);
    if (workspace === undefined) {
      this.#actions.markFailed(prepared.actionId, {
        error: `workspace not found: ${auth.workspaceId}`,
      });
      throw new Error(`workspace not found: ${auth.workspaceId}`);
    }

    const taskBaselineId = this.#resolveTaskBaselineId();
    const taskBaseline = this.#requireBaseline(taskBaselineId);
    const sourceFiles = this.#trackingFilesToSnapshots(taskBaseline.files);
    const candidateFiles = this.#scanWorkspaceFiles(auth.executionRoot);
    const candidateManifestHash = sha256(
      JSON.stringify(
        candidateFiles
          .map((file) => ({ path: file.path, hash: file.hash, size: file.size }))
          .sort((left, right) => left.path.localeCompare(right.path)),
      ),
    );

    try {
      const changeSet = buildWorkspaceCandidateChangeSet({
        taskId: String(effect.taskId),
        attemptId: String(effect.attemptId),
        workspaceId: auth.workspaceId,
        sourceBaselineId: taskBaselineId,
        sourceManifestHash: taskBaseline.checksum,
        candidateManifestHash,
        sourceFiles,
        candidateFiles,
      });
      // Persist change-set sidecar next to candidate root.
      const sidecar = join(resolve(auth.executionRoot, '..'), 'change-set.json');
      writeFileSync(sidecar, JSON.stringify(changeSet), 'utf8');

      const reviewBundle = buildImmutableReviewBundleFromCandidateChangeSet({
        requirementText: this.#requirements,
        requirementVersion: this.currentTask().workflowSnapshot.requirementVersion,
        plan: 'Isolated candidate implementation ready for immutable review.',
        taskStartBaselineId: taskBaselineId,
        attemptBaselineId: effect.baselineId,
        changeSet,
      });
      writeFileSync(
        join(resolve(auth.executionRoot, '..'), 'review-bundle.json'),
        JSON.stringify({
          bundleHash: reviewBundle.bundleHash,
          reviewRecord: reviewBundle.reviewRecord,
          payload: reviewBundle.payload,
          canonicalJson: reviewBundle.canonicalJson,
        }),
        'utf8',
      );
      this.#lastCandidateEvidence = {
        changeSet,
        reviewBundle,
        candidateRoot: auth.executionRoot,
        candidateManifestHash,
      };

      // Transition workspace through candidate_ready when still running.
      if (workspace.status === 'running') {
        this.#workspaces.transition({
          workspaceId: auth.workspaceId,
          expectedStatus: 'running',
          status: 'candidate_ready',
          nowIso: this.#now().toISOString(),
          candidateManifestHash,
          changeSetHash: changeSet.changeSetHash,
        });
      }
      // Mark under_review once finalize succeeds (immutable evidence frozen).
      const after = this.#workspaces.get(auth.workspaceId);
      if (after?.status === 'candidate_ready') {
        this.#workspaces.transition({
          workspaceId: auth.workspaceId,
          expectedStatus: 'candidate_ready',
          status: 'under_review',
          nowIso: this.#now().toISOString(),
        });
      }
      this.#actions.markCompleted(prepared.actionId, {
        result: {
          workspaceId: auth.workspaceId,
          changeSetHash: changeSet.changeSetHash,
          candidateManifestHash,
          reviewBundleHash: reviewBundle.bundleHash,
          entryCount: changeSet.entries.length,
          attemptId: effect.attemptId,
        },
      });
    } catch (error) {
      this.#actions.markFailed(prepared.actionId, {
        error: error instanceof Error ? error.message : String(error),
        result: { attemptId: effect.attemptId },
      });
      throw error;
    }
  }

  #promoteCandidateWorkspace(prepared: PreparedEffect): void {
    const effect = prepared.effect;
    if (effect.type !== 'PromoteCandidateWorkspace') {
      throw new Error('prepared effect is not PromoteCandidateWorkspace');
    }
    if (!this.#usesIsolatedGrokImplementer()) {
      this.#actions.markCompleted(prepared.actionId, {
        result: {
          skipped: true,
          reason: 'no isolated workspace to promote',
          attemptId: effect.attemptId,
        },
      });
      return;
    }
    const auth = this.#activeWorkspaceAuthorization;
    if (auth === undefined) {
      this.#actions.markFailed(prepared.actionId, {
        error: 'missing isolated workspace for promotion',
        result: { attemptId: effect.attemptId },
      });
      throw new Error('missing isolated workspace for promotion');
    }
    const workspace = this.#workspaces.get(auth.workspaceId);
    if (workspace === undefined) {
      this.#actions.markFailed(prepared.actionId, {
        error: `workspace not found: ${auth.workspaceId}`,
      });
      throw new Error(`workspace not found: ${auth.workspaceId}`);
    }
    const evidence = this.#lastCandidateEvidence;
    if (evidence === undefined) {
      this.#actions.markFailed(prepared.actionId, {
        error: 'missing finalized candidate change-set for promotion',
        result: { attemptId: effect.attemptId },
      });
      throw new Error('missing finalized candidate change-set for promotion');
    }

    try {
      // Advance durable workspace lifecycle to approved before PatchApplier.
      // Fake adapters may not consume authorization (ready stays ready); real
      // launches reach running/candidate_ready/under_review via finalize.
      let current = workspace;
      const nowIso = this.#now().toISOString();
      if (current.status === 'ready') {
        current = this.#workspaces.transition({
          workspaceId: current.workspaceId,
          expectedStatus: 'ready',
          status: 'running',
          nowIso,
        });
      }
      if (current.status === 'running') {
        current = this.#workspaces.transition({
          workspaceId: current.workspaceId,
          expectedStatus: 'running',
          status: 'candidate_ready',
          nowIso,
          changeSetHash: evidence.changeSet.changeSetHash,
          candidateManifestHash: evidence.candidateManifestHash,
        });
      }
      if (current.status === 'candidate_ready') {
        current = this.#workspaces.transition({
          workspaceId: current.workspaceId,
          expectedStatus: 'candidate_ready',
          status: 'under_review',
          nowIso,
        });
      }
      if (current.status === 'under_review') {
        current = this.#workspaces.transition({
          workspaceId: current.workspaceId,
          expectedStatus: 'under_review',
          status: 'approved',
          nowIso,
        });
      }
      if (
        current.status !== 'approved'
        && current.status !== 'validating'
        && current.status !== 'promoting'
      ) {
        throw new Error(
          `workspace status ${current.status} cannot enter promotion`,
        );
      }

      const taskBaselineId = this.#resolveTaskBaselineId();
      const taskBaseline = this.#requireBaseline(taskBaselineId);
      const expectedCanonicalFiles = this.#baselineToFingerprints(taskBaseline);
      const currentCanonicalFiles = this.#scanCanonicalFingerprints();

      const promotion = new WorkspacePromotionService({
        repository: this.#workspaces,
        canonicalProjectRoot: this.#projectRoot,
        snapshotStore: this.#tracker.snapshotStore,
        patchApplier: new PatchApplier({
          projectRoot: this.#projectRoot,
          snapshotStore: this.#tracker.snapshotStore,
          guard: new ProjectGuard({ projectRoot: this.#projectRoot }),
        }),
      });

      // Workspace row is bound to the implementer attempt that prepared it
      // (rework reuses the same row). Master-validation attemptId on the effect
      // is only for action correlation, not workspace identity.
      const result = promotion.promote({
        workspaceId: auth.workspaceId,
        taskId: workspace.taskId,
        attemptId: workspace.attemptId,
        baselineId: `promote-${workspace.attemptId}`,
        sourceManifestHash: workspace.sourceManifestHash,
        changeSet: evidence.changeSet,
        expectedCanonicalFiles,
        currentCanonicalFiles,
        nowIso: this.#now().toISOString(),
        expectedLockOwner: this.#ownerInstanceId,
        actualLockOwner: this.#ownerInstanceId,
      });

      if (!result.ok) {
        this.#actions.markFailed(prepared.actionId, {
          error: result.reason,
          result: {
            workspaceId: auth.workspaceId,
            code: result.code,
            attemptId: effect.attemptId,
          },
        });
        throw new Error(result.reason);
      }

      this.#actions.markCompleted(prepared.actionId, {
        result: {
          workspaceId: auth.workspaceId,
          status: 'promoted',
          attemptId: effect.attemptId,
          promotedChangeSetHash: result.promotedChangeSetHash,
          postApplyVerified: result.postApplyVerified,
          emptyChangeSet: result.emptyChangeSet === true,
          filesWritten: result.patchResult?.evidence.filesWritten ?? [],
          sourceManifestHash: workspace.sourceManifestHash,
          expectedManifestHash: hashCanonicalManifest(expectedCanonicalFiles),
          currentManifestHash: hashCanonicalManifest(currentCanonicalFiles),
        },
      });
    } catch (error) {
      const existing = this.#database.connection.prepare(
        `SELECT status AS status FROM pending_actions WHERE id = ?`,
      ).get(prepared.actionId) as { readonly status: string } | undefined;
      if (existing?.status !== 'failed' && existing?.status !== 'completed') {
        this.#actions.markFailed(prepared.actionId, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  #baselineToFingerprints(
    baseline: TrackingBaselineManifest,
  ): CanonicalFileFingerprint[] {
    return baseline.files
      .filter((entry) => entry.type === 'file' || entry.missing === true)
      .map((entry) => ({
        path: entry.path.replaceAll('\\', '/'),
        hash: entry.hash,
        size: entry.size,
        ...(entry.missing === true ? { missing: true as const } : {}),
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  #scanCanonicalFingerprints(): CanonicalFileFingerprint[] {
    const files = this.#scanWorkspaceFiles(this.#projectRoot);
    return files
      .map((file) => ({
        path: file.path.replaceAll('\\', '/'),
        hash: file.hash,
        size: file.size,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  #trackingFilesToSnapshots(
    files: TrackingBaselineManifest['files'],
  ): WorkspaceFileSnapshot[] {
    return files
      .filter((entry) => entry.type === 'file' && entry.missing !== true)
      .map((entry) => {
        let content: Buffer | null = null;
        if (entry.blobHash !== null) {
          try {
            content = this.#tracker.readBlob(entry.blobHash);
          } catch {
            content = null;
          }
        }
        return {
          path: entry.path,
          type: entry.type,
          size: entry.size,
          hash: entry.hash,
          blobHash: entry.blobHash,
          missing: entry.missing,
          binary: entry.binary,
          content,
        };
      });
  }

  #scanWorkspaceFiles(workspaceRoot: string): WorkspaceFileSnapshot[] {
    const results: WorkspaceFileSnapshot[] = [];
    const walk = (relativeDir: string): void => {
      const absoluteDir = relativeDir.length === 0
        ? workspaceRoot
        : join(workspaceRoot, ...relativeDir.split('/'));
      if (!existsSync(absoluteDir)) return;
      for (const name of readdirSync(absoluteDir)) {
        if (name === '.' || name === '..') continue;
        const relativePath = relativeDir.length === 0 ? name : `${relativeDir}/${name}`;
        const absolutePath = join(workspaceRoot, ...relativePath.split('/'));
        const stats = statSync(absolutePath);
        if (stats.isDirectory()) {
          walk(relativePath);
          continue;
        }
        if (!stats.isFile()) continue;
        const content = readFileSync(absolutePath);
        const hash = sha256(content);
        results.push({
          path: relativePath.replaceAll('\\', '/'),
          type: 'file',
          size: content.length,
          hash,
          blobHash: hash,
          missing: false,
          binary: content.includes(0),
          content,
        });
      }
    };
    walk('');
    return results.sort((left, right) => left.path.localeCompare(right.path));
  }

  #hashWorkspaceTree(workspaceRoot: string): string {
    const files = this.#scanWorkspaceFiles(workspaceRoot).map((file) => ({
      path: file.path,
      hash: file.hash,
      size: file.size,
    }));
    return sha256(JSON.stringify(files));
  }

  async #persistReworkRequest(prepared: PreparedEffect): Promise<void> {
    const effect = prepared.effect;
    if (effect.type !== 'PersistReworkRequest') {
      throw new Error('prepared effect is not a rework action');
    }
    if (
      prepared.reservedAttemptId === undefined
      || prepared.reservedBaselineId === undefined
    ) {
      throw new Error('rework action has no persisted next-attempt identity');
    }
    // Prefer master validation origin; Codex review rework may only have reviewer evidence.
    const origin = this.#database.connection
      .prepare(
        `SELECT attempt_id AS attemptId FROM reviews
         WHERE task_id = ? AND reviewer_role IN ('master', 'reviewer')
         ORDER BY
           CASE reviewer_role WHEN 'master' THEN 0 ELSE 1 END,
           created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(effect.taskId) as { readonly attemptId: string } | undefined;
    if (origin === undefined) {
      this.#actions.markFailed(prepared.actionId, {
        error: 'rework request has no persisted review evidence',
      });
      throw new Error('rework request has no persisted review evidence');
    }
    this.#actions.markCompleted(prepared.actionId, {
      result: {
        attemptId: prepared.reservedAttemptId,
        originAttemptId: origin.attemptId,
        baselineId: prepared.reservedBaselineId,
        reason: effect.reason,
        reworkNumber: effect.nextReworkNumber,
      },
    });
    this.#database.connection
      .prepare(
        'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        effect.taskId,
        'REWORK_REQUEST_PERSISTED',
        serializeJsonValue({
          attemptId: prepared.reservedAttemptId,
          originAttemptId: origin.attemptId,
          baselineId: prepared.reservedBaselineId,
          reason: effect.reason,
          reworkNumber: effect.nextReworkNumber,
          actionId: prepared.actionId,
        }),
        this.#now().toISOString(),
      );
    await this.#applyEvent(
      {
        type: 'REWORK_CONTEXT_PERSISTED',
        attemptId: prepared.reservedAttemptId,
        baselineId: prepared.reservedBaselineId,
      },
      {
        actionId: prepared.actionId,
        attemptId: prepared.reservedAttemptId,
      },
    );
  }

  /**
   * Implementer MVP: resume the latest store-backed conversation when present.
   * Master/reviewer always start a fresh context for independence.
   */
  #resolveImplementerResumeConversation(): ConversationId | undefined {
    if (this.#agentSessions === undefined) return undefined;
    const agentKind = this.#taskDefinition.roles.implementer;
    const found = this.#agentSessions.findLatestForTaskRole({
      taskId: this.#taskDefinition.taskId,
      role: 'implementer',
      agentKind,
    });
    return found?.conversationId;
  }

  async #runStage(prepared: PreparedEffect, effect: StartEffect): Promise<void> {
    const adapter = this.#adapters[effect.role];
    // Never silently substitute a different adapter than the task role assignment.
    const expectedKind = this.#taskDefinition.roles[effect.role];
    if (adapter.kind !== expectedKind) {
      throw new Error(
        `adapter substitution denied: role ${effect.role} requires ${expectedKind}, got ${adapter.kind}`,
      );
    }
    const resumeConversationId =
      effect.role === 'implementer'
        ? this.#resolveImplementerResumeConversation()
        : undefined;
    const request: AgentRequest = {
      attemptId: effect.attemptId,
      baselineId: effect.baselineId,
      requirementVersion: effect.requirementVersion,
      role: effect.role,
      projectRoot: this.#projectRoot,
      prompt: this.#prompt(effect),
      ...this.#isolatedLaunchFields(effect),
    };
    let run: PersistedAgentRun;
    try {
      run = await this.#commandRunner.runPreparedAgent({
        actionId: prepared.actionId,
        taskId: effect.taskId,
        adapter,
        request,
        ...(resumeConversationId === undefined
          ? {}
          : { resumeConversationId }),
      });
    } catch (error) {
      if (this.#actions.get(prepared.actionId)?.status !== 'failed') {
        throw error;
      }
      await this.#applyEvent(
        this.#failedEvent(effect, error),
        { actionId: prepared.actionId, attemptId: effect.attemptId },
      );
      return;
    }
    if (run.runResult.status !== 'succeeded' || run.runResult.output === undefined) {
      await this.#persistStageResultAndApply(
        effect,
        run,
        undefined,
        undefined,
        this.#failedEvent(
          effect,
          new Error(run.runResult.error ?? `agent run ${run.runResult.status}`),
        ),
      );
      return;
    }
    const parsed = parseAgentResult(run.runResult.output);
    if (!parsed.success) {
      const repair = await this.#runFormatRepair(
        effect,
        adapter,
        parsed.reason,
      );
      if (!repair.parsed.success) {
        await this.#persistSecondParseFailure(
          effect,
          run,
          repair.evidence,
          repair.parsed.reason,
        );
        return;
      }
      const changeSet = this.#diff.attemptWindow(effect.baselineId);
      const workflowEvent = this.#eventForResult(
        effect,
        repair.parsed.result,
        changeSet,
      );
      await this.#persistStageResultAndApply(
        effect,
        run,
        repair.parsed.result,
        changeSet,
        workflowEvent,
        repair.evidence,
      );
      return;
    }

    const changeSet = this.#diff.attemptWindow(effect.baselineId);
    const workflowEvent = this.#eventForResult(effect, parsed.result, changeSet);
    await this.#persistStageResultAndApply(
      effect,
      run,
      parsed.result,
      changeSet,
      workflowEvent,
    );
  }

  async #runFormatRepair(
    effect: StartEffect,
    adapter: AgentAdapter,
    firstFailure: string,
  ): Promise<{
    readonly evidence: FormatRepairEvidence;
    readonly parsed: AgentResultParseOutcome;
  }> {
    const attemptId = this.#nextAttemptId();
    const baselineId = this.#nextBaselineId();
    const baselineActionId = this.#nextId('action');
    this.#actions.recordIntent({
      actionId: baselineActionId,
      taskId: effect.taskId,
      idempotencyKey: `${effect.taskId}:format-repair-baseline:${attemptId}`,
      type: 'format-repair-baseline',
      payload: {
        schemaVersion: 1,
        attemptId,
        originalAttemptId: effect.attemptId,
        baselineId,
        replayPolicy: 'reconcile-before-retry',
      },
    });
    let manifest: TrackingBaselineManifest;
    try {
      manifest = this.#captureAuxiliaryAttemptBaseline(
        effect.taskId,
        attemptId,
        baselineId,
        effect.requirementVersion,
      );
      this.#actions.markCompleted(baselineActionId, {
        result: {
          attemptId,
          originalAttemptId: effect.attemptId,
          baselineId,
          manifestChecksum: manifest.checksum,
        },
      });
    } catch (error) {
      this.#actions.markFailed(baselineActionId, {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const actionId = this.#nextId('action');
    const message = [
      'Format repair only.',
      `The final result for original attempt ${effect.attemptId} failed schema validation.`,
      firstFailure,
      'Do not repeat the task or modify files. Return one object matching schemas/agent-result.schema.json.',
    ].join('\n');
    this.#actions.recordIntent({
      actionId,
      taskId: effect.taskId,
      idempotencyKey: `${effect.taskId}:format-repair:${attemptId}`,
      type: 'format-repair',
      payload: {
        schemaVersion: 1,
        attemptId,
        originalAttemptId: effect.attemptId,
        baselineId,
        message,
        replayPolicy: 'never-auto-replay',
      },
    });
    const run = await this.#commandRunner.runPreparedAgent({
      actionId,
      taskId: effect.taskId,
      adapter,
      request: {
        attemptId,
        baselineId,
        requirementVersion: effect.requirementVersion,
        role: effect.role,
        projectRoot: this.#projectRoot,
        prompt: message,
      },
    });
    let parsed: AgentResultParseOutcome =
      run.runResult.status === 'succeeded' && run.runResult.output !== undefined
        ? parseAgentResult(run.runResult.output)
        : {
            success: false,
            reason:
              run.runResult.error
              ?? `format repair process ended with ${run.runResult.status}`,
          };
    const repairChanges = this.#diff.attemptWindow(baselineId);
    if (repairChanges.summary.total > 0) {
      parsed = {
        success: false,
        reason: 'format repair modified the project instead of only repairing the result',
      };
    }
    return {
      evidence: {
        originalAttemptId: effect.attemptId,
        attemptId,
        baselineId,
        firstFailure,
        run,
      },
      parsed,
    };
  }

  #captureAuxiliaryAttemptBaseline(
    taskId: TaskId,
    attemptId: AttemptId,
    baselineId: BaselineId,
    requirementVersion: number,
  ): TrackingBaselineManifest {
    const taskBaselineId = this.#resolveTaskBaselineId();
    const attemptNumber = Number(
      (
        this.#database.connection
          .prepare('SELECT COUNT(*) AS count FROM run_attempts WHERE task_id = ?')
          .get(taskId) as { readonly count: number }
      ).count,
    ) + 1;
    this.#attempts.create(
      taskId,
      createPendingRunAttempt({
        attemptId,
        baselineId,
        requirementVersion,
        startedAt: this.#now().toISOString(),
      }),
    );
    const manifest = this.#tracker.captureAttemptBaseline({
      taskId,
      baselineId,
      attemptId,
      attemptNumber,
      parentTaskBaselineId: taskBaselineId,
      createdAt: this.#now(),
    });
    this.#database.connection
      .prepare(
        `INSERT INTO file_baselines(
           id, task_id, attempt_id, status, manifest_json, created_at, completed_at
         ) VALUES (?, ?, ?, 'complete', ?, ?, ?)`,
      )
      .run(
        baselineId,
        taskId,
        attemptId,
        serializeJsonValue(manifest),
        manifest.createdAt,
        manifest.createdAt,
      );
    return manifest;
  }

  async #persistSecondParseFailure(
    effect: StartEffect,
    primary: PersistedAgentRun,
    repair: FormatRepairEvidence,
    secondFailure: string,
  ): Promise<void> {
    const changeSet = this.#diff.attemptWindow(effect.baselineId);
    const changeSetId = this.#nextId('change-set');
    this.#persistChangeSet(effect.attemptId, changeSetId, changeSet);
    const reason =
      `Second final-result parse failure after one format repair: ${secondFailure}`;
    const workflowEvent: WorkflowEvent = {
      type: 'RESULT_PARSE_FAILED',
      attemptId: effect.attemptId,
      reason,
    };
    const stageActionId = this.#nextId('action');
    this.#actions.recordIntent({
      actionId: stageActionId,
      taskId: effect.taskId,
      idempotencyKey: `${effect.taskId}:stage-result:${effect.attemptId}`,
      type: 'stage-result',
      payload: {
        schemaVersion: 1,
        attemptId: effect.attemptId,
        stage: effect.type,
        workflowEvent,
        safeToFeedForward: true,
      },
    });
    this.#actions.markFailed(stageActionId, {
      error: reason,
      result: {
        attemptId: effect.attemptId,
        repairAttemptId: repair.attemptId,
        firstFailure: repair.firstFailure,
        secondFailure,
        derivedEvidence: {
          changeSetId,
          baselineId: effect.baselineId,
          changedFiles: changeSet.changes.map((change) => change.path),
          commandRecords: [primary.commandRecord, repair.run.commandRecord],
          logReferences: [
            ...primary.logReferences,
            ...repair.run.logReferences,
          ],
          actionReferences: [
            { actionId: primary.actionId, attemptId: primary.attemptId },
            { actionId: repair.run.actionId, attemptId: repair.run.attemptId },
          ],
        },
        workflowEvent,
      },
    });
    await this.#hooks.afterReadyEventPersisted?.({
      actionId: stageActionId,
      attemptId: effect.attemptId,
      event: workflowEvent,
    });
    await this.#applyEvent(
      workflowEvent,
      {
        actionId: stageActionId,
        attemptId: effect.attemptId,
        relatedActions: [
          { actionId: primary.actionId, attemptId: primary.attemptId },
          { actionId: repair.run.actionId, attemptId: repair.run.attemptId },
        ],
      },
    );
  }

  async #persistStageResultAndApply(
    effect: StartEffect,
    run: PersistedAgentRun,
    parsedResult: AgentResult | undefined,
    changeSet: ChangeSet | undefined,
    workflowEvent: WorkflowEvent,
    repair?: FormatRepairEvidence,
  ): Promise<void> {
    const changeSetId = this.#nextId('change-set');
    const derivedFiles = changeSet?.changes.map((change) => change.path) ?? [];
    if (changeSet !== undefined) {
      this.#persistChangeSet(effect.attemptId, changeSetId, changeSet);
    }
    const evidenceRuns = repair === undefined ? [run] : [run, repair.run];
    const derivedEvidence: DerivedEvidence = {
      changeSetId,
      baselineId: effect.baselineId,
      changedFiles: derivedFiles,
      commandRecords: evidenceRuns.map((evidenceRun) => evidenceRun.commandRecord),
      logReferences: evidenceRuns.flatMap(
        (evidenceRun) => evidenceRun.logReferences,
      ),
      actionReferences: evidenceRuns.map((evidenceRun) => ({
        actionId: evidenceRun.actionId,
        attemptId: evidenceRun.attemptId,
      })),
    };
    const diagnostics = {
      changedFilesMismatch:
        parsedResult === undefined
        || !arraysEqual(parsedResult.changedFiles, derivedFiles),
      commandsMismatch:
        parsedResult === undefined || parsedResult.commandsRun.length > 0,
    };
    const stageActionId = this.#nextId('action');
    this.#actions.recordIntent({
      actionId: stageActionId,
      taskId: effect.taskId,
      idempotencyKey: `${effect.taskId}:stage-result:${effect.attemptId}`,
      type: 'stage-result',
      payload: {
        schemaVersion: 1,
        attemptId: effect.attemptId,
        stage: effect.type,
        workflowEvent,
        safeToFeedForward: true,
      },
    });
    this.#actions.markCompleted(stageActionId, {
      result: {
        attemptId: effect.attemptId,
        ...(parsedResult === undefined ? {} : { parsedResult }),
        ...(repair === undefined
          ? {}
          : {
              repairEvidence: {
                attemptId: repair.attemptId,
                originalAttemptId: repair.originalAttemptId,
                baselineId: repair.baselineId,
                firstFailure: repair.firstFailure,
              },
            }),
        derivedEvidence,
        diagnostics,
        workflowEvent,
      },
    });
    if (effect.type === 'StartPlanning' && parsedResult !== undefined) {
      this.#planAttemptId = effect.attemptId;
      this.#persistPlanResult(effect.attemptId, parsedResult, derivedEvidence);
    }
    if (
      (effect.type === 'StartReview' || effect.type === 'StartMasterValidation')
      && parsedResult !== undefined
    ) {
      this.#persistReview(effect, parsedResult, derivedEvidence, workflowEvent);
    }
    await this.#hooks.afterReadyEventPersisted?.({
      actionId: stageActionId,
      attemptId: effect.attemptId,
      event: workflowEvent,
    });
    await this.#applyEvent(
      workflowEvent,
      {
        actionId: stageActionId,
        attemptId: effect.attemptId,
        relatedActions: evidenceRuns.map((evidenceRun) => ({
          actionId: evidenceRun.actionId,
          attemptId: evidenceRun.attemptId,
        })),
      },
    );
  }

  #eventForResult(
    effect: StartEffect,
    result: AgentResult,
    changeSet: ChangeSet,
  ): WorkflowEvent {
    switch (effect.type) {
      case 'StartPlanning':
        if (
          result.status !== 'completed'
          || (result.nextAction !== 'approve_plan' && result.nextAction !== 'implement')
        ) {
          return {
            type: 'PLAN_FAILED',
            attemptId: effect.attemptId,
            reason: `planning returned explicit ${result.status}/${result.nextAction}`,
          };
        }
        if (this.#requiresPlanApproval) {
          return {
            type: 'PLAN_READY',
            requiresApproval: true,
            attemptId: effect.attemptId,
          };
        }
        return {
          type: 'PLAN_READY',
          requiresApproval: false,
          attemptId: effect.attemptId,
          implementationAttemptId: this.#nextAttemptId(),
          implementationBaselineId: this.#nextBaselineId(),
        };
      case 'StartImplementation':
        if (result.status !== 'completed' || result.nextAction !== 'review') {
          return {
            type: 'IMPLEMENTATION_FAILED',
            attemptId: effect.attemptId,
            reason: `implementation returned explicit ${result.status}/${result.nextAction}`,
          };
        }
        return {
          type: 'IMPLEMENTATION_COMPLETED',
          attemptId: effect.attemptId,
          reviewAttemptId: this.#nextAttemptId(),
          reviewBaselineId: this.#nextBaselineId(),
        };
      case 'StartReview':
        if (changeSet.summary.total > 0) {
          return {
            type: 'REVIEW_INVALIDATED',
            attemptId: effect.attemptId,
            reason: 'review baseline changed during the read-only review',
          };
        }
        // Isolated candidate path: machine-validated Codex verdict only.
        if (this.#usesIsolatedGrokImplementer()) {
          if (this.#lastCandidateEvidence === undefined) {
            return {
              type: 'REVIEW_FAILED',
              attemptId: effect.attemptId,
              reason: 'missing finalized candidate change-set for isolated review',
            };
          }
          // Candidate tree must still match the frozen manifest hash.
          const liveCandidateHash = this.#hashWorkspaceTree(
            this.#lastCandidateEvidence.candidateRoot,
          );
          if (liveCandidateHash !== this.#lastCandidateEvidence.candidateManifestHash) {
            return {
              type: 'REVIEW_INVALIDATED',
              attemptId: effect.attemptId,
              reason: 'candidate workspace changed during immutable review',
            };
          }
          const classified = classifyCandidateReviewResult(result);
          if (!classified.ok) {
            return {
              type: 'REVIEW_FAILED',
              attemptId: effect.attemptId,
              reason: classified.reason,
            };
          }
          if (classified.verdict === 'approve') {
            return {
              type: 'REVIEW_COMPLETED',
              attemptId: effect.attemptId,
              masterAttemptId: this.#nextAttemptId(),
              masterBaselineId: this.#nextBaselineId(),
            };
          }
          if (classified.verdict === 'rework') {
            return {
              type: 'REVIEW_REWORK_REQUESTED',
              attemptId: effect.attemptId,
              reason: reviewReason(result),
            };
          }
          return {
            type: 'REVIEW_FAILED',
            attemptId: effect.attemptId,
            reason: reviewReason(result),
          };
        }
        if (result.status === 'failed' || result.nextAction === 'await_user') {
          return {
            type: 'REVIEW_FAILED',
            attemptId: effect.attemptId,
            reason: reviewReason(result),
          };
        }
        if (result.nextAction !== 'master_validation') {
          return {
            type: 'REVIEW_FAILED',
            attemptId: effect.attemptId,
            reason: `review returned unsupported nextAction ${result.nextAction}`,
          };
        }
        return {
          type: 'REVIEW_COMPLETED',
          attemptId: effect.attemptId,
          masterAttemptId: this.#nextAttemptId(),
          masterBaselineId: this.#nextBaselineId(),
        };
      case 'StartMasterValidation':
        if (this.#usesIsolatedGrokImplementer() && this.#lastCandidateEvidence !== undefined) {
          const liveCandidateHash = this.#hashWorkspaceTree(
            this.#lastCandidateEvidence.candidateRoot,
          );
          if (liveCandidateHash !== this.#lastCandidateEvidence.candidateManifestHash) {
            return {
              type: 'MASTER_FAILED',
              attemptId: effect.attemptId,
              reason: 'candidate workspace changed during master validation',
            };
          }
        }
        if (
          result.status === 'completed'
          && result.nextAction === 'complete'
          && result.verification.passed
          && result.issues.length === 0
        ) {
          return { type: 'MASTER_APPROVED', attemptId: effect.attemptId };
        }
        if (
          result.status === 'needs_rework'
          || result.nextAction === 'rework'
          || !result.verification.passed
          || result.issues.length > 0
        ) {
          return {
            type: 'MASTER_REJECTED',
            attemptId: effect.attemptId,
            reason: reviewReason(result),
          };
        }
        return {
          type: 'MASTER_FAILED',
          attemptId: effect.attemptId,
          reason: `master returned explicit ${result.status}/${result.nextAction}`,
        };
    }
  }

  #failedEvent(effect: StartEffect, error: unknown): WorkflowEvent {
    const reason = error instanceof Error ? error.message : String(error);
    switch (effect.type) {
      case 'StartPlanning':
        return { type: 'PLAN_FAILED', attemptId: effect.attemptId, reason };
      case 'StartImplementation':
        return { type: 'IMPLEMENTATION_FAILED', attemptId: effect.attemptId, reason };
      case 'StartReview':
        return { type: 'REVIEW_FAILED', attemptId: effect.attemptId, reason };
      case 'StartMasterValidation':
        return { type: 'MASTER_FAILED', attemptId: effect.attemptId, reason };
    }
  }

  #persistChangeSet(
    attemptId: AttemptId,
    changeSetId: string,
    changeSet: ChangeSet,
  ): void {
    withTransaction(this.#database.connection, () => {
      for (const change of changeSet.changes) {
        const storedKind = change.kind === 'type-changed' || change.kind === 'renamed'
          ? 'modified'
          : change.kind;
        this.#database.connection
          .prepare(
            `INSERT INTO file_changes(
               baseline_id, path, change_kind, before_hash, after_hash, metadata_json
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            changeSet.baselineId,
            change.path,
            storedKind,
            change.before?.hash ?? null,
            change.after?.hash ?? null,
            serializeJsonValue({
              attemptId,
              changeSetId,
              originalKind: change.kind,
              fromPath: change.fromPath ?? null,
              binary: change.binary,
            }),
          );
      }
      this.#database.connection
        .prepare(
          'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          this.#taskDefinition.taskId,
          'CHANGE_SET_DERIVED',
          serializeJsonValue({ attemptId, changeSetId, changeSet }),
          this.#now().toISOString(),
        );
    });
  }

  #persistPlanResult(
    attemptId: AttemptId,
    plan: AgentResult,
    evidence: DerivedEvidence,
  ): void {
    const current = this.#requirementEnvelope();
    this.#database.connection
      .prepare(
        'UPDATE requirement_versions SET requirements = ? WHERE task_id = ? AND version = ?',
      )
      .run(
        serializeJsonValue({
          ...current,
          planVersion: this.#taskDefinition.requirementVersion,
          approved: false,
          planAttemptId: attemptId,
          plan,
          evidenceReferences: [
            ...evidence.actionReferences.map((reference) => ({
              type: 'action',
              ...reference,
            })),
            ...evidence.logReferences.map((reference) => ({
              type: 'log',
              ...reference,
            })),
          ],
        }),
        this.#taskDefinition.taskId,
        this.#taskDefinition.requirementVersion,
      );
  }

  #persistPlanApproval(implementationAttemptId: AttemptId): void {
    const current = this.#requirementEnvelope();
    const planAttemptId = typeof current.planAttemptId === 'string'
      ? asAttemptId(current.planAttemptId)
      : this.#planAttemptId;
    if (planAttemptId === undefined) {
      throw new Error('persisted plan has no planning attempt identity');
    }
    const approvedAt = this.#now().toISOString();
    withTransaction(this.#database.connection, () => {
      this.#database.connection
        .prepare(
          'UPDATE requirement_versions SET requirements = ? WHERE task_id = ? AND version = ?',
        )
        .run(
          serializeJsonValue({
            ...current,
            approved: true,
            approval: {
              attemptId: implementationAttemptId,
              planAttemptId,
              approvedAt,
            },
          }),
          this.#taskDefinition.taskId,
          this.#taskDefinition.requirementVersion,
        );
      this.#database.connection
        .prepare(
          'INSERT INTO events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)',
        )
        .run(
          this.#taskDefinition.taskId,
          'PLAN_APPROVAL_RECORDED',
          serializeJsonValue({
            attemptId: implementationAttemptId,
            planAttemptId,
            planVersion: this.#taskDefinition.requirementVersion,
            approvedAt,
          }),
          approvedAt,
        );
    });
  }

  #persistReview(
    effect: Extract<StartEffect, { readonly type: 'StartReview' | 'StartMasterValidation' }>,
    result: AgentResult,
    evidence: DerivedEvidence,
    event: WorkflowEvent,
  ): void {
    const verdict = event.type === 'REVIEW_COMPLETED' || event.type === 'MASTER_APPROVED'
      ? 'approved'
      : event.type === 'REVIEW_INVALIDATED'
        ? 'invalid'
        : event.type === 'REVIEW_FAILED' || event.type === 'MASTER_FAILED'
          ? 'failed'
          : 'rejected';
    this.#database.connection
      .prepare(
        `INSERT INTO reviews(
           id, task_id, attempt_id, reviewer_role, verdict, payload_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#nextId('review'),
        effect.taskId,
        effect.attemptId,
        effect.type === 'StartReview' ? 'reviewer' : 'master',
        verdict,
        serializeJsonValue({
          attemptId: effect.attemptId,
          result,
          evidence,
          workflowEvent: event,
        }),
        this.#now().toISOString(),
      );
  }

  #releaseProjectLock(prepared: PreparedEffect): void {
    if (prepared.reservedAttemptId === undefined) {
      this.#actions.markFailed(prepared.actionId, {
        error: 'project lock release has no master attempt evidence identity',
      });
      throw new Error('project lock release has no master attempt evidence identity');
    }
    const lockId = this.#lockId ?? this.#activeLockId();
    if (lockId === undefined) {
      this.#actions.markFailed(prepared.actionId, {
        error: 'active project lock is missing during release',
      });
      throw new Error('active project lock is missing during release');
    }
    const result = this.#lockService.release(
      lockId,
      this.#taskDefinition.taskId,
      this.#ownerInstanceId,
      this.#now(),
    );
    if (result.status !== 'released') {
      this.#actions.markFailed(prepared.actionId, {
        error: `project lock release failed: ${result.status}`,
        result,
      });
      throw new Error(`project lock release failed: ${result.status}`);
    }
    this.#actions.markCompleted(prepared.actionId, {
      result: {
        attemptId: prepared.reservedAttemptId,
        lockId,
        releasedAt: result.lock.releasedAt,
      },
    });
  }

  #activeLockId(): string | undefined {
    const row = this.#database.connection
      .prepare(
        'SELECT id FROM project_locks WHERE task_id = ? AND released_at IS NULL ORDER BY acquired_at DESC LIMIT 1',
      )
      .get(this.#taskDefinition.taskId) as { readonly id: string } | undefined;
    return row?.id;
  }

  #resolveTaskBaselineId(): string {
    if (this.#taskBaselineId !== undefined) return this.#taskBaselineId;
    const row = this.#database.connection
      .prepare(
        `SELECT json_extract(result_json, '$.taskBaselineId') AS taskBaselineId
         FROM pending_actions
         WHERE task_id = ? AND action_type = 'environment-check' AND status = 'completed'
         ORDER BY completed_at DESC LIMIT 1`,
      )
      .get(this.#taskDefinition.taskId) as
      | { readonly taskBaselineId: string | null }
      | undefined;
    if (row?.taskBaselineId !== null && row?.taskBaselineId !== undefined) {
      this.#taskBaselineId = row.taskBaselineId;
      return row.taskBaselineId;
    }
    const recovered = this.#database.connection
      .prepare(
        `SELECT json_extract(manifest_json, '$.parentTaskBaselineId') AS taskBaselineId
         FROM file_baselines
         WHERE task_id = ? AND status = 'complete'
           AND json_extract(manifest_json, '$.parentTaskBaselineId') IS NOT NULL
         ORDER BY completed_at DESC, created_at DESC LIMIT 1`,
      )
      .get(this.#taskDefinition.taskId) as
      | { readonly taskBaselineId: string | null }
      | undefined;
    if (
      recovered?.taskBaselineId === null ||
      recovered?.taskBaselineId === undefined ||
      recovered.taskBaselineId.trim().length === 0
    ) {
      throw new Error('task baseline evidence is missing');
    }
    this.#taskBaselineId = recovered.taskBaselineId;
    return recovered.taskBaselineId;
  }

  #requireBaseline(baselineId: string): TrackingBaselineManifest {
    const loaded = this.#tracker.loadBaseline(baselineId);
    if (loaded.status !== 'loaded') {
      throw new Error(`baseline is unavailable: ${loaded.diagnostic}`);
    }
    return loaded.manifest;
  }

  #requirementEnvelope(): Record<string, unknown> {
    const row = this.#database.connection
      .prepare(
        'SELECT requirements FROM requirement_versions WHERE task_id = ? AND version = ?',
      )
      .get(
        this.#taskDefinition.taskId,
        this.#taskDefinition.requirementVersion,
      ) as { readonly requirements: string } | undefined;
    if (row === undefined) throw new Error('requirement version is missing');
    const parsed = JSON.parse(row.requirements) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('requirement version payload is invalid');
    }
    return parsed as Record<string, unknown>;
  }

  #prompt(effect: StartEffect): string {
    const stage: StagePromptStage = (() => {
      switch (effect.type) {
        case 'StartPlanning':
          return 'planning';
        case 'StartImplementation':
          return 'implementation';
        case 'StartReview':
          return 'review';
        case 'StartMasterValidation':
          return 'master_validation';
      }
    })();
    const base = buildStagePrompt({
      stage,
      role: effect.role,
      attemptId: effect.attemptId,
      requirementVersion: effect.requirementVersion,
      projectRoot: this.#projectRoot,
      requirements: this.#requirements,
    });
    const notes = this.#getOperatorContext?.() ?? [];
    if (notes.length === 0) return base;
    return [
      base,
      '',
      '## Operator mid-run context (must honor)',
      'The operator interrupted or annotated this task. Treat the following as additional durable context for this stage:',
      ...notes.map((note, index) => `${String(index + 1)}. ${note}`),
    ].join('\n');
  }

  #nextAttemptId(): AttemptId {
    return asAttemptId(this.#nextId('attempt'));
  }

  #nextBaselineId(): BaselineId {
    return asBaselineId(this.#nextId('baseline'));
  }

  #nextId(kind: OrchestratorIdKind): string {
    const value = this.#idFactory(kind).trim();
    if (value === '') throw new Error(`idFactory returned an empty ${kind} ID`);
    return value;
  }
}
