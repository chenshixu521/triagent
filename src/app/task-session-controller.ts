import { AGENT_KINDS, createRoleAssignment, type RoleAssignment } from '../domain/task.js';
import type { PersistedTask } from '../persistence/task-repository.js';
import {
  canonicalizeProjectPath,
  type CanonicalProjectPath,
} from '../project/canonical-path.js';
import { detectProjectKind, type ProjectKind } from '../project/project-kind.js';
import type {
  ControllerDispatchResult,
  TuiIntent,
  TuiScreen,
  TuiSnapshot,
} from '../tui/store.js';
import { isTerminalState, type WorkflowSnapshot, type WorkflowState } from '../workflow/states.js';

export interface TaskRuntimePort {
  initialize(): void;
  currentTask(): PersistedTask;
  start(): Promise<WorkflowSnapshot>;
  approvePlan(): Promise<WorkflowSnapshot>;
  dispose(): Promise<void>;
}

export interface TaskRuntimeInput {
  readonly project: CanonicalProjectPath;
  readonly projectKind: ProjectKind;
  readonly requirements: string;
  readonly roles: RoleAssignment;
  readonly requiresPlanApproval: boolean;
  readonly ownerInstanceId: string;
}

export type TaskRuntimeFactory = (
  input: TaskRuntimeInput,
) => Promise<TaskRuntimePort> | TaskRuntimePort;

export interface TaskSessionControllerOptions {
  readonly ownerInstanceId: string;
  readonly createRuntime?: TaskRuntimeFactory;
}

interface SelectedProject {
  readonly project: CanonicalProjectPath;
  readonly projectKind: ProjectKind;
}

const PROCESS_STATES: ReadonlySet<WorkflowState> = new Set([
  'planning',
  'implementing',
  'reviewing',
  'master_validation',
  'interrupting',
  'cleanup_failed',
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

function taskSnapshot(
  task: PersistedTask,
  projectPath: string,
  roles: RoleAssignment,
): Partial<TuiSnapshot> {
  const state = task.workflowSnapshot.state;
  return {
    screen: screenForState(state),
    workflowState: state,
    taskId: task.taskId,
    projectPath,
    roles,
    processRunning: PROCESS_STATES.has(state),
    pauseAfterAttempt: task.workflowSnapshot.pauseAfterAttempt,
    reworkCount: task.workflowSnapshot.reworkCount,
    maxReworks: task.workflowSnapshot.maxReworks,
    canApprove: state === 'awaiting_plan_approval',
    canRework: state === 'reviewing' || state === 'master_validation',
    loading: false,
    empty: false,
    statusMessage: `Task ${state}`,
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
  #selectedProject: SelectedProject | undefined;
  #runtime: TaskRuntimePort | undefined;
  #roles: RoleAssignment | undefined;
  #runtimeDisposed = false;

  public constructor(options: TaskSessionControllerOptions) {
    if (options.ownerInstanceId.trim().length === 0) {
      throw new Error('ownerInstanceId must be non-empty');
    }
    this.#ownerInstanceId = options.ownerInstanceId;
    this.#createRuntime = options.createRuntime;
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
      default:
        return undefined;
    }
  }

  public exitGate(): { readonly allowed: boolean; readonly reason?: string } {
    if (this.#runtime === undefined) return { allowed: true };
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
    if (this.#runtime === undefined || this.#runtimeDisposed) return;
    this.#runtimeDisposed = true;
    await this.#runtime.dispose();
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
      await runtime.start();
      return {
        kind: 'snapshot',
        snapshot: taskSnapshot(
          runtime.currentTask(),
          this.#selectedProject.project.canonicalRoot,
          roles,
        ),
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
      await this.#runtime.approvePlan();
      return {
        kind: 'snapshot',
        snapshot: taskSnapshot(
          this.#runtime.currentTask(),
          this.#selectedProject!.project.canonicalRoot,
          this.#roles,
        ),
      };
    } catch (error) {
      return rejected(
        `plan approval failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #currentTask(): PersistedTask | undefined {
    if (this.#runtime === undefined) return undefined;
    return this.#runtime.currentTask();
  }
}

export function createTaskSessionController(
  options: TaskSessionControllerOptions,
): TaskSessionController {
  return new TaskSessionController(options);
}
