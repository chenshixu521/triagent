import { randomUUID } from 'node:crypto';

import type { DatabaseDiagnostics } from '../persistence/database-diagnostics.js';
import {
  createPersistenceRepositories,
  openDatabase,
  type OpenedDatabase,
  type PersistenceRepositories,
  type ReadWriteDatabase,
} from '../persistence/database.js';
import { resolveAppPaths, type AppPaths } from '../config/app-paths.js';
import {
  DEFAULT_SETTINGS,
  loadSettingsBundle,
  saveSettings,
  settingsToBudgetLimits,
  validateSettings,
  type AppSettings,
} from '../config/settings.js';
import { checkClaudeHealth } from '../agents/health/claude-health.js';
import { checkCodexHealth } from '../agents/health/codex-health.js';
import { CommandProbe } from '../agents/health/command-probe.js';
import { checkGrokHealth } from '../agents/health/grok-health.js';
import { CompatibilityResolver } from '../agents/compatibility-resolver.js';
import { ProjectGuard } from '../guard/project-guard.js';
import { BudgetClock } from '../budget/budget-clock.js';
import { BudgetController } from '../budget/budget-controller.js';
import { asTaskId, type TaskId } from '../domain/ids.js';
import { ProcessSupervisor } from '../process/process-supervisor.js';
import {
  classifyIdentityLiveness,
  queryProcessIdentity,
} from '../process/process-identity-probe.js';
import type { ProcessSupervisorPort } from '../process/process-supervisor-port.js';
import { canonicalizeProjectPath } from '../project/canonical-path.js';
import { detectProjectKind } from '../project/project-kind.js';
import { ProjectLockService } from '../project/project-lock-service.js';
import { GitBaselineService } from '../tracking/git-baseline-service.js';
import { NonGitBaselineService } from '../tracking/non-git-baseline-service.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInitialTuiSnapshot,
  type ApplicationControllerPort,
  type ControllerDispatchResult,
  type TuiIntent,
  type TuiRecoveryAction,
  type TuiSnapshot,
} from '../tui/store.js';
import { resolveUiLanguage, uiText } from '../tui/i18n.js';
import {
  createLifecycleCoordinator,
  safeCloseDatabase,
  type LifecycleCoordinator,
  type LifecycleShutdownResult,
} from './lifecycle-coordinator.js';
import {
  runStartupReconcile,
  type RecoveryOperatorAction,
  type StartupReconcileReport,
} from './startup-reconcile.js';
import {
  createTaskSessionController,
  type TaskRuntimeFactory,
} from './task-session-controller.js';
import {
  RestartRecoveryService,
  type RecoveryEffectIntent,
  type RecoveryOperationResult,
} from './restart-recovery-service.js';
import type { ReconciliationProcessEvidence } from '../workflow/reconciler.js';
import {
  createProductionTaskRuntimeFactory,
  executeProductionRecoveryEffects,
  type ProductionTaskAdapterFactory,
  type ProductionTaskRuntimeFactoryOptions,
} from './production-task-runtime.js';

/**
 * Observable typed startup stages. Order is fixed and must never start
 * manager/worker/adapter/project lock/process host before database health
 * is positively known.
 */
export type StartupStageName =
  | 'resolve_app_paths'
  | 'open_diagnose_database'
  | 'construct_repositories'
  | 'construct_project_guard'
  | 'construct_budget_controller'
  | 'construct_process_host_worker_managers'
  | 'adapter_capability_health_probes'
  | 'startup_reconcile'
  | 'ready_for_ink_render';

export interface StartupStageEvent {
  readonly name: StartupStageName;
  readonly at: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface SideEffectFlags {
  workerStarted: boolean;
  adapterStarted: boolean;
  projectLockAcquired: boolean;
  processHostStarted: boolean;
  watcherStarted: boolean;
  nativeHelperStarted: boolean;
}

export interface CapabilityProbeReport {
  readonly kind: string;
  readonly status: string;
  readonly reason?: string;
}

export interface CapabilityProbeResult {
  readonly reports: readonly CapabilityProbeReport[];
  readonly adapterStarted: boolean;
}

export interface ComposeFactories {
  readonly createBudgetController?: (input: {
    readonly database: ReadWriteDatabase;
    readonly supervisor: ProcessSupervisorPort;
    readonly taskId: TaskId;
    readonly limits: ReturnType<typeof settingsToBudgetLimits>;
    readonly clock: BudgetClock;
  }) => unknown;
  readonly runCapabilityProbes?: (input: {
    readonly settings: AppSettings;
    readonly supervisor: ProcessSupervisorPort;
    readonly cliCompatibilityCachePath: string;
  }) => Promise<CapabilityProbeResult>;
  readonly createTaskRuntime?: TaskRuntimeFactory;
  /** Test/custom seam while retaining the production TaskRuntime composition. */
  readonly createTaskAdapters?: ProductionTaskAdapterFactory;
  readonly inspectRecoveryProcess?: (
    pid: number,
    processStartedAt: string,
  ) => Promise<ReconciliationProcessEvidence> | ReconciliationProcessEvidence;
  readonly executeRecoveryEffects?: (input: {
    readonly taskId: TaskId;
    readonly effects: readonly RecoveryEffectIntent[];
  }) => Promise<void>;
}

export interface ComposeApplicationOptions {
  readonly appRootOverride?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly skipHealthProbes?: boolean;
  readonly skipProcessHost?: boolean;
  /** Forced diagnostic: no migration/write even if DB healthy or missing. */
  readonly diagnosticOnly?: boolean;
  readonly createDirectories?: boolean;
  readonly ownerInstanceId?: string;
  readonly onStage?: (stage: StartupStageEvent) => void;
  readonly testHooks?: {
    readonly forceCleanupFailure?: boolean;
  };
  /** Injected supervisor for tests; production constructs ProcessSupervisor. */
  readonly supervisor?: ProcessSupervisorPort;
  readonly factories?: ComposeFactories;
  readonly now?: () => Date;
  /** Deterministic UI locale seam; production uses the runtime Intl locale. */
  readonly systemLocale?: string;
  /** Ink unmount / exit authorization hook wired by CLI render. */
  readonly onAuthorizedExit?: () => void | Promise<void>;
}

export interface ApplicationComposition {
  readonly mode: 'read-write' | 'diagnostic';
  readonly paths: AppPaths;
  /** @deprecated Prefer effectiveSettings / persistedSettings. */
  readonly settings: AppSettings;
  readonly persistedSettings: AppSettings;
  readonly effectiveSettings: AppSettings;
  readonly runtimeOnlyOverrides: readonly (keyof AppSettings)[];
  readonly database: OpenedDatabase;
  readonly diagnostics?: DatabaseDiagnostics;
  readonly repositories?: PersistenceRepositories;
  readonly budgetController?: unknown;
  readonly ownerInstanceId: string;
  readonly stages: readonly StartupStageEvent[];
  readonly sideEffects: Readonly<SideEffectFlags>;
  readonly reconcileReport?: StartupReconcileReport;
  readonly lifecycle: LifecycleCoordinator;
  readonly controller: ApplicationControllerPort;
  readonly acceptingIntents: boolean;
  readonly testHooks?: {
    readonly clearCleanupFailure?: () => void;
  };
  snapshot(): TuiSnapshot;
  dispatch(intent: TuiIntent): Promise<ControllerDispatchResult>;
  close(): void;
  updateSettings(next: Partial<AppSettings>): AppSettings;
  /** True once lifecycle closed the DB (or composition.close). */
  isDatabaseClosed(): boolean;
  /**
   * Wire live task-progress pushes into the Ink store after render.
   * Partial snapshots are merged with preserveUiState.
   */
  setTaskProgressSink?(
    sink: ((partial: Partial<TuiSnapshot>) => void) | undefined,
  ): void;
}

const STARTUP_ORDER: readonly StartupStageName[] = [
  'resolve_app_paths',
  'open_diagnose_database',
  'construct_repositories',
  'construct_project_guard',
  'construct_budget_controller',
  'construct_process_host_worker_managers',
  'adapter_capability_health_probes',
  'startup_reconcile',
  'ready_for_ink_render',
] as const;

const COMPOSITION_BUDGET_TASK_ID = asTaskId('__composition_budget__');

function emitStage(
  stages: StartupStageEvent[],
  name: StartupStageName,
  ok: boolean,
  onStage: ComposeApplicationOptions['onStage'],
  now: () => Date,
  detail?: string,
): void {
  const event: StartupStageEvent = {
    name,
    at: now().toISOString(),
    ok,
    ...(detail === undefined ? {} : { detail }),
  };
  stages.push(event);
  onStage?.(event);
}

function redactedDiagnosticLines(
  diagnostics: DatabaseDiagnostics,
): readonly string[] {
  return [
    `DB path: ${diagnostics.path}`,
    `exists: ${String(diagnostics.exists)}`,
    diagnostics.sizeBytes !== undefined
      ? `sizeBytes: ${String(diagnostics.sizeBytes)}`
      : 'sizeBytes: unknown',
    `error: ${diagnostics.error}`,
    diagnostics.quickCheck !== undefined
      ? `quick_check: ${diagnostics.quickCheck.join('; ')}`
      : 'quick_check: unavailable',
    'Workers/adapters/locks/process host were not started',
    'Diagnostic mode does not overwrite, quarantine, or delete the database',
  ];
}

function recoverySnapshotFromDiagnostic(
  diagnostics: DatabaseDiagnostics,
  runtimeNote?: string,
): TuiSnapshot {
  return createInitialTuiSnapshot({
    screen: 'recovery',
    workflowState: 'failed',
    processRunning: false,
    loading: false,
    empty: false,
    error:
      'Database diagnostic mode: file unreadable or incompatible. Side effects disabled.',
    statusMessage: runtimeNote ?? 'Diagnostic read-only mode',
    logs: {
      master: [],
      implementer: [],
      reviewer: [],
      system: redactedDiagnosticLines(diagnostics),
    },
  });
}

function toTuiRecoveryActions(
  actions: readonly RecoveryOperatorAction[],
): readonly TuiRecoveryAction[] {
  return actions.filter(
    (action): action is TuiRecoveryAction =>
      action === 'inspect' || action === 'continue' || action === 'cancel',
  );
}

function recoverySnapshotFromReconcile(
  report: StartupReconcileReport,
  runtimeNote?: string,
): TuiSnapshot {
  if (report.items.length === 0) {
    return createInitialTuiSnapshot({
      screen: 'project',
      workflowState: 'draft',
      processRunning: false,
      statusMessage: runtimeNote ?? 'No incomplete tasks to recover',
    });
  }
  const primary = report.items[0]!;
  const systemLines = report.items.flatMap((item) => [
    ...item.evidenceLines,
    `Allowed: ${item.allowedNextActions.join(', ')}`,
  ]);
  return createInitialTuiSnapshot({
    screen: 'recovery',
    workflowState: primary.status,
    taskId: primary.taskId,
    processRunning: false,
    error:
      primary.decision.kind === 'blocked'
        ? `${primary.status}: ${primary.decision.reason}`
        : undefined,
    statusMessage: runtimeNote ?? 'Recovery mode — choose an allowed action',
    recoveryAllowedActions: toTuiRecoveryActions(primary.allowedNextActions),
    logs: {
      master: [],
      implementer: [],
      reviewer: [],
      system: systemLines.slice(0, 40),
    },
  });
}

function ensureCompositionBudgetTask(database: ReadWriteDatabase): void {
  const now = new Date().toISOString();
  database.connection
    .prepare(
      `INSERT OR IGNORE INTO projects(id, root_path, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('__composition__', 'composition://budget', now, now);
  database.connection
    .prepare(
      `INSERT OR IGNORE INTO tasks(
         id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at
       ) VALUES (?, ?, 'draft', 1, ?, ?, ?)`,
    )
    .run(
      COMPOSITION_BUDGET_TASK_ID,
      '__composition__',
      JSON.stringify({
        state: 'draft',
        taskId: COMPOSITION_BUDGET_TASK_ID,
        requirementVersion: 1,
        reworkCount: 0,
        maxReworks: 3,
        pauseAfterAttempt: false,
      }),
      now,
      now,
    );
}

function createNoopSupervisor(now: () => Date): ProcessSupervisorPort {
  return {
    async start() {
      throw new Error('process host disabled for this composition');
    },
    async requestGracefulStop() {
      /* no-op */
    },
    async forceStopTree() {
      /* no-op */
    },
    async wait(attemptId) {
      return {
        attemptId,
        pid: 0,
        exitCode: null,
        signal: null,
        reason: 'exited' as const,
        endedAt: now().toISOString(),
      };
    },
    subscribe() {
      return () => undefined;
    },
  };
}

async function inspectProductionRecoveryProcess(
  pid: number,
  processStartedAt: string,
): Promise<ReconciliationProcessEvidence> {
  const probe = await queryProcessIdentity(pid);
  const liveness = classifyIdentityLiveness(processStartedAt, probe);
  if (liveness === 'alive') {
    return {
      identity: 'matched',
      terminalState: 'running',
      pid,
      processStartedAt,
    };
  }
  if (liveness === 'gone') {
    return {
      identity: 'matched',
      terminalState: 'exited',
      pid,
      processStartedAt,
    };
  }
  if (liveness === 'reused') {
    return {
      identity: 'mismatched',
      terminalState: 'unknown',
      diagnostic: `PID ${String(pid)} was reused with a different process start time`,
    };
  }
  return {
    identity: 'unverifiable',
    terminalState: 'unknown',
    diagnostic:
      probe.status === 'probe_unavailable' || probe.status === 'probe_invalid'
        ? probe.reason
        : 'process identity is uncertain',
  };
}

function recoverySnapshotFromOperation(
  current: TuiSnapshot,
  result: RecoveryOperationResult,
): Partial<TuiSnapshot> {
  const state = result.workflowSnapshot.state;
  const screen =
    state === 'interrupted_needs_inspection'
    || state === 'cleanup_failed'
    || state === 'awaiting_user'
      ? 'recovery'
      : state === 'completed' || state === 'cancelled' || state === 'failed'
        ? 'review'
        : 'run';
  const evidenceLines = result.evidence === undefined
    ? []
    : [
        `Recovery process: ${result.evidence.process.identity}/${result.evidence.process.terminalState}`,
        `Recovery baseline: ${result.evidence.baseline.status}`,
        `Recovery changes: ${result.evidence.changedFiles.join(', ') || 'none'}`,
      ];
  const recoveryAllowedActions: readonly TuiRecoveryAction[] =
    result.status === 'blocked'
      ? current.recoveryAllowedActions
      : state === 'interrupted_needs_inspection'
        ? ['inspect', 'cancel']
        : state === 'awaiting_user'
          ? (result.workflowSnapshot.allowedAwaitingActions ?? []).filter(
              (action): action is 'continue' | 'cancel' =>
                action === 'continue' || action === 'cancel',
            )
          : [];
  return {
    screen,
    workflowState: state,
    processRunning:
      'execution' in result
      && result.execution === 'started'
      && (
        state === 'planning'
        || state === 'implementing'
        || state === 'reviewing'
        || state === 'master_validation'
      ),
    pauseAfterAttempt: result.workflowSnapshot.pauseAfterAttempt,
    reworkCount: result.workflowSnapshot.reworkCount,
    maxReworks: result.workflowSnapshot.maxReworks,
    canApprove: state === 'awaiting_plan_approval',
    canRework: false,
    loading: false,
    empty: false,
    error: result.status === 'blocked' ? result.reason : undefined,
    recoveryAllowedActions,
    statusMessage:
      result.status === 'blocked'
        ? result.reason
        : `Recovery ${result.status}: ${state}`,
    logs: {
      ...current.logs,
      system: [...current.logs.system, ...evidenceLines].slice(-current.maxLogLines),
    },
  };
}

/**
 * Production capability probes: real CommandProbe-backed Codex/Claude/Grok
 * health checks using configured executable paths from settings.
 * Each path is passed as a single argv executable value (never shell).
 * Never starts adapters. Never synthesizes deferred success.
 */
export async function runProductionCapabilityProbes(input: {
  readonly settings: AppSettings;
  readonly supervisor: ProcessSupervisorPort;
  readonly cliCompatibilityCachePath: string;
}): Promise<CapabilityProbeResult> {
  // Probes use a disposable temp cwd — never a live project root.
  const probeCwd = mkdtempSync(join(tmpdir(), 'triagent-probe-'));
  const probe = new CommandProbe({
    cwd: probeCwd,
    supervisor: input.supervisor,
    timeoutMs: 5_000,
  });
  const compatibilityResolver = new CompatibilityResolver({
    cachePath: input.cliCompatibilityCachePath,
    executableCwd: probeCwd,
  });

  const codexPath = input.settings.codexCliPath.trim();
  const claudePath = input.settings.claudeCliPath.trim();
  const grokPath = input.settings.grokCliPath.trim();
  if (codexPath.length === 0 || claudePath.length === 0 || grokPath.length === 0) {
    throw new Error('configured CLI paths must be non-empty executable values');
  }

  const [codex, claude, grok] = await Promise.all([
    checkCodexHealth(probe, {
      executable: codexPath,
      compatibilityResolver,
    }),
    checkClaudeHealth(probe, {
      executable: claudePath,
      compatibilityResolver,
    }),
    checkGrokHealth(probe, {
      executable: grokPath,
      compatibilityResolver,
    }),
  ]);

  const reports: CapabilityProbeReport[] = [
    {
      kind: 'codex',
      status: codex.status,
      ...(codex.reason === undefined ? {} : { reason: codex.reason }),
    },
    {
      kind: 'claude',
      status: claude.status,
      ...(claude.reason === undefined ? {} : { reason: claude.reason }),
    },
    {
      kind: 'grok',
      status: grok.status,
      ...(grok.reason === undefined ? {} : { reason: grok.reason }),
    },
  ];

  // Path/probe failures (missing/error/timeout) are concrete results; composition
  // stage success means probes ran. Callers may still fail closed on empty/deferred.
  return {
    reports,
    adapterStarted: false,
  };
}

function assertConcreteProbeResult(result: CapabilityProbeResult): void {
  if (result.adapterStarted) {
    throw new Error('capability probes must not start adapters');
  }
  if (result.reports.length === 0) {
    throw new Error('capability probes returned empty reports');
  }
  for (const report of result.reports) {
    if (
      report.status === 'deferred'
      || report.status === 'empty'
      || report.status === 'malformed'
      || report.kind === 'composition'
    ) {
      throw new Error(
        `capability probe not concrete: ${report.kind}/${report.status}`
          + (report.reason !== undefined ? ` (${report.reason})` : ''),
      );
    }
  }
}

/**
 * Compose the application in deterministic startup order.
 * No manager/worker/adapter/project lock/process host starts before the
 * database is positively known healthy (read-write mode).
 */
export async function composeApplication(
  options: ComposeApplicationOptions = {},
): Promise<ApplicationComposition> {
  const now = options.now ?? (() => new Date());
  const stages: StartupStageEvent[] = [];
  const sideEffects: SideEffectFlags = {
    workerStarted: false,
    adapterStarted: false,
    projectLockAcquired: false,
    processHostStarted: false,
    watcherStarted: false,
    nativeHelperStarted: false,
  };
  const ownerInstanceId = options.ownerInstanceId ?? randomUUID();
  const diagnosticOnly = options.diagnosticOnly === true;
  const environment = options.environment ?? process.env;

  // 1) resolve / harden app paths
  // Diagnostic mode still needs path dirs for logs presentation but must not
  // create settings/db. createDirectories defaults true except pure path tests.
  const paths = resolveAppPaths({
    appRootOverride: options.appRootOverride,
    environment,
    createDirectories: options.createDirectories !== false,
  });
  emitStage(stages, 'resolve_app_paths', true, options.onStage, now, paths.root);

  // Settings: keep persisted vs effective separate. Diagnostic must not write.
  let settingsBundle = {
    persisted: DEFAULT_SETTINGS,
    effective: DEFAULT_SETTINGS,
    runtimeOnlyOverrides: [] as readonly (keyof AppSettings)[],
  };
  try {
    settingsBundle = loadSettingsBundle(paths.settingsPath, { environment });
  } catch {
    settingsBundle = {
      persisted: DEFAULT_SETTINGS,
      effective: DEFAULT_SETTINGS,
      runtimeOnlyOverrides: [],
    };
  }
  let persistedSettings = settingsBundle.persisted;
  let effectiveSettings = settingsBundle.effective;
  let runtimeOnlyOverrides = settingsBundle.runtimeOnlyOverrides;

  const runtimeNote =
    runtimeOnlyOverrides.includes('realAiTestsOptIn')
      ? 'Runtime-only override: TRIAGENT_REAL_AI_TESTS (not persisted)'
      : undefined;

  // 2) open and diagnose / migrate database (or forced diagnostic)
  const database = openDatabase(paths.databasePath, {
    diagnosticOnly,
  });
  const databaseHealthy = database.mode === 'read-write' && !diagnosticOnly;
  emitStage(
    stages,
    'open_diagnose_database',
    databaseHealthy,
    options.onStage,
    now,
    database.mode + (diagnosticOnly ? '+forced' : ''),
  );

  let repositories: PersistenceRepositories | undefined;
  let projectGuard: ProjectGuard | undefined;
  let budgetController: unknown;
  let supervisor: ProcessSupervisorPort | undefined;
  let projectLockService: ProjectLockService | undefined;
  let reconcileReport: StartupReconcileReport | undefined;
  let currentSnapshot: TuiSnapshot;
  let databaseClosed = false;
  const closedWorkers = { value: false };
  let jsonlFlush: (() => Promise<void>) | undefined;
  let authorizedExitHook = options.onAuthorizedExit;

  if (!databaseHealthy) {
    emitStage(
      stages,
      'construct_repositories',
      false,
      options.onStage,
      now,
      'skipped: diagnostic mode',
    );
    emitStage(
      stages,
      'construct_project_guard',
      false,
      options.onStage,
      now,
      'skipped: diagnostic mode',
    );
    emitStage(
      stages,
      'construct_budget_controller',
      false,
      options.onStage,
      now,
      'skipped: diagnostic mode',
    );
    emitStage(
      stages,
      'construct_process_host_worker_managers',
      false,
      options.onStage,
      now,
      'skipped: diagnostic mode',
    );
    emitStage(
      stages,
      'adapter_capability_health_probes',
      false,
      options.onStage,
      now,
      'skipped: diagnostic mode',
    );
    emitStage(
      stages,
      'startup_reconcile',
      false,
      options.onStage,
      now,
      'skipped: diagnostic mode',
    );
    const diagnostics =
      database.mode === 'diagnostic'
        ? database.diagnostics
        : {
            path: paths.databasePath,
            exists: false,
            error: 'diagnostic mode',
          };
    currentSnapshot = recoverySnapshotFromDiagnostic(diagnostics, runtimeNote);
    emitStage(stages, 'ready_for_ink_render', true, options.onStage, now, 'diagnostic');
  } else {
    const rw = database as ReadWriteDatabase;

    // 3) repositories
    repositories = createPersistenceRepositories(database);
    emitStage(stages, 'construct_repositories', true, options.onStage, now);

    // 4) ProjectGuard (constructor only — no lock acquire)
    projectGuard = new ProjectGuard({
      projectRoot: paths.root,
    });
    emitStage(stages, 'construct_project_guard', true, options.onStage, now);
    void projectGuard;

    // 5) BudgetController BEFORE process managers — real construction.
    const budgetLimits = settingsToBudgetLimits(effectiveSettings);
    const clock = new BudgetClock({
      now: () => now().toISOString(),
      schedule: () => {
        /* composition clock: no timers */
      },
    });

    // Supervisor shell needed for BudgetController dependencies; not started.
    if (options.skipProcessHost === true) {
      supervisor = options.supervisor ?? createNoopSupervisor(now);
    } else if (options.supervisor !== undefined) {
      supervisor = options.supervisor;
    } else {
      supervisor = new ProcessSupervisor({});
    }

    try {
      ensureCompositionBudgetTask(rw);
      if (options.factories?.createBudgetController !== undefined) {
        budgetController = options.factories.createBudgetController({
          database: rw,
          supervisor,
          taskId: COMPOSITION_BUDGET_TASK_ID,
          limits: budgetLimits,
          clock,
        });
      } else {
        budgetController = new BudgetController({
          database: rw.connection,
          clock,
          supervisor,
          taskId: COMPOSITION_BUDGET_TASK_ID,
          limits: budgetLimits,
        });
      }
      emitStage(
        stages,
        'construct_budget_controller',
        true,
        options.onStage,
        now,
        'BudgetController constructed',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitStage(
        stages,
        'construct_budget_controller',
        false,
        options.onStage,
        now,
        message,
      );
      // Fail closed: diagnostic-style recovery, no further side-effect stages.
      emitStage(
        stages,
        'construct_process_host_worker_managers',
        false,
        options.onStage,
        now,
        'skipped: budget construction failed',
      );
      emitStage(
        stages,
        'adapter_capability_health_probes',
        false,
        options.onStage,
        now,
        'skipped: budget construction failed',
      );
      emitStage(
        stages,
        'startup_reconcile',
        false,
        options.onStage,
        now,
        'skipped: budget construction failed',
      );
      currentSnapshot = createInitialTuiSnapshot({
        screen: 'recovery',
        workflowState: 'failed',
        processRunning: false,
        error: `Startup failed during budget construction: ${message}`,
        statusMessage: 'Fail closed — side effects disabled',
      });
      emitStage(stages, 'ready_for_ink_render', true, options.onStage, now, 'fail-closed');
      // Jump to lifecycle wiring below via early snapshot path.
      return finalizeComposition({
        mode: 'diagnostic',
        paths,
        persistedSettings,
        effectiveSettings,
        runtimeOnlyOverrides,
        database: {
          mode: 'diagnostic',
          path: paths.databasePath,
          diagnostics: {
            path: paths.databasePath,
            exists: true,
            error: message,
          },
          close: () => {
            if (!databaseClosed) {
              safeCloseDatabase(database);
              databaseClosed = true;
            }
          },
        },
        diagnostics: {
          path: paths.databasePath,
          exists: true,
          error: message,
        },
        repositories: undefined,
        budgetController: undefined,
        ownerInstanceId,
        stages,
        sideEffects,
        reconcileReport: undefined,
        currentSnapshot,
        supervisor: undefined,
        getDatabaseClosed: () => databaseClosed,
        setDatabaseClosed: () => {
          databaseClosed = true;
        },
        closeDatabaseImpl: () => {
          if (!databaseClosed) {
            safeCloseDatabase(database);
            databaseClosed = true;
          }
        },
        jsonlFlush: undefined,
        closedWorkers,
        forceCleanupFailure: options.testHooks?.forceCleanupFailure === true,
        getAuthorizedExitHook: () => authorizedExitHook,
        setAuthorizedExitHook: (hook) => {
          authorizedExitHook = hook;
        },
        getPersisted: () => persistedSettings,
        setPersisted: (next) => {
          persistedSettings = next;
        },
        getEffective: () => effectiveSettings,
        setEffective: (next) => {
          effectiveSettings = next;
        },
        getRuntimeOverrides: () => runtimeOnlyOverrides,
        setRuntimeOverrides: (next) => {
          runtimeOnlyOverrides = next;
        },
        environment,
        options,
      });
    }

    // 6) ProcessHost / Worker managers — construct only; never start helper.
    if (options.skipProcessHost === true) {
      emitStage(
        stages,
        'construct_process_host_worker_managers',
        true,
        options.onStage,
        now,
        'supervisor shell only; process host not started',
      );
    } else if (options.supervisor !== undefined) {
      emitStage(
        stages,
        'construct_process_host_worker_managers',
        true,
        options.onStage,
        now,
        'injected supervisor',
      );
    } else {
      emitStage(
        stages,
        'construct_process_host_worker_managers',
        true,
        options.onStage,
        now,
        'ProcessSupervisor constructed; helper not started',
      );
    }

    projectLockService = new ProjectLockService(database);
    void projectLockService;

    // 7) adapter capability / health probes — real execution or explicit skip.
    if (options.skipHealthProbes === true) {
      emitStage(
        stages,
        'adapter_capability_health_probes',
        false,
        options.onStage,
        now,
        'skipped by option',
      );
    } else {
      try {
        const probeRunner =
          options.factories?.runCapabilityProbes
          ?? runProductionCapabilityProbes;
        const probeResult = await probeRunner({
          settings: effectiveSettings,
          supervisor,
          cliCompatibilityCachePath: paths.cliCompatibilityCachePath,
        });
        assertConcreteProbeResult(probeResult);
        if (probeResult.adapterStarted) {
          sideEffects.adapterStarted = true;
        }
        emitStage(
          stages,
          'adapter_capability_health_probes',
          true,
          options.onStage,
          now,
          `probes=${String(probeResult.reports.length)}; no adapter started`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitStage(
          stages,
          'adapter_capability_health_probes',
          false,
          options.onStage,
          now,
          message,
        );
        emitStage(
          stages,
          'startup_reconcile',
          false,
          options.onStage,
          now,
          'skipped: probe failure',
        );
        currentSnapshot = createInitialTuiSnapshot({
          screen: 'recovery',
          workflowState: 'failed',
          processRunning: false,
          error: `Startup failed during capability probes: ${message}`,
          statusMessage: 'Fail closed — side effects disabled',
        });
        emitStage(stages, 'ready_for_ink_render', true, options.onStage, now, 'fail-closed');
        return finalizeComposition({
          mode: 'diagnostic',
          paths,
          persistedSettings,
          effectiveSettings,
          runtimeOnlyOverrides,
          database,
          diagnostics: {
            path: paths.databasePath,
            exists: true,
            error: message,
          },
          repositories,
          budgetController,
          ownerInstanceId,
          stages,
          sideEffects,
          reconcileReport: undefined,
          currentSnapshot,
          supervisor,
          getDatabaseClosed: () => databaseClosed,
          setDatabaseClosed: () => {
            databaseClosed = true;
          },
          closeDatabaseImpl: () => {
            if (!databaseClosed) {
              safeCloseDatabase(database);
              databaseClosed = true;
            }
          },
          jsonlFlush,
          closedWorkers,
          forceCleanupFailure: options.testHooks?.forceCleanupFailure === true,
          getAuthorizedExitHook: () => authorizedExitHook,
          setAuthorizedExitHook: (hook) => {
            authorizedExitHook = hook;
          },
          getPersisted: () => persistedSettings,
          setPersisted: (next) => {
            persistedSettings = next;
          },
          getEffective: () => effectiveSettings,
          setEffective: (next) => {
            effectiveSettings = next;
          },
          getRuntimeOverrides: () => runtimeOnlyOverrides,
          setRuntimeOverrides: (next) => {
            runtimeOnlyOverrides = next;
          },
          environment,
          options,
        });
      }
    }

    // 8) startup reconcile
    reconcileReport = await runStartupReconcile({
      database,
      ownerInstanceId,
      observedAt: now,
      inspectProcess:
        options.factories?.inspectRecoveryProcess
        ?? inspectProductionRecoveryProcess,
    });
    emitStage(
      stages,
      'startup_reconcile',
      true,
      options.onStage,
      now,
      `incomplete=${String(reconcileReport.incompleteTaskCount)}`,
    );

    currentSnapshot =
      reconcileReport.incompleteTaskCount > 0
        ? recoverySnapshotFromReconcile(reconcileReport, runtimeNote)
        : createInitialTuiSnapshot({
            screen: 'project',
            workflowState: 'draft',
            processRunning: false,
            statusMessage: runtimeNote ?? 'Ready',
          });

    emitStage(stages, 'ready_for_ink_render', true, options.onStage, now);
    void rw;
  }

  // Ensure stage order completeness for observers.
  const observedNames = stages.map((stage) => stage.name);
  for (const expected of STARTUP_ORDER) {
    if (!observedNames.includes(expected)) {
      emitStage(stages, expected, false, options.onStage, now, 'missing stage backfill');
    }
  }

  return finalizeComposition({
    mode: database.mode,
    paths,
    persistedSettings,
    effectiveSettings,
    runtimeOnlyOverrides,
    database,
    diagnostics:
      database.mode === 'diagnostic' ? database.diagnostics : undefined,
    repositories,
    budgetController,
    ownerInstanceId,
    stages,
    sideEffects,
    reconcileReport,
    currentSnapshot,
    supervisor,
    getDatabaseClosed: () => databaseClosed,
    setDatabaseClosed: () => {
      databaseClosed = true;
    },
    closeDatabaseImpl: () => {
      if (!databaseClosed) {
        safeCloseDatabase(database);
        databaseClosed = true;
      }
    },
    jsonlFlush,
    closedWorkers,
    forceCleanupFailure: options.testHooks?.forceCleanupFailure === true,
    getAuthorizedExitHook: () => authorizedExitHook,
    setAuthorizedExitHook: (hook) => {
      authorizedExitHook = hook;
    },
    getPersisted: () => persistedSettings,
    setPersisted: (next) => {
      persistedSettings = next;
    },
    getEffective: () => effectiveSettings,
    setEffective: (next) => {
      effectiveSettings = next;
    },
    getRuntimeOverrides: () => runtimeOnlyOverrides,
    setRuntimeOverrides: (next) => {
      runtimeOnlyOverrides = next;
    },
    environment,
    options,
  });
}

interface FinalizeInput {
  readonly mode: 'read-write' | 'diagnostic';
  readonly paths: AppPaths;
  readonly persistedSettings: AppSettings;
  readonly effectiveSettings: AppSettings;
  readonly runtimeOnlyOverrides: readonly (keyof AppSettings)[];
  readonly database: OpenedDatabase;
  readonly diagnostics?: DatabaseDiagnostics;
  readonly repositories?: PersistenceRepositories;
  readonly budgetController?: unknown;
  readonly ownerInstanceId: string;
  readonly stages: StartupStageEvent[];
  readonly sideEffects: SideEffectFlags;
  readonly reconcileReport?: StartupReconcileReport;
  readonly currentSnapshot: TuiSnapshot;
  readonly supervisor?: ProcessSupervisorPort;
  readonly getDatabaseClosed: () => boolean;
  readonly setDatabaseClosed: () => void;
  readonly closeDatabaseImpl: () => void;
  readonly jsonlFlush?: () => Promise<void>;
  readonly closedWorkers: { value: boolean };
  readonly forceCleanupFailure: boolean;
  readonly getAuthorizedExitHook: () => (() => void | Promise<void>) | undefined;
  readonly setAuthorizedExitHook: (
    hook: (() => void | Promise<void>) | undefined,
  ) => void;
  readonly getPersisted: () => AppSettings;
  readonly setPersisted: (next: AppSettings) => void;
  readonly getEffective: () => AppSettings;
  readonly setEffective: (next: AppSettings) => void;
  readonly getRuntimeOverrides: () => readonly (keyof AppSettings)[];
  readonly setRuntimeOverrides: (next: readonly (keyof AppSettings)[]) => void;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly options: ComposeApplicationOptions;
}

function finalizeComposition(input: FinalizeInput): ApplicationComposition {
  let snapshotState: TuiSnapshot = {
    ...input.currentSnapshot,
    uiLanguage: resolveUiLanguage(
      input.getEffective().uiLanguage,
      input.options.systemLocale
        ?? Intl.DateTimeFormat().resolvedOptions().locale,
    ),
  };
  let closed = false;
  const productionRuntimeOptions: ProductionTaskRuntimeFactoryOptions | undefined =
    input.mode === 'read-write'
    && input.database.mode === 'read-write'
    && input.supervisor !== undefined
      ? {
          database: input.database,
          paths: input.paths,
          supervisor: input.supervisor,
          getSettings: input.getEffective,
          now: input.options.now,
          ...(input.options.factories?.createTaskAdapters === undefined
            ? {}
            : {
                createAdapters:
                  input.options.factories.createTaskAdapters,
              }),
        }
      : undefined;
  const defaultTaskRuntime = productionRuntimeOptions === undefined
    ? undefined
    : createProductionTaskRuntimeFactory(productionRuntimeOptions);
  const taskSession = createTaskSessionController({
    ownerInstanceId: input.ownerInstanceId,
    createRuntime:
      input.options.factories?.createTaskRuntime ?? defaultTaskRuntime,
  });
  let taskProgressSink: ((partial: Partial<TuiSnapshot>) => void) | undefined;
  taskSession.setProgressListener((partial) => {
    snapshotState = {
      ...snapshotState,
      ...partial,
      logs: partial.logs ?? snapshotState.logs,
    };
    taskProgressSink?.(partial);
  });
  const recoveryServices = new Map<string, RestartRecoveryService>();
  const recoveryServiceFor = (taskId: TaskId): RestartRecoveryService => {
    const cached = recoveryServices.get(taskId);
    if (cached !== undefined) return cached;
    if (input.database.mode !== 'read-write') {
      throw new Error('recovery operations require a writable database');
    }
    const row = input.database.connection
      .prepare(
        `SELECT projects.root_path AS rootPath
         FROM tasks JOIN projects ON projects.id = tasks.project_id
         WHERE tasks.id = ?`,
      )
      .get(taskId) as { readonly rootPath: string } | undefined;
    if (row === undefined) throw new Error(`recovery task project not found: ${taskId}`);
    const inspectProcess =
      input.options.factories?.inspectRecoveryProcess
      ?? inspectProductionRecoveryProcess;
    const projectKind = detectProjectKind(canonicalizeProjectPath(row.rootPath));
    if (projectKind.kind === 'git-unavailable') {
      throw new Error(`Git is unavailable: ${projectKind.error}`);
    }
    const nonGit = projectKind.kind === 'directory';
    const tracker = nonGit
      ? new NonGitBaselineService({
          projectRoot: row.rootPath,
          snapshotStore: input.paths.snapshotsDirectory,
        })
      : new GitBaselineService({
          projectRoot: row.rootPath,
          snapshotStore: input.paths.snapshotsDirectory,
        });
    const customRecoveryExecutor = input.options.factories?.executeRecoveryEffects;
    const executeEffects = customRecoveryExecutor !== undefined
      ? async (effects: readonly RecoveryEffectIntent[]) =>
          customRecoveryExecutor({ taskId, effects })
      : productionRuntimeOptions === undefined
        ? undefined
        : async (effects: readonly RecoveryEffectIntent[]) =>
            executeProductionRecoveryEffects(productionRuntimeOptions, {
              taskId,
              tracker,
              nonGit,
              ownerInstanceId: input.ownerInstanceId,
              effects,
            });
    const service = new RestartRecoveryService({
      database: input.database,
      tracker,
      ownerInstanceId: input.ownerInstanceId,
      now: input.options.now,
      inspectProcess: async (attempt) => {
        if (attempt.status === 'pending') {
          return {
            identity: 'unverifiable',
            terminalState: 'unknown',
            diagnostic: 'pending attempt has no durable process identity',
          };
        }
        return inspectProcess(attempt.pid, attempt.processStartedAt);
      },
      ...(executeEffects === undefined ? {} : { executeEffects }),
    });
    recoveryServices.set(taskId, service);
    return service;
  };

  const lifecycle = createLifecycleCoordinator({
    forceCleanupFailure: input.forceCleanupFailure,
    hooks: {
      stopAcceptingIntents: () => {
        /* flag owned by lifecycle */
      },
      persistStopAndReconcile: async () => {
        /* no active orchestrator at pure composition time */
      },
      cleanupJobs: async () => {
        if (input.supervisor !== undefined) {
          const maybeDisposable = input.supervisor as unknown as {
            dispose?: () => Promise<void>;
          };
          if (typeof maybeDisposable.dispose === 'function') {
            await maybeDisposable.dispose();
          }
        }
      },
      verifyProcessTrees: async () => {
        /* no tracked trees when supervisor shell idle */
      },
      flushJsonl: async () => {
        if (input.jsonlFlush !== undefined) {
          await input.jsonlFlush();
        }
      },
      closeWorkersAndWatchers: async () => {
        await taskSession.dispose();
        input.closedWorkers.value = true;
      },
      releaseLocks: async () => {
        /* no locks acquired at composition startup */
      },
      closeDatabase: () => {
        input.closeDatabaseImpl();
      },
      onAuthorizedExit: async () => {
        await input.getAuthorizedExitHook()?.();
      },
    },
  });

  let composition: ApplicationComposition;
  const controller: ApplicationControllerPort = {
    async dispatch(intent: TuiIntent): Promise<ControllerDispatchResult> {
      if (!lifecycle.isAcceptingIntents() && intent.type !== 'REQUEST_EXIT') {
        return {
          kind: 'rejected',
          reason: 'application is shutting down; new intents are not accepted',
        };
      }

      // Safe app exit.
      // - REQUEST_EXIT: Q/Esc when idle/terminal (blocked while task still active)
      // - CONFIRM_TERMINATION: Ctrl+C double-confirm force path — dispose session first
      if (intent.type === 'REQUEST_EXIT' || intent.type === 'CONFIRM_TERMINATION') {
        if (intent.type === 'CONFIRM_TERMINATION') {
          // Force-release the live session so the operator can always leave.
          await taskSession.dispose().catch(() => undefined);
        }
        const taskExitGate = taskSession.exitGate();
        if (!taskExitGate.allowed) {
          return {
            kind: 'exit_gate',
            gate: taskExitGate,
          };
        }
        const result: LifecycleShutdownResult = await lifecycle.shutdown({
          reason: intent.type === 'CONFIRM_TERMINATION'
            ? 'CONFIRM_TERMINATION'
            : 'REQUEST_EXIT',
        });
        return {
          kind: 'exit_gate',
          gate: {
            allowed: result.exitAllowed,
            reason: result.exitAllowed
              ? undefined
              : result.failures.map((failure) => failure.error).join('; ')
                || 'exit blocked: cleanup incomplete',
          },
        };
      }

      if (input.mode === 'diagnostic' || input.database.mode === 'diagnostic') {
        if (intent.type === 'NAVIGATE' && intent.screen === 'settings') {
          snapshotState = {
            ...snapshotState,
            screen: 'settings',
            statusMessage: 'Settings (diagnostic read-only)',
          };
          return {
            kind: 'snapshot',
            snapshot: {
              screen: 'settings',
              statusMessage: snapshotState.statusMessage,
            },
          };
        }
        return {
          kind: 'rejected',
          reason: 'diagnostic read-only mode: side-effect intents are disabled',
        };
      }

      if (
        snapshotState.screen === 'recovery'
        && (intent.type === 'SELECT_PROJECT' || intent.type === 'CREATE_TASK')
      ) {
        return {
          kind: 'rejected',
          reason: 'resolve the current recovery item before starting another task',
        };
      }

      if (intent.type === 'SET_UI_LANGUAGE') {
        try {
          composition.updateSettings({ uiLanguage: intent.language });
          snapshotState = {
            ...snapshotState,
            uiLanguage: intent.language,
            requirementsDraft: '',
            statusMessage: uiText(intent.language, 'commands.languageChanged'),
          };
          return {
            kind: 'snapshot',
            snapshot: {
              uiLanguage: snapshotState.uiLanguage,
              requirementsDraft: '',
              statusMessage: snapshotState.statusMessage,
            },
          };
        } catch (error) {
          return {
            kind: 'rejected',
            reason: `${uiText(snapshotState.uiLanguage, 'commands.languageChangeFailed')}: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      // Live session interrupt hold ([C]/[X]/[I]) is handled by TaskSessionController.
      // Restart recovery service only when there is no live session hold.
      if (
        intent.type === 'RECOVERY_INSPECT'
        || intent.type === 'RECOVERY_CONTINUE'
        || intent.type === 'RECOVERY_CANCEL'
      ) {
        const liveRecovery = await taskSession.dispatch(intent);
        if (liveRecovery !== undefined) {
          if (liveRecovery.kind === 'snapshot') {
            snapshotState = {
              ...snapshotState,
              ...liveRecovery.snapshot,
            };
          }
          return liveRecovery;
        }
        if (snapshotState.taskId !== intent.taskId) {
          return {
            kind: 'rejected',
            reason: 'recovery intent does not match the selected recovery task',
          };
        }
        try {
          const taskId = asTaskId(intent.taskId);
          const service = recoveryServiceFor(taskId);
          const operation =
            intent.type === 'RECOVERY_INSPECT'
              ? service.inspect(taskId)
              : intent.type === 'RECOVERY_CONTINUE'
                ? service.continueAfterInspection(taskId)
                : service.cancelAfterInspection(taskId);
          const result = await operation;
          const next = recoverySnapshotFromOperation(snapshotState, result);
          snapshotState = {
            ...snapshotState,
            ...next,
          };
          return {
            kind: 'snapshot',
            snapshot: next,
          };
        } catch (error) {
          return {
            kind: 'rejected',
            reason: `recovery operation failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      const taskResult = await taskSession.dispatch(intent);
      if (taskResult !== undefined) {
        if (taskResult.kind === 'snapshot') {
          snapshotState = {
            ...snapshotState,
            ...taskResult.snapshot,
          };
        } else if (taskResult.kind === 'rejected' && intent.type === 'SELECT_PROJECT') {
          // Keep the editable project fallback visible when automatic or manual
          // selection fails. Preserve the typed rejection for callers while
          // making the reason available to the first render.
          snapshotState = {
            ...snapshotState,
            screen: 'project',
            projectPathDraft: intent.projectPath,
            error: taskResult.reason,
            statusMessage: taskResult.reason,
          };
        }
        return taskResult;
      }

      if (intent.type === 'NAVIGATE') {
        snapshotState = {
          ...snapshotState,
          screen: intent.screen,
          statusMessage: `Screen: ${intent.screen}`,
        };
        return {
          kind: 'snapshot',
          snapshot: {
            screen: intent.screen,
            statusMessage: snapshotState.statusMessage,
          },
        };
      }

      if (
        intent.type === 'APPROVE'
        || intent.type === 'REQUEST_REWORK'
        || intent.type === 'REQUEST_CANCEL_OR_INTERRUPT'
        || intent.type === 'REQUEST_PAUSE_AFTER_RUN'
        || intent.type === 'QUEUE_MESSAGE'
      ) {
        if (snapshotState.screen === 'recovery') {
          if (intent.type === 'REQUEST_CANCEL_OR_INTERRUPT') {
            return {
              kind: 'rejected',
              reason: 'recovery action must be confirmed through the control flow',
            };
          }
          return {
            kind: 'rejected',
            reason: 'action not legal in recovery without explicit allowed intent',
          };
        }
      }

      return { kind: 'accepted' };
    },
  };

  composition = {
    mode: input.mode,
    paths: input.paths,
    get settings() {
      return input.getEffective();
    },
    get persistedSettings() {
      return input.getPersisted();
    },
    get effectiveSettings() {
      return input.getEffective();
    },
    get runtimeOnlyOverrides() {
      return input.getRuntimeOverrides();
    },
    database: input.database,
    ...(input.diagnostics !== undefined
      ? { diagnostics: input.diagnostics }
      : {}),
    ...(input.repositories === undefined ? {} : { repositories: input.repositories }),
    ...(input.budgetController === undefined
      ? {}
      : { budgetController: input.budgetController }),
    ownerInstanceId: input.ownerInstanceId,
    stages: input.stages,
    sideEffects: input.sideEffects,
    ...(input.reconcileReport === undefined
      ? {}
      : { reconcileReport: input.reconcileReport }),
    lifecycle,
    controller,
    get acceptingIntents() {
      return lifecycle.isAcceptingIntents();
    },
    testHooks: {
      clearCleanupFailure: () => {
        lifecycle.clearCleanupFailure();
      },
    },
    snapshot(): TuiSnapshot {
      return snapshotState;
    },
    async dispatch(intent: TuiIntent): Promise<ControllerDispatchResult> {
      return controller.dispatch(intent);
    },
    close(): void {
      if (closed) return;
      closed = true;
      input.closeDatabaseImpl();
    },
    isDatabaseClosed(): boolean {
      return input.getDatabaseClosed();
    },
    updateSettings(next: Partial<AppSettings>): AppSettings {
      // Persist only validated persisted state — never copy env override.
      const merged = { ...input.getPersisted(), ...next };
      // Prevent accidental env elevation being written:
      if (
        next.realAiTestsOptIn === true
        && input.getPersisted().realAiTestsOptIn === false
        && input.getRuntimeOverrides().includes('realAiTestsOptIn')
        && next.realAiTestsOptIn !== input.getPersisted().realAiTestsOptIn
      ) {
        // Only allow explicit user opt-in via next.realAiTestsOptIn if they
        // intentionally set it; env-only elevation is already in effective.
        // If caller passes realAiTestsOptIn from effective by mistake, refuse.
        if (input.environment.TRIAGENT_REAL_AI_TESTS !== undefined
          && next.realAiTestsOptIn === true
          && input.getPersisted().realAiTestsOptIn === false
          && Object.keys(next).length > 1) {
          // Unrelated multi-field updates must not copy env true — strip it.
          merged.realAiTestsOptIn = input.getPersisted().realAiTestsOptIn;
        }
      }
      // Always strip env-elevated true unless persisted was already true or
      // the update explicitly only sets realAiTestsOptIn as user opt-in.
      if (
        input.getRuntimeOverrides().includes('realAiTestsOptIn')
        && merged.realAiTestsOptIn === true
        && input.getPersisted().realAiTestsOptIn === false
      ) {
        // User may explicitly persist opt-in by updating only that field.
        const keys = Object.keys(next);
        if (!(keys.length === 1 && keys[0] === 'realAiTestsOptIn')) {
          merged.realAiTestsOptIn = false;
        }
      }

      const validated = validateSettings(merged);
      if (!validated.ok) {
        throw new Error(validated.error);
      }
      const pathChanged =
        validated.settings.codexCliPath !== input.getPersisted().codexCliPath
        || validated.settings.claudeCliPath !== input.getPersisted().claudeCliPath
        || validated.settings.grokCliPath !== input.getPersisted().grokCliPath;
      saveSettings(input.paths.settingsPath, validated.settings);
      input.setPersisted(validated.settings);

      // Recompute effective from new persisted + env.
      const envOptIn =
        input.environment.TRIAGENT_REAL_AI_TESTS === '1'
        || input.environment.TRIAGENT_REAL_AI_TESTS === 'true'
        || input.environment.TRIAGENT_REAL_AI_TESTS === 'yes';
      const overrides: (keyof AppSettings)[] = [];
      let effective = validated.settings;
      if (envOptIn && !validated.settings.realAiTestsOptIn) {
        effective = Object.freeze({
          ...validated.settings,
          realAiTestsOptIn: true,
        });
        overrides.push('realAiTestsOptIn');
      }
      input.setEffective(effective);
      input.setRuntimeOverrides(overrides);

      const notes: string[] = [];
      if (pathChanged) {
        notes.push('CLI path changed — capability re-probe required before use');
      }
      if (overrides.includes('realAiTestsOptIn')) {
        notes.push(
          'Runtime-only override: TRIAGENT_REAL_AI_TESTS (not persisted)',
        );
      }
      if (notes.length > 0) {
        snapshotState = {
          ...snapshotState,
          statusMessage: notes.join('; '),
        };
      }
      return validated.settings;
    },
  };

  // Allow CLI to install authorized exit hook after compose.
  (composition as ApplicationComposition & {
    setOnAuthorizedExit?: (hook: () => void | Promise<void>) => void;
  }).setOnAuthorizedExit = (hook) => {
    input.setAuthorizedExitHook(hook);
  };

  composition.setTaskProgressSink = (sink) => {
    taskProgressSink = sink;
  };

  return composition;
}

export type { TaskId };
