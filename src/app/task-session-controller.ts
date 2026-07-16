import { AGENT_KINDS, createRoleAssignment, type RoleAssignment } from '../domain/task.js';
import type { PersistedTask } from '../persistence/task-repository.js';
import {
  canonicalizeProjectPath,
  type CanonicalProjectPath,
} from '../project/canonical-path.js';
import { detectProjectKind, type ProjectKind } from '../project/project-kind.js';
import {
  formatAgentActivity,
  renderActivityLine,
  stageActivityMessage,
  type ActivityLine,
} from '../tui/activity-format.js';
import type {
  ControllerDispatchResult,
  LogBuckets,
  TuiIntent,
  TuiRecoveryAction,
  TuiScreen,
  TuiSnapshot,
} from '../tui/store.js';
import type { CommandRunnerAgentEventContext } from '../workflow/command-runner.js';
import { isTerminalState, type WorkflowSnapshot, type WorkflowState } from '../workflow/states.js';

export type TaskActivityListener = (line: ActivityLine) => void;

export interface TaskRuntimePort {
  initialize(): void;
  currentTask(): PersistedTask;
  start(): Promise<WorkflowSnapshot>;
  approvePlan(): Promise<WorkflowSnapshot>;
  dispose(): Promise<void>;
  /**
   * Same-task continue after operator interrupt hold.
   * Must keep the existing taskId (no recreate).
   */
  continueAfterOperatorHold?(): Promise<WorkflowSnapshot>;
  /** Optional: live agent/stage activity for the work-status feed. */
  setActivityListener?(listener: TaskActivityListener | undefined): void;
  /** Stop the active agent attempt (graceful then force). */
  requestStopActiveAttempt?(): Promise<void>;
  /**
   * Queue operator mid-run context for subsequent stage prompts.
   * May also attempt live mid-turn delivery when an agent handle is active.
   */
  queueContextMessage?(
    text: string,
  ):
    | void
    | Promise<{
        readonly delivery: 'live' | 'next_stage' | 'handle_queued';
        readonly detail?: string;
      }>;
  /** Snapshot of queued operator context (for UI / continue). */
  peekContextMessages?(): readonly string[];
}

export interface TaskRuntimeInput {
  readonly project: CanonicalProjectPath;
  readonly projectKind: ProjectKind;
  readonly requirements: string;
  readonly roles: RoleAssignment;
  readonly requiresPlanApproval: boolean;
  readonly ownerInstanceId: string;
  /** Live activity sink (wired by TaskSessionController). */
  readonly onActivity?: TaskActivityListener;
}

export type TaskRuntimeFactory = (
  input: TaskRuntimeInput,
) => Promise<TaskRuntimePort> | TaskRuntimePort;

/** Live UI updates while a long-running task drive is in progress. */
export type TaskProgressListener = (partial: Partial<TuiSnapshot>) => void;

export interface TaskSessionControllerOptions {
  readonly ownerInstanceId: string;
  readonly createRuntime?: TaskRuntimeFactory;
  readonly onProgress?: TaskProgressListener;
  /** Poll interval while an agent stage is running (ms). */
  readonly progressPollMs?: number;
}

interface SelectedProject {
  readonly project: CanonicalProjectPath;
  readonly projectKind: ProjectKind;
}

const PROCESS_STATES: ReadonlySet<WorkflowState> = new Set([
  'checking_environment',
  'planning',
  'implementing',
  'reviewing',
  'master_validation',
  'interrupting',
  'cleanup_failed',
]);

const ACTIVE_DRIVE_STATES: ReadonlySet<WorkflowState> = new Set([
  'checking_environment',
  'planning',
  'implementing',
  'reviewing',
  'master_validation',
  'interrupting',
]);

function screenForState(state: WorkflowState): TuiScreen {
  switch (state) {
    case 'draft':
      return 'new_task';
    case 'awaiting_plan_approval':
      return 'plan_approval';
    case 'interrupted_needs_inspection':
    case 'cleanup_failed':
    case 'awaiting_user':
    case 'failed':
      return 'recovery';
    case 'completed':
    case 'cancelled':
      return 'review';
    default:
      return 'run';
  }
}

function formatElapsed(startedAtMs: number, nowMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

function statusForState(state: WorkflowState): string {
  switch (state) {
    case 'checking_environment':
      return '正在检查环境与代理 CLI…';
    case 'planning':
      return '主控正在规划任务…';
    case 'awaiting_plan_approval':
      return '计划已生成，等待你确认';
    case 'implementing':
      return '实施代理正在修改代码…';
    case 'reviewing':
      return '审查代理正在独立审查…';
    case 'master_validation':
      return '主控正在终检…';
    case 'completed':
      return '任务已完成';
    case 'failed':
      return '任务失败';
    case 'cancelled':
      return '任务已取消';
    default:
      return stageActivityMessage(state).text;
  }
}

function emptyLogs(): LogBuckets {
  return {
    master: [],
    implementer: [],
    reviewer: [],
    system: [],
  };
}

function bucketForTag(
  tag: ActivityLine['tag'],
): keyof LogBuckets {
  switch (tag) {
    case 'master':
      return 'master';
    case 'impl':
      return 'implementer';
    case 'review':
      return 'reviewer';
    default:
      return 'system';
  }
}

function appendActivity(
  logs: LogBuckets,
  activityLines: readonly string[],
  entry: ActivityLine,
  maxLines: number,
): { readonly logs: LogBuckets; readonly activityLines: readonly string[] } {
  const bucket = bucketForTag(entry.tag);
  return {
    logs: {
      ...logs,
      [bucket]: [...logs[bucket], entry.line].slice(-maxLines),
    },
    activityLines: [...activityLines, entry.line].slice(-maxLines),
  };
}

function recoveryActionsForState(
  task: PersistedTask,
): readonly TuiRecoveryAction[] {
  const state = task.workflowSnapshot.state;
  if (state === 'interrupted_needs_inspection' || state === 'cleanup_failed') {
    return Object.freeze(['inspect', 'continue', 'cancel'] as const);
  }
  if (state === 'awaiting_user') {
    const allowed = task.workflowSnapshot.allowedAwaitingActions ?? [];
    const actions = (['continue', 'cancel'] as const).filter((action) =>
      allowed.includes(action),
    );
    return Object.freeze(actions);
  }
  return Object.freeze([] as const);
}

function taskSnapshot(
  task: PersistedTask,
  projectPath: string,
  roles: RoleAssignment,
  options: {
    readonly loading?: boolean;
    readonly logs?: LogBuckets;
    readonly activityLines?: readonly string[];
    readonly elapsedLabel?: string;
    readonly statusMessage?: string;
    /** Force run screen even while draft (optimistic submit). */
    readonly forceRunScreen?: boolean;
    readonly activeRole?: 'master' | 'implementer' | 'reviewer';
    readonly activeAdapter?: string;
    readonly executionScopeLabel?: string;
  } = {},
): Partial<TuiSnapshot> {
  const state = task.workflowSnapshot.state;
  const processRunning = PROCESS_STATES.has(state);
  const recoveryAllowedActions = recoveryActionsForState(task);
  return {
    screen: options.forceRunScreen ? 'run' : screenForState(state),
    workflowState: state,
    taskId: task.taskId,
    projectPath,
    roles,
    processRunning,
    pauseAfterAttempt: task.workflowSnapshot.pauseAfterAttempt,
    reworkCount: task.workflowSnapshot.reworkCount,
    maxReworks: task.workflowSnapshot.maxReworks,
    canApprove: state === 'awaiting_plan_approval',
    canRework: state === 'reviewing' || state === 'master_validation',
    loading: options.loading ?? processRunning,
    empty: false,
    statusMessage:
      options.statusMessage
      ?? statusForState(state),
    recoveryAllowedActions,
    ...(options.logs === undefined ? {} : { logs: options.logs }),
    ...(options.activityLines === undefined
      ? {}
      : { activityLines: options.activityLines }),
    ...(options.elapsedLabel === undefined
      ? {}
      : { elapsedLabel: options.elapsedLabel }),
    ...(options.activeRole === undefined ? {} : { activeRole: options.activeRole }),
    ...(options.activeAdapter === undefined
      ? {}
      : { activeAdapter: options.activeAdapter }),
    ...(options.executionScopeLabel === undefined
      ? {}
      : { executionScopeLabel: options.executionScopeLabel }),
  };
}

function rejected(reason: string): ControllerDispatchResult {
  return { kind: 'rejected', reason };
}

function validateRoleKinds(roles: RoleAssignment): void {
  for (const value of [roles.master, roles.implementer, roles.reviewer]) {
    if (!(AGENT_KINDS as readonly string[]).includes(value)) {
      throw new Error(`unsupported agent kind: ${String(value)}`);
    }
  }
}

export class TaskSessionController {
  readonly #ownerInstanceId: string;
  readonly #createRuntime: TaskRuntimeFactory | undefined;
  readonly #progressPollMs: number;
  #selectedProject: SelectedProject | undefined;
  #runtime: TaskRuntimePort | undefined;
  #roles: RoleAssignment | undefined;
  #runtimeDisposed = false;
  #onProgress: TaskProgressListener | undefined;
  #driveGeneration = 0;
  #startedAtMs: number | undefined;
  #lastObservedState: WorkflowState | undefined;
  #activityLogs: LogBuckets = emptyLogs();
  #activityLines: string[] = [];
  #drivePromise: Promise<void> | undefined;
  #activeRole: 'master' | 'implementer' | 'reviewer' | undefined;
  #activeAdapter: string | undefined;
  /** Operator interrupt hold — wait for [C] continue or [X] cancel. */
  #operatorHold = false;
  #pauseAfterRequested = false;
  #taskRequirements: string | undefined;
  #requiresPlanApproval = true;
  #contextMessages: string[] = [];

  public constructor(options: TaskSessionControllerOptions) {
    if (options.ownerInstanceId.trim().length === 0) {
      throw new Error('ownerInstanceId must be non-empty');
    }
    this.#ownerInstanceId = options.ownerInstanceId;
    this.#createRuntime = options.createRuntime;
    this.#onProgress = options.onProgress;
    this.#progressPollMs = options.progressPollMs ?? 400;
  }

  /** Wire live UI push after the TUI store exists. */
  public setProgressListener(listener: TaskProgressListener | undefined): void {
    this.#onProgress = listener;
  }

  public async dispatch(
    intent: TuiIntent,
  ): Promise<ControllerDispatchResult | undefined> {
    switch (intent.type) {
      case 'SELECT_PROJECT':
        return this.#selectProject(intent.projectPath);
      case 'CREATE_TASK':
        return this.#createTask(intent);
      case 'APPROVE':
        return this.#approvePlan();
      case 'REQUEST_CANCEL_OR_INTERRUPT':
        return this.#interrupt();
      case 'REQUEST_PAUSE_AFTER_RUN':
        return this.#requestPauseAfterRun();
      case 'QUEUE_MESSAGE':
        return this.#queueMessage(intent.text);
      case 'RECOVERY_INSPECT':
        return this.#recoveryInspect(intent.taskId);
      case 'RECOVERY_CONTINUE':
        return this.#recoveryContinue(intent.taskId);
      case 'RECOVERY_CANCEL':
        return this.#recoveryCancel(intent.taskId);
      default:
        return undefined;
    }
  }

  public exitGate(): { readonly allowed: boolean; readonly reason?: string } {
    if (this.#runtime === undefined) return { allowed: true };
    if (this.#operatorHold) {
      return {
        allowed: false,
        reason: 'exit blocked: task interrupted — press [C] continue or [X] cancel first',
      };
    }
    let task: PersistedTask;
    try {
      task = this.#runtime.currentTask();
    } catch (error) {
      return {
        allowed: false,
        reason: `exit blocked: active task state is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!isTerminalState(task.status)) {
      return {
        allowed: false,
        reason: `exit blocked: task ${task.taskId} is still ${task.status}`,
      };
    }
    return { allowed: true };
  }

  public async dispose(): Promise<void> {
    this.#driveGeneration += 1;
    if (this.#runtime === undefined || this.#runtimeDisposed) {
      this.#runtime = undefined;
      this.#roles = undefined;
      return;
    }
    this.#runtimeDisposed = true;
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#roles = undefined;
    await runtime.dispose();
  }

  async #selectProject(projectPath: string): Promise<ControllerDispatchResult> {
    const active = this.#currentTask();
    if (active !== undefined && !isTerminalState(active.status)) {
      return rejected(`cannot change project while task ${active.taskId} is ${active.status}`);
    }
    if (active !== undefined) {
      await this.dispose();
      this.#runtime = undefined;
      this.#roles = undefined;
      this.#runtimeDisposed = false;
    }

    try {
      const project = canonicalizeProjectPath(projectPath);
      const projectKind = detectProjectKind(project);
      this.#selectedProject = { project, projectKind };
      return {
        kind: 'snapshot',
        snapshot: {
          screen: 'new_task',
          workflowState: 'draft',
          projectPath: project.canonicalRoot,
          processRunning: false,
          canApprove: false,
          canRework: false,
          loading: false,
          empty: false,
          statusMessage: `Project selected (${projectKind.kind})`,
        },
      };
    } catch (error) {
      return rejected(
        `project selection failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #createTask(
    intent: Extract<TuiIntent, { readonly type: 'CREATE_TASK' }>,
  ): Promise<ControllerDispatchResult> {
    if (this.#selectedProject === undefined) {
      return rejected('select a project before creating a task');
    }
    if (intent.requirements.trim().length === 0) {
      return rejected('task requirements must be non-empty');
    }
    if (this.#createRuntime === undefined) {
      return rejected('task runtime is unavailable');
    }

    let roles: RoleAssignment;
    try {
      validateRoleKinds(intent.roles);
      roles = createRoleAssignment(intent.roles);
    } catch (error) {
      return rejected(error instanceof Error ? error.message : String(error));
    }

    const active = this.#currentTask();
    if (active !== undefined && !isTerminalState(active.status)) {
      return rejected(`task ${active.taskId} is already active in state ${active.status}`);
    }
    if (active !== undefined) {
      await this.dispose();
    }

    let runtime: TaskRuntimePort | undefined;
    try {
      runtime = await this.#createRuntime({
        project: this.#selectedProject.project,
        projectKind: this.#selectedProject.projectKind,
        requirements: intent.requirements.trim(),
        roles,
        requiresPlanApproval: intent.requiresPlanApproval,
        ownerInstanceId: this.#ownerInstanceId,
      });
      runtime.initialize();
      this.#runtime = runtime;
      this.#roles = roles;
      this.#runtimeDisposed = false;
      this.#startedAtMs = Date.now();
      this.#lastObservedState = undefined;
      this.#activityLogs = emptyLogs();
      this.#activityLines = [];
      this.#activeRole = undefined;
      this.#activeAdapter = undefined;
      this.#operatorHold = false;
      this.#pauseAfterRequested = false;
      this.#taskRequirements = intent.requirements.trim();
      this.#requiresPlanApproval = intent.requiresPlanApproval;
      this.#contextMessages = [];
      this.#pushActivity(renderActivityLine('system', '任务已提交，进入工作状态…'));
      this.#pushActivity(
        renderActivityLine(
          'system',
          `需求: ${intent.requirements.trim().slice(0, 120)}`,
        ),
      );

      // Live agent events → activity feed (design: tool/master/impl lines).
      const liveRuntime = runtime;
      liveRuntime.setActivityListener?.((entry) => {
        this.#pushActivity(entry);
        this.#publishLive(liveRuntime, roles);
      });

      const task = liveRuntime.currentTask();
      const initial = taskSnapshot(
        task,
        this.#selectedProject.project.canonicalRoot,
        roles,
        {
          loading: true,
          forceRunScreen: true,
          logs: this.#activityLogs,
          activityLines: this.#activityLines,
          elapsedLabel: '00:00',
          statusMessage: '正在启动工作流…',
        },
      );

      // Do not block the TUI on long agent stages — drive in the background
      // and push progress snapshots while AI work continues.
      this.#startBackgroundDrive(runtime, roles, 'start');

      return {
        kind: 'snapshot',
        snapshot: initial,
      };
    } catch (error) {
      if (runtime !== undefined && runtime !== this.#runtime) {
        await runtime.dispose().catch(() => undefined);
      }
      return rejected(
        `task creation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async #approvePlan(): Promise<ControllerDispatchResult> {
    if (this.#runtime === undefined || this.#roles === undefined) {
      return rejected('no active task is awaiting plan approval');
    }
    const current = this.#runtime.currentTask();
    if (current.status !== 'awaiting_plan_approval') {
      return rejected(`plan approval is not legal while task is ${current.status}`);
    }
    try {
      this.#pushActivity(renderActivityLine('stage', '用户已批准计划'));
      this.#pushActivity(renderActivityLine('stage', '计划已批准，继续实施…'));
      const immediate = taskSnapshot(
        current,
        this.#selectedProject!.project.canonicalRoot,
        this.#roles,
        {
          loading: true,
          forceRunScreen: true,
          logs: this.#activityLogs,
          activityLines: this.#activityLines,
          statusMessage: '计划已批准，正在继续…',
          elapsedLabel:
            this.#startedAtMs === undefined
              ? undefined
              : formatElapsed(this.#startedAtMs, Date.now()),
        },
      );
      this.#startBackgroundDrive(this.#runtime, this.#roles, 'approve');
      return {
        kind: 'snapshot',
        snapshot: immediate,
      };
    } catch (error) {
      return rejected(
        `plan approval failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #pushActivity(entry: ActivityLine): void {
    const next = appendActivity(
      this.#activityLogs,
      this.#activityLines,
      entry,
      80,
    );
    this.#activityLogs = next.logs;
    this.#activityLines = [...next.activityLines];
  }

  #holdSnapshot(
    task: PersistedTask | undefined,
    roles: RoleAssignment,
    statusMessage: string,
  ): Partial<TuiSnapshot> {
    return {
      screen: 'recovery',
      workflowState: task?.workflowSnapshot.state ?? 'awaiting_user',
      taskId: task?.taskId,
      projectPath: this.#selectedProject?.project.canonicalRoot,
      roles,
      processRunning: false,
      loading: false,
      canApprove: false,
      canRework: false,
      recoveryAllowedActions: Object.freeze(['inspect', 'continue', 'cancel'] as const),
      statusMessage,
      logs: this.#activityLogs,
      activityLines: this.#activityLines,
      elapsedLabel:
        this.#startedAtMs === undefined
          ? undefined
          : formatElapsed(this.#startedAtMs, Date.now()),
    };
  }

  async #interrupt(): Promise<ControllerDispatchResult> {
    if (this.#runtime === undefined || this.#roles === undefined) {
      return rejected('no active task to interrupt');
    }
    if (this.#operatorHold) {
      return {
        kind: 'snapshot',
        snapshot: this.#holdSnapshot(
          this.#safeTask(),
          this.#roles,
          '任务已处于中断等待 — [C] 继续 · [X] 取消',
        ),
      };
    }
    this.#operatorHold = true;
    this.#driveGeneration += 1;
    this.#pushActivity(renderActivityLine('system', '用户请求中断任务…'));
    try {
      await this.#runtime.requestStopActiveAttempt?.();
      this.#pushActivity(renderActivityLine('system', '已停止当前代理进程'));
    } catch (error) {
      this.#pushActivity(
        renderActivityLine(
          'system',
          `停止进程时出现问题: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
    this.#pushActivity(
      renderActivityLine('system', '上下文已保留 — [C] 继续 · [X] 取消 · [M] 可先追加说明'),
    );
    const snapshot = this.#holdSnapshot(
      this.#safeTask(),
      this.#roles,
      '任务已中断 — 上下文已保留。按 [C] 继续，[X] 取消',
    );
    this.#onProgress?.(snapshot);
    return { kind: 'snapshot', snapshot };
  }

  async #requestPauseAfterRun(): Promise<ControllerDispatchResult> {
    if (this.#runtime === undefined || this.#roles === undefined) {
      return rejected('no active task to pause');
    }
    this.#pauseAfterRequested = true;
    this.#pushActivity(
      renderActivityLine('stage', '已请求：当前阶段结束后暂停（可继续）'),
    );
    const partial = {
      pauseAfterAttempt: true,
      statusMessage: '当前阶段结束后暂停',
      logs: this.#activityLogs,
      activityLines: this.#activityLines,
    };
    this.#onProgress?.(partial);
    return { kind: 'snapshot', snapshot: partial };
  }

  async #queueMessage(text: string): Promise<ControllerDispatchResult> {
    const body = text.trim();
    if (body.length === 0) {
      return rejected('message text must be nonempty');
    }
    if (this.#runtime === undefined && !this.#operatorHold) {
      return rejected('no active task to receive context');
    }
    this.#contextMessages.push(body);
    let delivery: 'live' | 'next_stage' | 'handle_queued' = 'next_stage';
    let deliveryDetail: string | undefined;
    const queued = this.#runtime?.queueContextMessage?.(body);
    if (queued !== undefined && typeof (queued as Promise<unknown>).then === 'function') {
      const result = await queued;
      if (result !== undefined && typeof result === 'object' && 'delivery' in result) {
        delivery = result.delivery;
        deliveryDetail = result.detail;
      }
    }
    this.#pushActivity(renderActivityLine('system', `用户上下文: ${body.slice(0, 160)}`));
    if (delivery === 'live') {
      this.#pushActivity(
        renderActivityLine(
          'stage',
          `上下文已实时投递到当前代理${deliveryDetail === undefined ? '' : `（${deliveryDetail}）`}`,
        ),
      );
    } else if (delivery === 'handle_queued') {
      this.#pushActivity(
        renderActivityLine(
          'stage',
          '当前代理无实时输入能力：已入队会话侧，并将注入后续阶段提示词',
        ),
      );
    } else {
      this.#pushActivity(
        renderActivityLine('stage', '上下文已入队，将注入后续阶段提示词'),
      );
    }
    const partial: Partial<TuiSnapshot> = {
      statusMessage:
        delivery === 'live' ? '上下文已实时投递' : '上下文消息已入队',
      logs: this.#activityLogs,
      activityLines: this.#activityLines,
    };
    this.#onProgress?.(partial);
    return { kind: 'snapshot', snapshot: partial };
  }

  async #recoveryInspect(taskId: string): Promise<ControllerDispatchResult | undefined> {
    if (!this.#operatorHold || this.#roles === undefined) return undefined;
    const task = this.#safeTask();
    if (task !== undefined && task.taskId !== taskId) return undefined;
    this.#pushActivity(renderActivityLine('system', '检查中断现场…'));
    for (const note of this.#contextMessages) {
      this.#pushActivity(renderActivityLine('system', `已保留上下文: ${note.slice(0, 120)}`));
    }
    const snapshot = this.#holdSnapshot(
      task,
      this.#roles,
      '检查完成 — 上下文仍在。按 [C] 继续或 [X] 取消',
    );
    this.#onProgress?.(snapshot);
    return { kind: 'snapshot', snapshot };
  }

  async #recoveryContinue(taskId: string): Promise<ControllerDispatchResult | undefined> {
    if (this.#roles === undefined || this.#selectedProject === undefined) {
      return undefined;
    }

    // Live agent-fail park (awaiting_user with continue) is not an interrupt hold,
    // but still belongs to this session — handle [C] here instead of restart recovery.
    if (!this.#operatorHold) {
      const parked = this.#safeTask();
      if (
        parked === undefined
        || parked.taskId !== taskId
        || parked.status !== 'awaiting_user'
        || !parked.workflowSnapshot.allowedAwaitingActions?.includes('continue')
        || this.#runtime === undefined
        || this.#runtimeDisposed
        || this.#runtime.continueAfterOperatorHold === undefined
      ) {
        return undefined;
      }
      this.#pushActivity(
        renderActivityLine(
          'stage',
          `同任务继续 ${parked.taskId}（awaiting_user → ${
            parked.workflowSnapshot.resumeTargetState ?? 'resume'
          }）`,
        ),
      );
      this.#startBackgroundDrive(this.#runtime, this.#roles, 'continue');
      const snap = {
        screen: 'run' as const,
        loading: true,
        processRunning: true,
        taskId: parked.taskId,
        workflowState: parked.status,
        recoveryAllowedActions: Object.freeze([] as const),
        statusMessage: `已继续 — 同任务 ${parked.taskId} 恢复中`,
        logs: this.#activityLogs,
        activityLines: this.#activityLines,
      };
      this.#onProgress?.(snap);
      return { kind: 'snapshot', snapshot: snap };
    }

    const task = this.#safeTask();
    if (task !== undefined && task.taskId !== taskId) return undefined;

    this.#operatorHold = false;
    this.#pushActivity(renderActivityLine('stage', '用户选择继续 — 同任务恢复（携带上下文）'));
    if (this.#contextMessages.length > 0) {
      this.#pushActivity(
        renderActivityLine(
          'system',
          `将注入 ${String(this.#contextMessages.length)} 条操作者上下文`,
        ),
      );
    }

    // Let the interrupted drive finish settling workflow state (failed/inspection).
    if (this.#drivePromise !== undefined) {
      await Promise.race([
        this.#drivePromise.catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 15_000);
        }),
      ]);
    }

    // Last resort only: runtime truly gone (dispose / crash of session shell).
    if (this.#runtime === undefined || this.#runtimeDisposed) {
      this.#pushActivity(
        renderActivityLine(
          'system',
          '运行时已丢失 — 无法同任务续跑，将用保留上下文新建任务',
        ),
      );
      return this.#recreateAndStartAfterContinue();
    }

    const runtime = this.#runtime;
    let current: PersistedTask;
    try {
      current = runtime.currentTask();
    } catch (error) {
      this.#pushActivity(
        renderActivityLine(
          'system',
          `读取任务失败: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return this.#recreateAndStartAfterContinue();
    }

    if (current.taskId !== taskId) {
      return rejected(`continue task id mismatch: expected ${taskId}, got ${current.taskId}`);
    }

    if (isTerminalState(current.status)) {
      return rejected(
        `cannot continue terminal task ${current.taskId} in state ${current.status}`,
      );
    }

    // Plan already ready — stay on same task, show approval UI.
    if (current.status === 'awaiting_plan_approval') {
      const snap = taskSnapshot(
        current,
        this.#selectedProject.project.canonicalRoot,
        this.#roles,
        {
          logs: this.#activityLogs,
          activityLines: this.#activityLines,
          statusMessage: '继续：等待计划确认（同一任务）',
          elapsedLabel:
            this.#startedAtMs === undefined
              ? undefined
              : formatElapsed(this.#startedAtMs, Date.now()),
        },
      );
      this.#onProgress?.(snap);
      return { kind: 'snapshot', snapshot: snap };
    }

    // Preferred path: same runtime + same taskId.
    if (runtime.continueAfterOperatorHold !== undefined) {
      this.#pushActivity(
        renderActivityLine(
          'stage',
          `同任务继续 ${current.taskId}（状态 ${current.status}）`,
        ),
      );
      this.#startBackgroundDrive(runtime, this.#roles, 'continue');
    } else if (current.status === 'draft') {
      this.#startBackgroundDrive(runtime, this.#roles, 'start');
    } else {
      this.#pushActivity(
        renderActivityLine(
          'system',
          '运行时不支持同任务继续 — 回退为新建任务',
        ),
      );
      return this.#recreateAndStartAfterContinue();
    }

    const snap = {
      screen: 'run' as const,
      loading: true,
      processRunning: true,
      taskId: current.taskId,
      workflowState: current.status,
      recoveryAllowedActions: Object.freeze([] as const),
      statusMessage: `已继续 — 同任务 ${current.taskId} 恢复中`,
      logs: this.#activityLogs,
      activityLines: this.#activityLines,
    };
    this.#onProgress?.(snap);
    return { kind: 'snapshot', snapshot: snap };
  }

  async #recreateAndStartAfterContinue(): Promise<ControllerDispatchResult> {
    if (
      this.#selectedProject === undefined
      || this.#roles === undefined
      || this.#createRuntime === undefined
      || this.#taskRequirements === undefined
    ) {
      return rejected('cannot continue: session context is incomplete');
    }
    if (this.#runtime !== undefined) {
      await this.dispose().catch(() => undefined);
      this.#runtimeDisposed = false;
    }
    const contextBlock =
      this.#contextMessages.length === 0
        ? ''
        : `\n\n## Operator mid-run context\n${this.#contextMessages
            .map((note, index) => `${String(index + 1)}. ${note}`)
            .join('\n')}`;
    const requirements = `${this.#taskRequirements}${contextBlock}`;
    const runtime = await this.#createRuntime({
      project: this.#selectedProject.project,
      projectKind: this.#selectedProject.projectKind,
      requirements,
      roles: this.#roles,
      requiresPlanApproval: this.#requiresPlanApproval,
      ownerInstanceId: this.#ownerInstanceId,
    });
    runtime.initialize();
    for (const note of this.#contextMessages) {
      runtime.queueContextMessage?.(note);
    }
    this.#runtime = runtime;
    this.#runtimeDisposed = false;
    runtime.setActivityListener?.((entry) => {
      this.#pushActivity(entry);
      this.#publishLive(runtime, this.#roles!);
    });
    this.#startBackgroundDrive(runtime, this.#roles, 'start');
    const task = runtime.currentTask();
    const snap = taskSnapshot(
      task,
      this.#selectedProject.project.canonicalRoot,
      this.#roles,
      {
        loading: true,
        forceRunScreen: true,
        logs: this.#activityLogs,
        activityLines: this.#activityLines,
        statusMessage: '已继续 — 运行时丢失后新建任务（保留上下文）',
        elapsedLabel:
          this.#startedAtMs === undefined
            ? undefined
            : formatElapsed(this.#startedAtMs, Date.now()),
      },
    );
    this.#onProgress?.(snap);
    return { kind: 'snapshot', snapshot: snap };
  }

  async #recoveryCancel(taskId: string): Promise<ControllerDispatchResult | undefined> {
    if (this.#roles === undefined) return undefined;
    const task = this.#safeTask();
    if (task !== undefined && task.taskId !== taskId) return undefined;

    // Live awaiting_user cancel (agent-fail park) without interrupt hold.
    if (
      !this.#operatorHold
      && (
        task === undefined
        || task.status !== 'awaiting_user'
        || !task.workflowSnapshot.allowedAwaitingActions?.includes('cancel')
        || this.#runtime === undefined
      )
    ) {
      return undefined;
    }
    if (!this.#operatorHold && task === undefined) {
      return undefined;
    }

    this.#operatorHold = false;
    this.#driveGeneration += 1;
    this.#pushActivity(renderActivityLine('system', '用户取消了已中断的任务'));
    await this.dispose().catch(() => undefined);
    this.#runtime = undefined;
    this.#runtimeDisposed = false;
    const snapshot: Partial<TuiSnapshot> = {
      screen: 'review',
      workflowState: 'cancelled',
      processRunning: false,
      loading: false,
      canApprove: false,
      canRework: false,
      recoveryAllowedActions: Object.freeze([] as const),
      statusMessage: '任务已取消',
      logs: this.#activityLogs,
      activityLines: this.#activityLines,
      taskId,
      roles: this.#roles,
      projectPath: this.#selectedProject?.project.canonicalRoot,
    };
    this.#onProgress?.(snapshot);
    return { kind: 'snapshot', snapshot };
  }

  #safeTask(): PersistedTask | undefined {
    if (this.#runtime === undefined) return undefined;
    try {
      return this.#runtime.currentTask();
    } catch {
      return undefined;
    }
  }

  #publishLive(runtime: TaskRuntimePort, roles: RoleAssignment): void {
    if (this.#runtime !== runtime || this.#selectedProject === undefined) return;
    if (this.#operatorHold) return;
    let task: PersistedTask;
    try {
      task = runtime.currentTask();
    } catch {
      return;
    }
    const state = task.workflowSnapshot.state;
    if (state !== this.#lastObservedState) {
      this.#lastObservedState = state;
      this.#pushActivity(stageActivityMessage(state));
      if (state === 'planning' || state === 'master_validation') {
        this.#activeRole = 'master';
        this.#activeAdapter = roles.master;
      } else if (state === 'implementing') {
        this.#activeRole = 'implementer';
        this.#activeAdapter = roles.implementer;
      } else if (state === 'reviewing') {
        this.#activeRole = 'reviewer';
        this.#activeAdapter = roles.reviewer;
      }
      // Soft pause-after-run: park on recovery when a stage settles and pause was requested.
      if (
        this.#pauseAfterRequested
        && (
          state === 'awaiting_plan_approval'
          || state === 'paused_after_run'
          || state === 'completed'
        )
      ) {
        this.#operatorHold = true;
        this.#pauseAfterRequested = false;
        this.#pushActivity(
          renderActivityLine('stage', '已按请求暂停 — [C] 继续 · [X] 取消'),
        );
        const hold = this.#holdSnapshot(
          task,
          roles,
          '阶段后暂停 — 上下文已保留。按 [C] 继续',
        );
        this.#onProgress?.(hold);
        return;
      }
    }
    const partial = taskSnapshot(
      task,
      this.#selectedProject.project.canonicalRoot,
      roles,
      {
        loading: ACTIVE_DRIVE_STATES.has(state),
        logs: this.#activityLogs,
        activityLines: this.#activityLines,
        elapsedLabel:
          this.#startedAtMs === undefined
            ? undefined
            : formatElapsed(this.#startedAtMs, Date.now()),
        activeRole: this.#activeRole,
        activeAdapter: this.#activeAdapter,
        executionScopeLabel:
          this.#activeRole === 'implementer' && roles.implementer === 'grok'
            ? '候选工作区'
            : '项目目录',
      },
    );
    this.#onProgress?.(partial);
  }

  #startBackgroundDrive(
    runtime: TaskRuntimePort,
    roles: RoleAssignment,
    mode: 'start' | 'approve' | 'continue',
  ): void {
    const generation = ++this.#driveGeneration;

    const publish = (): void => {
      if (generation !== this.#driveGeneration) return;
      this.#publishLive(runtime, roles);
    };

    const poll = setInterval(() => {
      publish();
    }, this.#progressPollMs);
    poll.unref?.();

    const run = async (): Promise<void> => {
      try {
        if (mode === 'start') {
          await runtime.start();
        } else if (mode === 'approve') {
          await runtime.approvePlan();
        } else {
          if (runtime.continueAfterOperatorHold === undefined) {
            throw new Error('runtime does not support same-task continue');
          }
          await runtime.continueAfterOperatorHold();
        }
        publish();
      } catch (error) {
        if (generation !== this.#driveGeneration) {
          // Drive superseded (interrupt) — if holding, keep recovery UI.
          if (this.#operatorHold && this.#roles !== undefined) {
            const hold = this.#holdSnapshot(
              this.#safeTask(),
              this.#roles,
              '任务已中断 — 上下文已保留。按 [C] 继续，[X] 取消',
            );
            this.#onProgress?.(hold);
          }
          return;
        }
        if (this.#operatorHold) {
          this.#pushActivity(
            renderActivityLine('system', '中断后代理已停止 — 可继续或取消'),
          );
          if (this.#roles !== undefined) {
            const hold = this.#holdSnapshot(
              this.#safeTask(),
              this.#roles,
              '任务已中断 — 上下文已保留。按 [C] 继续，[X] 取消',
            );
            this.#onProgress?.(hold);
          }
          return;
        }
        const message =
          error instanceof Error ? error.message : String(error);
        this.#pushActivity(renderActivityLine('system', `错误: ${message}`));
        this.#onProgress?.({
          loading: false,
          processRunning: false,
          error: message,
          statusMessage: message,
          logs: this.#activityLogs,
          activityLines: this.#activityLines,
          elapsedLabel:
            this.#startedAtMs === undefined
              ? undefined
              : formatElapsed(this.#startedAtMs, Date.now()),
        });
      } finally {
        clearInterval(poll);
        if (generation === this.#driveGeneration && !this.#operatorHold) {
          publish();
        }
      }
    };

    this.#drivePromise = run();
  }

  #currentTask(): PersistedTask | undefined {
    if (this.#runtime === undefined) return undefined;
    return this.#runtime.currentTask();
  }
}

/** Exported for production runtime wiring of agent events → activity lines. */
export function activityFromAgentEvent(
  context: CommandRunnerAgentEventContext,
): ActivityLine | undefined {
  return formatAgentActivity({
    role: context.role,
    adapterKind: context.adapterKind,
    event: context.event,
  });
}

export function createTaskSessionController(
  options: TaskSessionControllerOptions,
): TaskSessionController {
  return new TaskSessionController(options);
}
