import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentAdapter } from '../agents/agent-adapter.js';
import { ClaudeAdapter } from '../agents/claude/claude-adapter.js';
import { CodexAdapter } from '../agents/codex/codex-adapter.js';
import { GrokAdapter } from '../agents/grok/grok-adapter.js';
import { CommandProbe } from '../agents/health/command-probe.js';
import { LaunchAuthorizationRepository } from '../agents/launch-authorization-repository.js';
import { BudgetClock } from '../budget/budget-clock.js';
import { BudgetController } from '../budget/budget-controller.js';
import type { AppPaths } from '../config/app-paths.js';
import {
  settingsToBudgetLimits,
  type AppSettings,
} from '../config/settings.js';
import { asAttemptId, asTaskId, type TaskId } from '../domain/ids.js';
import {
  AGENT_KINDS,
  createRoleAssignment,
  type AgentKind,
  type AgentRole,
  type RoleAssignment,
} from '../domain/task.js';
import { JsonlLog } from '../logging/jsonl-log.js';
import { AgentSessionRepository } from '../persistence/agent-session-repository.js';
import type { ReadWriteDatabase } from '../persistence/database.js';
import { parseJsonValue } from '../persistence/json-value.js';
import type { ProcessSupervisorPort } from '../process/process-supervisor-port.js';
import { GitBaselineService } from '../tracking/git-baseline-service.js';
import { NonGitBaselineService } from '../tracking/non-git-baseline-service.js';
import type { BaselineTrackerPort } from '../tracking/tracking-port.js';
import {
  TaskOrchestrator,
  type PreparedWorkflowEffectIntent,
} from '../workflow/task-orchestrator.js';
import { SafeAgentLaunchCoordinator } from './safe-agent-launch-coordinator.js';
import {
  formatAgentActivity,
  renderActivityLine,
} from '../tui/activity-format.js';
import type {
  TaskActivityListener,
  TaskRuntimeFactory,
  TaskRuntimeInput,
  TaskRuntimePort,
} from './task-session-controller.js';

export interface ProductionTaskAdapterFactoryInput {
  readonly supervisor: ProcessSupervisorPort;
  readonly healthProbe: CommandProbe;
  readonly launchAuthorization: LaunchAuthorizationRepository;
  readonly agentSessions: AgentSessionRepository;
  readonly settings: AppSettings;
  readonly projectRoot: string;
  readonly probeDirectory: string;
}

export type ProductionTaskAdapterFactory = (
  input: ProductionTaskAdapterFactoryInput,
) => Readonly<Record<AgentKind, AgentAdapter>>;

export interface ProductionTaskRuntimeFactoryOptions {
  readonly database: ReadWriteDatabase;
  readonly paths: AppPaths;
  readonly supervisor: ProcessSupervisorPort;
  readonly getSettings: () => AppSettings;
  readonly now?: () => Date;
  readonly createAdapters?: ProductionTaskAdapterFactory;
}

export interface ProductionRecoveryEffectExecutionInput {
  readonly taskId: TaskId;
  readonly tracker: BaselineTrackerPort;
  readonly nonGit: boolean;
  readonly ownerInstanceId: string;
  readonly effects: readonly PreparedWorkflowEffectIntent[];
}

interface PersistedRecoveryTaskInput {
  readonly projectId: string;
  readonly projectRoot: string;
  readonly requirementVersion: number;
  readonly requirements: string;
  readonly roles: RoleAssignment;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireAgentKind(value: unknown, label: string): AgentKind {
  if (
    typeof value !== 'string' ||
    !(AGENT_KINDS as readonly string[]).includes(value)
  ) {
    throw new Error(`${label} is not a supported agent kind`);
  }
  return value as AgentKind;
}

function loadPersistedRecoveryTask(
  database: ReadWriteDatabase,
  taskId: TaskId,
): PersistedRecoveryTaskInput {
  const task = database.connection
    .prepare(
      `SELECT tasks.project_id AS projectId, projects.root_path AS projectRoot
       FROM tasks JOIN projects ON projects.id = tasks.project_id
       WHERE tasks.id = ?`,
    )
    .get(taskId) as
    | { readonly projectId: string; readonly projectRoot: string }
    | undefined;
  if (task === undefined) throw new Error(`recovery task not found: ${taskId}`);
  const requirement = database.connection
    .prepare(
      `SELECT version, requirements
       FROM requirement_versions
       WHERE task_id = ? ORDER BY version DESC LIMIT 1`,
    )
    .get(taskId) as
    | { readonly version: number; readonly requirements: string }
    | undefined;
  if (requirement === undefined) {
    throw new Error(`recovery requirement version not found: ${taskId}`);
  }
  if (!Number.isSafeInteger(requirement.version) || requirement.version < 1) {
    throw new Error('recovery requirement version is invalid');
  }
  const payload = requireRecord(
    parseJsonValue(requirement.requirements, 'recovery requirements'),
    'recovery requirements',
  );
  if (typeof payload.requirements !== 'string' || payload.requirements.trim().length === 0) {
    throw new Error('recovery requirements text is missing');
  }
  const persistedRoles = requireRecord(payload.roles, 'recovery roles');
  const roles = createRoleAssignment({
    master: requireAgentKind(persistedRoles.master, 'recovery master role'),
    implementer: requireAgentKind(
      persistedRoles.implementer,
      'recovery implementer role',
    ),
    reviewer: requireAgentKind(persistedRoles.reviewer, 'recovery reviewer role'),
  });
  return {
    projectId: task.projectId,
    projectRoot: task.projectRoot,
    requirementVersion: requirement.version,
    requirements: payload.requirements.trim(),
    roles,
  };
}

function createDefaultAdapters(
  input: ProductionTaskAdapterFactoryInput,
): Readonly<Record<AgentKind, AgentAdapter>> {
  return Object.freeze({
    codex: new CodexAdapter({
      supervisor: input.supervisor,
      launchAuthorization: input.launchAuthorization,
      healthProbe: input.healthProbe,
      executable: input.settings.codexCliPath,
    }),
    claude: new ClaudeAdapter({
      supervisor: input.supervisor,
      launchAuthorization: input.launchAuthorization,
      agentSessions: input.agentSessions,
      healthProbe: input.healthProbe,
      executable: input.settings.claudeCliPath,
    }),
    grok: new GrokAdapter({
      supervisor: input.supervisor,
      launchAuthorization: input.launchAuthorization,
      agentSessions: input.agentSessions,
      healthProbe: input.healthProbe,
      executable: input.settings.grokCliPath,
    }),
  });
}

function adapterAssignments(
  adapters: Readonly<Record<AgentKind, AgentAdapter>>,
  roles: TaskRuntimeInput['roles'],
): Readonly<Record<AgentRole, AgentAdapter>> {
  return Object.freeze({
    master: adapters[roles.master],
    implementer: adapters[roles.implementer],
    reviewer: adapters[roles.reviewer],
  });
}

/**
 * BudgetController requires the task row to exist, while TaskOrchestrator owns
 * creating that row in initialize(). Delay construction until the first launch
 * gate access, which always happens after initialize().
 */
function lazyBudgetController(factory: () => BudgetController): BudgetController {
  let controller: BudgetController | undefined;
  const get = (): BudgetController => {
    controller ??= factory();
    return controller;
  };
  return new Proxy({} as BudgetController, {
    get(_target, property) {
      const instance = get();
      const value = Reflect.get(instance, property);
      return typeof value === 'function' ? value.bind(instance) : value;
    },
  });
}

export async function executeProductionRecoveryEffects(
  options: ProductionTaskRuntimeFactoryOptions,
  input: ProductionRecoveryEffectExecutionInput,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const createAdapters = options.createAdapters ?? createDefaultAdapters;
  const persisted = loadPersistedRecoveryTask(options.database, input.taskId);
  if (persisted.projectRoot !== input.tracker.projectRoot) {
    throw new Error('recovery tracker project root does not match the persisted task');
  }
  const settings = options.getSettings();
  const probeDirectory = mkdtempSync(join(tmpdir(), 'triagent-recovery-probe-'));
  let log: JsonlLog | undefined;
  try {
    log = await JsonlLog.open({
      directory: options.paths.logsDirectory,
      fileName: `recovery-${randomUUID()}.jsonl`,
      database: options.database.connection,
      projectRoot: persisted.projectRoot,
      clock: now,
    });
    const healthProbe = new CommandProbe({
      cwd: probeDirectory,
      supervisor: options.supervisor,
      timeoutMs: 5_000,
    });
    const launchAuthorization = new LaunchAuthorizationRepository(
      options.database.connection,
    );
    const agentSessions = new AgentSessionRepository(options.database.connection);
    const adaptersByKind = createAdapters({
      supervisor: options.supervisor,
      healthProbe,
      launchAuthorization,
      agentSessions,
      settings,
      projectRoot: persisted.projectRoot,
      probeDirectory,
    });
    for (const kind of AGENT_KINDS) {
      if (adaptersByKind[kind]?.kind !== kind) {
        throw new Error(`task adapter factory returned an invalid ${kind} adapter`);
      }
    }
    const budget = new BudgetController({
      database: options.database.connection,
      clock: new BudgetClock({
        now: () => now().toISOString(),
        schedule: (afterMs, action) => {
          const timer = setTimeout(action, afterMs);
          timer.unref?.();
        },
      }),
      supervisor: options.supervisor,
      taskId: input.taskId,
      limits: settingsToBudgetLimits(settings),
    });
    const launchPreparer = new SafeAgentLaunchCoordinator({
      database: options.database,
      projectRoot: persisted.projectRoot,
      nonGit: input.nonGit,
      now,
    });
    const orchestrator = new TaskOrchestrator({
      database: options.database,
      taskDefinition: {
        taskId: input.taskId,
        requirementVersion: persisted.requirementVersion,
        roles: persisted.roles,
      },
      projectId: persisted.projectId,
      projectRoot: persisted.projectRoot,
      requirements: persisted.requirements,
      tracker: input.tracker,
      adapters: adapterAssignments(adaptersByKind, persisted.roles),
      log,
      ownerInstanceId: input.ownerInstanceId,
      requiresPlanApproval: true,
      now,
      budget,
      launchPreparer,
      implementationWorkspacesDirectory:
        options.paths.implementationWorkspacesDirectory,
      processSupervisor: options.supervisor,
      cleanupGracePeriodMs: 1_000,
    });
    await orchestrator.executePreparedEffects(input.effects);
  } finally {
    if (log !== undefined) await log.close().catch(() => undefined);
    rmSync(probeDirectory, { recursive: true, force: true });
  }
}

class ProductionTaskRuntime implements TaskRuntimePort {
  readonly #orchestrator: TaskOrchestrator;
  readonly #log: JsonlLog;
  readonly #probeDirectory: string;
  readonly #supervisor: ProcessSupervisorPort;
  readonly #contextMessages: string[] = [];
  #disposed = false;
  #activityListener: TaskActivityListener | undefined;

  public constructor(input: {
    readonly orchestrator: TaskOrchestrator;
    readonly log: JsonlLog;
    readonly probeDirectory: string;
    readonly supervisor: ProcessSupervisorPort;
    readonly onActivity?: TaskActivityListener;
  }) {
    this.#orchestrator = input.orchestrator;
    this.#log = input.log;
    this.#probeDirectory = input.probeDirectory;
    this.#supervisor = input.supervisor;
    this.#activityListener = input.onActivity;
  }

  public initialize(): void {
    this.#orchestrator.initialize();
  }

  public currentTask(): ReturnType<TaskOrchestrator['currentTask']> {
    return this.#orchestrator.currentTask();
  }

  public start(): ReturnType<TaskOrchestrator['start']> {
    return this.#orchestrator.start();
  }

  public approvePlan(): ReturnType<TaskOrchestrator['approvePlan']> {
    return this.#orchestrator.approvePlan();
  }

  public continueAfterOperatorHold(): ReturnType<
    TaskOrchestrator['continueAfterOperatorHold']
  > {
    return this.#orchestrator.continueAfterOperatorHold();
  }

  public setActivityListener(listener: TaskActivityListener | undefined): void {
    this.#activityListener = listener;
  }

  public queueContextMessage(text: string): void {
    const body = text.trim();
    if (body.length === 0) return;
    this.#contextMessages.push(body);
  }

  public peekContextMessages(): readonly string[] {
    return Object.freeze([...this.#contextMessages]);
  }

  public getOperatorContext(): readonly string[] {
    return this.peekContextMessages();
  }

  public async requestStopActiveAttempt(): Promise<void> {
    let attemptId: ReturnType<typeof asAttemptId> | undefined;
    try {
      const raw = this.#orchestrator.currentTask().workflowSnapshot.activeAttemptId;
      attemptId = raw === undefined ? undefined : asAttemptId(raw);
    } catch {
      attemptId = undefined;
    }
    if (attemptId === undefined) return;
    try {
      await this.#supervisor.requestGracefulStop(attemptId);
    } catch {
      // Graceful stop may be unavailable; fall through to force.
    }
    try {
      await this.#supervisor.forceStopTree(attemptId);
    } catch {
      // Best-effort stop for operator interrupt.
    }
  }

  /** Used by orchestrator commandRunner hook. */
  public emitActivityFromAgent(
    role: Parameters<typeof formatAgentActivity>[0]['role'],
    adapterKind: Parameters<typeof formatAgentActivity>[0]['adapterKind'],
    event: Parameters<typeof formatAgentActivity>[0]['event'],
  ): void {
    const line = formatAgentActivity({ role, adapterKind, event });
    if (line !== undefined) {
      this.#activityListener?.(line);
    }
  }

  public emitActivityLine(line: ReturnType<typeof renderActivityLine>): void {
    this.#activityListener?.(line);
  }

  public async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#activityListener = undefined;
    try {
      await this.requestStopActiveAttempt();
    } catch {
      // ignore
    }
    await this.#log.close();
    rmSync(this.#probeDirectory, { recursive: true, force: true });
  }
}

/**
 * Creates the production TaskRuntime used when tests do not replace the whole
 * runtime. Construction is side-effect-light: no Adapter starts until start().
 */
export function createProductionTaskRuntimeFactory(
  options: ProductionTaskRuntimeFactoryOptions,
): TaskRuntimeFactory {
  const now = options.now ?? (() => new Date());
  const createAdapters = options.createAdapters ?? createDefaultAdapters;

  return async (input: TaskRuntimeInput): Promise<TaskRuntimePort> => {
    if (input.projectKind.kind === 'git-unavailable') {
      throw new Error(`Git is unavailable: ${input.projectKind.error}`);
    }
    const nonGit = input.projectKind.kind === 'directory';

    const settings = options.getSettings();
    const taskId = asTaskId(`task-${randomUUID()}`);
    const projectId = `project-${randomUUID()}`;
    const probeDirectory = mkdtempSync(join(tmpdir(), 'triagent-task-probe-'));
    let log: JsonlLog | undefined;
    try {
      log = await JsonlLog.open({
        directory: options.paths.logsDirectory,
        fileName: `${taskId}.jsonl`,
        database: options.database.connection,
        projectRoot: input.project.canonicalRoot,
        clock: now,
      });
      const healthProbe = new CommandProbe({
        cwd: probeDirectory,
        supervisor: options.supervisor,
        timeoutMs: 5_000,
      });
      const launchAuthorization = new LaunchAuthorizationRepository(
        options.database.connection,
      );
      const agentSessions = new AgentSessionRepository(
        options.database.connection,
      );
      const adaptersByKind = createAdapters({
        supervisor: options.supervisor,
        healthProbe,
        launchAuthorization,
        agentSessions,
        settings,
        projectRoot: input.project.canonicalRoot,
        probeDirectory,
      });
      for (const kind of ['codex', 'claude', 'grok'] as const) {
        if (adaptersByKind[kind]?.kind !== kind) {
          throw new Error(`task adapter factory returned an invalid ${kind} adapter`);
        }
      }

      const tracker = nonGit
        ? new NonGitBaselineService({
            projectRoot: input.project.canonicalRoot,
            snapshotStore: options.paths.snapshotsDirectory,
          })
        : new GitBaselineService({
            projectRoot: input.project.canonicalRoot,
            snapshotStore: options.paths.snapshotsDirectory,
          });
      const launchPreparer = new SafeAgentLaunchCoordinator({
        database: options.database,
        projectRoot: input.project.canonicalRoot,
        nonGit,
        now,
      });
      const budget = lazyBudgetController(
        () =>
          new BudgetController({
            database: options.database.connection,
            clock: new BudgetClock({
              now: () => now().toISOString(),
              schedule: (afterMs, action) => {
                const timer = setTimeout(action, afterMs);
                timer.unref?.();
              },
            }),
            supervisor: options.supervisor,
            taskId,
            limits: settingsToBudgetLimits(settings),
          }),
      );
      // Runtime shell first so commandRunner hook can forward live events.
      const runtimeShell = {
        emit: undefined as
          | ((
              role: Parameters<ProductionTaskRuntime['emitActivityFromAgent']>[0],
              adapterKind: Parameters<ProductionTaskRuntime['emitActivityFromAgent']>[1],
              event: Parameters<ProductionTaskRuntime['emitActivityFromAgent']>[2],
            ) => void)
          | undefined,
        activity: undefined as
          | ((line: ReturnType<typeof renderActivityLine>) => void)
          | undefined,
      };
      const contextHolder = {
        get: (): readonly string[] => [],
      };
      const orchestrator = new TaskOrchestrator({
        database: options.database,
        taskDefinition: {
          taskId,
          requirementVersion: 1,
          roles: input.roles,
        },
        projectId,
        projectRoot: input.project.canonicalRoot,
        requirements: input.requirements,
        tracker,
        adapters: adapterAssignments(adaptersByKind, input.roles),
        log,
        ownerInstanceId: input.ownerInstanceId,
        requiresPlanApproval: input.requiresPlanApproval,
        now,
        budget,
        launchPreparer,
        // Required for Grok isolated implementer; ignored by live-project implementers.
        implementationWorkspacesDirectory:
          options.paths.implementationWorkspacesDirectory,
        getOperatorContext: () => contextHolder.get(),
        // Implementer conversation-id resume (same task, rework / continue).
        agentSessions,
        processSupervisor: options.supervisor,
        cleanupGracePeriodMs: 1_000,
        hooks: {
          commandRunner: {
            onAgentEvent: (context) => {
              runtimeShell.emit?.(
                context.role,
                context.adapterKind,
                context.event,
              );
            },
            onLaunchMode: (info) => {
              if (info.role !== 'implementer') return;
              if (info.mode === 'resume' && info.conversationId !== undefined) {
                runtimeShell.activity?.(
                  renderActivityLine(
                    'stage',
                    `续聊 implementer 会话 ${String(info.conversationId).slice(0, 48)}`,
                  ),
                );
              } else if (info.mode === 'resume_fallback_start') {
                runtimeShell.activity?.(
                  renderActivityLine(
                    'system',
                    'implementer 续聊失败，已开新会话',
                  ),
                );
              } else if (info.mode === 'start' && info.role === 'implementer') {
                runtimeShell.activity?.(
                  renderActivityLine('stage', 'implementer 新开会话'),
                );
              }
            },
          },
        },
      });
      const runtime = new ProductionTaskRuntime({
        orchestrator,
        log,
        probeDirectory,
        supervisor: options.supervisor,
        ...(input.onActivity === undefined ? {} : { onActivity: input.onActivity }),
      });
      contextHolder.get = () => runtime.getOperatorContext();
      runtimeShell.emit = (role, adapterKind, event) => {
        runtime.emitActivityFromAgent(role, adapterKind, event);
      };
      runtimeShell.activity = (line) => {
        runtime.emitActivityLine(line);
      };
      return runtime;
    } catch (error) {
      if (log !== undefined) {
        await log.close().catch(() => undefined);
      }
      rmSync(probeDirectory, { recursive: true, force: true });
      throw error;
    }
  };
}
