import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  composeApplication,
  runProductionCapabilityProbes,
  type ApplicationComposition,
  type StartupStageName,
} from '../../../src/app/app-context.js';
import { runStartupReconcile } from '../../../src/app/startup-reconcile.js';
import { resolveAppPaths } from '../../../src/config/app-paths.js';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  loadSettingsBundle,
  saveSettings,
  validateSettings,
} from '../../../src/config/settings.js';
import { asTaskId } from '../../../src/domain/ids.js';
import {
  openDatabase,
  type OpenedDatabase,
} from '../../../src/persistence/database.js';
import {
  baselineManifestChecksum,
  type BaselineManifest,
} from '../../../src/tracking/baseline-manifest.js';
import type { WorkflowSnapshot } from '../../../src/workflow/states.js';

const temporaryDirectories: string[] = [];
const compositions: ApplicationComposition[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function buildValidAttemptManifest(input: {
  readonly taskId: string;
  readonly baselineId: string;
  readonly attemptId: string;
  readonly projectRoot: string;
  readonly createdAt: string;
  readonly checksumOverride?: string;
}): BaselineManifest {
  const canonicalRoot = realpathSync.native(input.projectRoot);
  const withoutChecksum = {
    version: 1 as const,
    status: 'complete' as const,
    kind: 'attempt' as const,
    taskId: input.taskId,
    baselineId: input.baselineId,
    attemptId: input.attemptId,
    attemptNumber: 1,
    parentTaskBaselineId: 'parent-task-base-1',
    createdAt: input.createdAt,
    git: {
      canonicalRoot,
      headSha: 'a'.repeat(40),
      branch: 'main',
      detached: false,
      statusRaw: '',
      statusEntries: [] as const,
    },
    files: [] as const,
    exclusions: [] as const,
  };
  const checksum =
    input.checksumOverride
    ?? baselineManifestChecksum(withoutChecksum);
  return {
    ...withoutChecksum,
    checksum,
  };
}

afterEach(async () => {
  for (const composition of compositions.splice(0).reverse()) {
    await composition.lifecycle.shutdown({ reason: 'test_cleanup' }).catch(() => undefined);
    composition.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  delete process.env.TRIAGENT_APP_ROOT;
});

function seedIncompleteTask(
  dbPath: string,
  taskIdValue: string,
  projectRoot: string,
): void {
  const opened = openDatabase(dbPath);
  expect(opened.mode).toBe('read-write');
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  const now = new Date().toISOString();
  const taskId = asTaskId(taskIdValue);
  opened.connection
    .prepare(
      'INSERT INTO projects(id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
    )
    .run('project-1', projectRoot, now, now);
  const snapshot: WorkflowSnapshot = {
    state: 'interrupted_needs_inspection',
    taskId,
    requirementVersion: 1,
    reworkCount: 0,
    maxReworks: 3,
    pauseAfterAttempt: false,
    activeAttemptId: asTaskId('attempt-1') as never,
    inspectionResumeTargetState: 'implementing',
  };
  // Use string attempt id properly via domain helper pattern in SQL seed
  const snapshotJson = JSON.stringify({
    ...snapshot,
    activeAttemptId: 'attempt-1',
  });
  opened.connection
    .prepare(
      `INSERT INTO tasks(
         id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      taskIdValue,
      'project-1',
      'interrupted_needs_inspection',
      1,
      snapshotJson,
      now,
      now,
    );
  opened.connection
    .prepare(
      `INSERT INTO run_attempts(
         id, task_id, role, status, baseline_id, requirement_version,
         started_at, pid, process_started_at
       ) VALUES (?, ?, 'implementer', 'active', ?, 1, ?, ?, ?)`,
    )
    .run(
      'attempt-1',
      taskIdValue,
      'baseline-1',
      now,
      4242,
      now,
    );
  opened.connection
    .prepare(
      `INSERT INTO pending_actions(
         id, task_id, idempotency_key, action_type, payload_json, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'process-cleanup', ?, 'intent', ?, ?)`,
    )
    .run(
      'action-1',
      taskIdValue,
      `${taskIdValue}:process-cleanup:attempt-1`,
      JSON.stringify({
        attemptId: 'attempt-1',
        stopIntent: 'interrupt',
        jobObjectId: 'job-1',
        replayPolicy: 'never-auto-replay',
      }),
      now,
      now,
    );
  // Durable complete baseline via canonical checksum + validator shape.
  const manifest = buildValidAttemptManifest({
    taskId: taskIdValue,
    baselineId: 'baseline-1',
    attemptId: 'attempt-1',
    projectRoot,
    createdAt: now,
  });
  opened.connection
    .prepare(
      `INSERT INTO file_baselines(
         id, task_id, attempt_id, status, manifest_json, created_at, completed_at
       ) VALUES (?, ?, ?, 'complete', ?, ?, ?)`,
    )
    .run(
      'baseline-1',
      taskIdValue,
      'attempt-1',
      JSON.stringify(manifest),
      now,
      now,
    );
  opened.close();
}

function seedPreAttemptAwaitingTask(
  dbPath: string,
  taskIdValue: string,
  projectRoot: string,
): void {
  const opened = openDatabase(dbPath);
  expect(opened.mode).toBe('read-write');
  if (opened.mode !== 'read-write') {
    throw new Error(opened.diagnostics.error);
  }
  const now = new Date().toISOString();
  opened.connection
    .prepare(
      'INSERT INTO projects(id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
    )
    .run('project-pre-attempt', projectRoot, now, now);
  const snapshot: WorkflowSnapshot = {
    state: 'awaiting_user',
    taskId: asTaskId(taskIdValue),
    requirementVersion: 1,
    reworkCount: 0,
    maxReworks: 3,
    pauseAfterAttempt: false,
    awaitingReason: 'Claude CLI is unavailable',
    allowedAwaitingActions: ['retry_environment', 'cancel'],
  };
  opened.connection
    .prepare(
      `INSERT INTO tasks(
         id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at
       ) VALUES (?, ?, 'awaiting_user', 2, ?, ?, ?)`,
    )
    .run(
      taskIdValue,
      'project-pre-attempt',
      JSON.stringify(snapshot),
      now,
      now,
    );
  opened.close();
}

describe('startup composition and reconcile', () => {
  it('composes in deterministic stage order and never starts workers before database health', async () => {
    const root = temporaryDirectory('triagent-compose-');
    process.env.TRIAGENT_APP_ROOT = root;

    const stageOrder: StartupStageName[] = [];
    const stageEvents: { name: StartupStageName; ok: boolean; detail?: string }[] = [];
    const constructionOrder: string[] = [];
    const composition = await composeApplication({
      appRootOverride: root,
      skipHealthProbes: true,
      skipProcessHost: true,
      onStage(stage) {
        stageOrder.push(stage.name);
        stageEvents.push({
          name: stage.name,
          ok: stage.ok,
          detail: stage.detail,
        });
      },
      factories: {
        createBudgetController: (input) => {
          constructionOrder.push('budget');
          expect(input.database.mode).toBe('read-write');
          return { kind: 'budget_controller_handle', taskId: input.taskId };
        },
        runCapabilityProbes: async () => {
          constructionOrder.push('probes');
          return { reports: [], adapterStarted: false };
        },
      },
    });
    compositions.push(composition);

    expect(stageOrder).toEqual([
      'resolve_app_paths',
      'open_diagnose_database',
      'construct_repositories',
      'construct_project_guard',
      'construct_budget_controller',
      'construct_process_host_worker_managers',
      'adapter_capability_health_probes',
      'startup_reconcile',
      'ready_for_ink_render',
    ]);

    const dbIndex = stageOrder.indexOf('open_diagnose_database');
    const budgetIndex = stageOrder.indexOf('construct_budget_controller');
    const workerIndex = stageOrder.indexOf('construct_process_host_worker_managers');
    const probeIndex = stageOrder.indexOf('adapter_capability_health_probes');
    expect(dbIndex).toBeGreaterThanOrEqual(0);
    expect(budgetIndex).toBeGreaterThan(dbIndex);
    expect(workerIndex).toBeGreaterThan(budgetIndex);
    expect(probeIndex).toBeGreaterThan(workerIndex);

    // Real construction happened for budget; probes were explicitly skipped (not ok).
    expect(constructionOrder).toContain('budget');
    expect(composition.budgetController).toBeDefined();
    const probeStage = stageEvents.find(
      (stage) => stage.name === 'adapter_capability_health_probes',
    );
    expect(probeStage).toBeDefined();
    expect(probeStage!.ok).toBe(false);
    expect(probeStage!.detail).toMatch(/skip/i);

    expect(composition.mode).toBe('read-write');
    expect(composition.paths.root).toBe(root);
    expect(composition.paths.databasePath).toBe(join(root, 'triagent.db'));
    expect(existsSync(composition.paths.logsDirectory)).toBe(true);
    expect(existsSync(composition.paths.snapshotsDirectory)).toBe(true);
    expect(composition.sideEffects.workerStarted).toBe(false);
    expect(composition.sideEffects.adapterStarted).toBe(false);
    expect(composition.sideEffects.projectLockAcquired).toBe(false);
    expect(composition.sideEffects.processHostStarted).toBe(false);
    expect(composition.sideEffects.watcherStarted).toBe(false);
    expect(composition.sideEffects.nativeHelperStarted).toBe(false);
  });

  it('enters diagnostic read-only mode for corrupt DB without starting side effects or mutating the file', async () => {
    const root = temporaryDirectory('triagent-corrupt-compose-');
    const dbPath = join(root, 'triagent.db');
    mkdirSync(root, { recursive: true });
    const corruptBytes = Buffer.from('not a sqlite database\0\x01\x02', 'binary');
    writeFileSync(dbPath, corruptBytes);
    const before = readFileSync(dbPath);

    const composition = await composeApplication({
      appRootOverride: root,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(composition);

    expect(composition.mode).toBe('diagnostic');
    expect(composition.diagnostics).toBeDefined();
    expect(composition.diagnostics?.error).toMatch(/database|malformed|file|sqlite/i);
    expect(composition.sideEffects.workerStarted).toBe(false);
    expect(composition.sideEffects.adapterStarted).toBe(false);
    expect(composition.sideEffects.projectLockAcquired).toBe(false);
    expect(composition.sideEffects.processHostStarted).toBe(false);
    expect(composition.sideEffects.watcherStarted).toBe(false);
    expect(composition.sideEffects.nativeHelperStarted).toBe(false);
    expect(composition.snapshot().screen).toBe('recovery');
    expect(composition.snapshot().error).toMatch(/diagnostic|database|corrupt|unreadable/i);

    // Must not overwrite/quarantine/delete the DB automatically.
    expect(existsSync(dbPath)).toBe(true);
    expect(readFileSync(dbPath)).toEqual(before);

    // Shutdown remains safe.
    const shutdown = await composition.lifecycle.shutdown({ reason: 'test_corrupt_exit' });
    expect(shutdown.exitAllowed).toBe(true);
    expect(shutdown.stagesCompleted).toContain('close_database');
  });

  it('lists incomplete tasks with evidence and never auto-resumes non-idempotent work', async () => {
    const root = temporaryDirectory('triagent-reconcile-');
    const projectRoot = temporaryDirectory('triagent-reconcile-project-');
    const dbPath = join(root, 'triagent.db');
    mkdirSync(join(root, 'logs'), { recursive: true });
    mkdirSync(join(root, 'snapshots'), { recursive: true });
    seedIncompleteTask(dbPath, 'task-recover-1', projectRoot);

    const composition = await composeApplication({
      appRootOverride: root,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(composition);

    expect(composition.mode).toBe('read-write');
    const report = composition.reconcileReport;
    expect(report).toBeDefined();
    expect(report!.items.length).toBeGreaterThanOrEqual(1);

    const item = report!.items.find((entry) => entry.taskId === 'task-recover-1');
    expect(item).toBeDefined();
    expect(item!.status).toBe('interrupted_needs_inspection');
    expect(item!.pendingActions.length).toBeGreaterThan(0);
    expect(item!.processIdentity).toMatchObject({
      pid: 4242,
      jobObjectId: 'job-1',
    });
    expect(item!.baselineIds).toEqual(
      expect.objectContaining({
        attemptId: 'attempt-1',
        baselineId: 'baseline-1',
      }),
    );
    expect(item!.allowedNextActions.length).toBeGreaterThan(0);
    expect(item!.autoResume).toBe(false);
    expect(item!.decision.kind === 'blocked' || item!.decision.kind === 'noop').toBe(
      true,
    );
    if (item!.decision.kind === 'blocked') {
      expect(item!.decision.automaticExternalExecution).toBe(false);
    }

    // Direct reconcile API also returns typed evidence for the recovery UI.
    const direct = await runStartupReconcile({
      database: composition.database as OpenedDatabase,
      ownerInstanceId: composition.ownerInstanceId,
    });
    expect(direct.items.some((entry) => entry.taskId === 'task-recover-1')).toBe(true);
  });

  it('does not enter Recovery for an awaiting-user task that never started an attempt and has no lock', async () => {
    const root = temporaryDirectory('triagent-pre-attempt-reconcile-');
    const projectRoot = temporaryDirectory('triagent-pre-attempt-project-');
    const dbPath = join(root, 'triagent.db');
    seedPreAttemptAwaitingTask(dbPath, 'task-pre-attempt-awaiting', projectRoot);

    const composition = await composeApplication({
      appRootOverride: root,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(composition);

    expect(composition.reconcileReport?.items).toEqual([]);
    expect(composition.snapshot().screen).toBe('project');
    expect(composition.snapshot().error).toBeUndefined();
  });

  it('resolves app paths under override root, rejects traversal, and never falls back to cwd', () => {
    const root = temporaryDirectory('triagent-paths-');
    const paths = resolveAppPaths({ appRootOverride: root });
    expect(paths.root).toBe(root);
    expect(paths.databasePath.startsWith(root)).toBe(true);
    expect(paths.logsDirectory.startsWith(root)).toBe(true);
    expect(paths.snapshotsDirectory.startsWith(root)).toBe(true);
    expect(paths.nativeDiagnosticsDirectory.startsWith(root)).toBe(true);
    expect(paths.cliCompatibilityCachePath).toBe(
      join(root, 'cli-compatibility-cache.json'),
    );
    expect(paths.databasePath).not.toContain(process.cwd());

    // Use raw traversal strings (not path.join, which normalizes ".." away).
    expect(() =>
      resolveAppPaths({ appRootOverride: `${root}\\..\\escape` }),
    ).toThrow(/override|traversal|untrusted|escape/i);

    expect(() =>
      resolveAppPaths({
        appRootOverride: `${root}\\nested\\..\\..\\escape`,
      }),
    ).toThrow(/override|traversal|untrusted|escape/i);
  });

  it('validates and persists settings without credentials and rejects env opt-in silent persistence', async () => {
    const root = temporaryDirectory('triagent-settings-');
    mkdirSync(root, { recursive: true });
    const settingsPath = join(root, 'settings.json');

    expect(DEFAULT_SETTINGS.totalRunningBudgetMinutes).toBe(60);
    expect(DEFAULT_SETTINGS.reworkLimit).toBe(3);
    expect(DEFAULT_SETTINGS.realAiTestsOptIn).toBe(false);

    const valid = validateSettings({
      ...DEFAULT_SETTINGS,
      codexCliPath: 'C:\\Tools\\codex.exe',
      totalRunningBudgetMinutes: 30,
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw new Error(valid.error);
    saveSettings(settingsPath, valid.settings);
    const loaded = loadSettings(settingsPath);
    expect(loaded.codexCliPath).toBe('C:\\Tools\\codex.exe');
    expect(loaded.totalRunningBudgetMinutes).toBe(30);
    expect(loaded.realAiTestsOptIn).toBe(false);

    expect(
      validateSettings({
        ...DEFAULT_SETTINGS,
        totalRunningBudgetMinutes: Number.POSITIVE_INFINITY,
      }).ok,
    ).toBe(false);
    expect(
      validateSettings({
        ...DEFAULT_SETTINGS,
        reworkLimit: 99,
      }).ok,
    ).toBe(false);
    expect(
      validateSettings({
        ...DEFAULT_SETTINGS,
        unknownKey: true,
      } as never).ok,
    ).toBe(false);

    // Environment opt-in is runtime-only; disk stays false.
    process.env.TRIAGENT_REAL_AI_TESTS = '1';
    try {
      const bundle = loadSettingsBundle(settingsPath, {
        environment: process.env,
      });
      expect(bundle.persisted.realAiTestsOptIn).toBe(false);
      expect(bundle.effective.realAiTestsOptIn).toBe(true);
      expect(bundle.runtimeOnlyOverrides).toContain('realAiTestsOptIn');

      // Unrelated update under env=true must keep disk false.
      const composition = await composeApplication({
        appRootOverride: root,
        skipHealthProbes: true,
        skipProcessHost: true,
        environment: {
          ...process.env,
          TRIAGENT_REAL_AI_TESTS: '1',
        },
      });
      compositions.push(composition);
      expect(composition.persistedSettings.realAiTestsOptIn).toBe(false);
      expect(composition.effectiveSettings.realAiTestsOptIn).toBe(true);
      composition.updateSettings({ totalRunningBudgetMinutes: 45 });
      const diskAfter = loadSettings(composition.paths.settingsPath);
      expect(diskAfter.realAiTestsOptIn).toBe(false);
      expect(diskAfter.totalRunningBudgetMinutes).toBe(45);
      expect(composition.snapshot().statusMessage ?? '').toMatch(
        /runtime|override|TRIAGENT_REAL_AI_TESTS/i,
      );
    } finally {
      delete process.env.TRIAGENT_REAL_AI_TESTS;
    }
  });

  it('persists a typed UI language intent and restores it on restart', async () => {
    const root = temporaryDirectory('triagent-language-setting-');
    const composition = await composeApplication({
      appRootOverride: root,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(composition);
    const initialLanguage = composition.snapshot().uiLanguage;
    const targetLanguage = initialLanguage === 'zh-CN' ? 'en' : 'zh-CN';

    const result = await composition.dispatch({
      type: 'SET_UI_LANGUAGE',
      language: targetLanguage,
    });

    expect(result).toMatchObject({
      kind: 'snapshot',
      snapshot: { uiLanguage: targetLanguage },
    });
    expect(composition.snapshot().uiLanguage).toBe(targetLanguage);
    expect(loadSettings(composition.paths.settingsPath).uiLanguage).toBe(targetLanguage);

    composition.close();
    const restarted = await composeApplication({
      appRootOverride: root,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(restarted);
    expect(restarted.snapshot().uiLanguage).toBe(targetLanguage);
  });

  it('rejects a language change when settings persistence fails and keeps the old language', async () => {
    const root = temporaryDirectory('triagent-language-setting-failure-');
    const composition = await composeApplication({
      appRootOverride: root,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(composition);
    const initialLanguage = composition.snapshot().uiLanguage;
    const targetLanguage = initialLanguage === 'zh-CN' ? 'en' : 'zh-CN';
    mkdirSync(composition.paths.settingsPath);

    const result = await composition.dispatch({
      type: 'SET_UI_LANGUAGE',
      language: targetLanguage,
    });

    expect(result.kind).toBe('rejected');
    expect(composition.snapshot().uiLanguage).toBe(initialLanguage);
  });

  it('rejects relative LOCALAPPDATA and reparse/symlink roots fail-closed', () => {
    expect(() =>
      resolveAppPaths({
        environment: { LOCALAPPDATA: 'relative\\appdata' },
        createDirectories: false,
      }),
    ).toThrow(/LOCALAPPDATA|absolute|untrusted/i);

    expect(() =>
      resolveAppPaths({
        environment: { LOCALAPPDATA: 'C:\\Users\\..\\Windows' },
        createDirectories: false,
      }),
    ).toThrow(/LOCALAPPDATA|traversal|untrusted/i);

    const root = temporaryDirectory('triagent-symlink-target-');
    const linkParent = temporaryDirectory('triagent-symlink-parent-');
    const linkPath = join(linkParent, 'TriAgentLink');
    try {
      symlinkSync(root, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // Junction/symlink creation may require privileges; skip if unsupported.
      return;
    }
    expect(() =>
      resolveAppPaths({
        appRootOverride: linkPath,
        createDirectories: true,
      }),
    ).toThrow(/reparse|symlink|untrusted|junction/i);
  });

  it('production probes are real CommandProbe runs; deferred/empty is not-ok', async () => {
    const root = temporaryDirectory('triagent-probes-real-');
    const probeOrder: string[] = [];
    const composition = await composeApplication({
      appRootOverride: root,
      skipProcessHost: true,
      // Do NOT skip health probes — exercise production default path with injection.
      factories: {
        runCapabilityProbes: async (input) => {
          probeOrder.push('probes');
          expect(input.settings).toBeDefined();
          expect(input.supervisor).toBeDefined();
          expect(input.cliCompatibilityCachePath).toBe(
            join(root, 'cli-compatibility-cache.json'),
          );
          // Simulate real concrete reports (not deferred).
          return {
            reports: [
              { kind: 'codex', status: 'missing', reason: 'not installed' },
              { kind: 'claude', status: 'missing', reason: 'not installed' },
              { kind: 'grok', status: 'missing', reason: 'not installed' },
            ],
            adapterStarted: false,
          };
        },
      },
    });
    compositions.push(composition);
    expect(probeOrder).toEqual(['probes']);
    const probeStage = composition.stages.find(
      (stage) => stage.name === 'adapter_capability_health_probes',
    );
    expect(probeStage?.ok).toBe(true);

    // Deferred reports must fail closed.
    const root2 = temporaryDirectory('triagent-probes-deferred-');
    const deferred = await composeApplication({
      appRootOverride: root2,
      skipProcessHost: true,
      factories: {
        runCapabilityProbes: async () => ({
          reports: [{ kind: 'composition', status: 'deferred', reason: 'bad' }],
          adapterStarted: false,
        }),
      },
    });
    compositions.push(deferred);
    const deferredStage = deferred.stages.find(
      (stage) => stage.name === 'adapter_capability_health_probes',
    );
    expect(deferredStage?.ok).toBe(false);
    expect(deferred.reconcileReport).toBeUndefined();
    expect(deferred.snapshot().screen).toBe('recovery');

    // Empty reports fail closed.
    const root3 = temporaryDirectory('triagent-probes-empty-');
    const empty = await composeApplication({
      appRootOverride: root3,
      skipProcessHost: true,
      factories: {
        runCapabilityProbes: async () => ({
          reports: [],
          adapterStarted: false,
        }),
      },
    });
    compositions.push(empty);
    expect(
      empty.stages.find((stage) => stage.name === 'adapter_capability_health_probes')
        ?.ok,
    ).toBe(false);
  });

  it('production probes use configured CLI paths as exact argv executables', async () => {
    const root = temporaryDirectory('triagent-probe-paths-');
    mkdirSync(root, { recursive: true });
    const settingsPath = join(root, 'settings.json');
    const codexPath = 'C:\\Tools\\CustomCodex\\codex.cmd';
    const claudePath = 'C:\\Tools\\CustomClaude\\claude.exe';
    const grokPath = 'D:\\bin\\my-grok';
    saveSettings(settingsPath, {
      ...DEFAULT_SETTINGS,
      codexCliPath: codexPath,
      claudeCliPath: claudePath,
      grokCliPath: grokPath,
    });

    const calls: { kind: string; executable: string; args: readonly string[] }[] = [];
    const probeCalls: string[] = [];

    // Direct production runner with injected supervisor exec boundary.
    const recordingSupervisor = {
      async start(request: {
        readonly attemptId: { toString(): string };
        readonly executable: string;
        readonly args: readonly string[];
      }) {
        const kind = request.executable === codexPath
          ? 'codex'
          : request.executable === claudePath
            ? 'claude'
            : request.executable === grokPath
              ? 'grok'
              : 'unknown';
        calls.push({
          kind,
          executable: request.executable,
          args: [...request.args],
        });
        probeCalls.push(request.executable);
        // Fail closed as missing binary for custom paths.
        throw Object.assign(
          new Error(`spawn ${request.executable} ENOENT`),
          { code: 'ENOENT' },
        );
      },
      async requestGracefulStop() {
        /* no-op */
      },
      async forceStopTree() {
        /* no-op */
      },
      async wait(attemptId: { toString(): string }) {
        return {
          attemptId,
          pid: 0,
          exitCode: 1,
          signal: null,
          reason: 'exited' as const,
          endedAt: new Date().toISOString(),
        };
      },
      subscribe() {
        return () => undefined;
      },
    };

    const result = await runProductionCapabilityProbes({
      settings: {
        ...DEFAULT_SETTINGS,
        codexCliPath: codexPath,
        claudeCliPath: claudePath,
        grokCliPath: grokPath,
      },
      supervisor: recordingSupervisor as never,
      cliCompatibilityCachePath: join(root, 'cli-compatibility-cache.json'),
    });

    // Exact configured paths were invoked (no fixed "codex"/"claude"/"grok" names).
    expect(probeCalls).toEqual(
      expect.arrayContaining([codexPath, claudePath, grokPath]),
    );
    expect(
      probeCalls.every(
        (path) => path === codexPath || path === claudePath || path === grokPath,
      ),
    ).toBe(true);
    expect(probeCalls).not.toContain('codex');
    expect(probeCalls).not.toContain('claude');
    expect(probeCalls).not.toContain('grok');

    // Role mapping: each custom path used for its agent.
    const byKind = new Map(calls.map((call) => [call.kind, call.executable]));
    expect(byKind.get('codex')).toBe(codexPath);
    expect(byKind.get('claude')).toBe(claudePath);
    expect(byKind.get('grok')).toBe(grokPath);
    expect(result.adapterStarted).toBe(false);
    expect(result.reports.map((report) => report.kind).sort()).toEqual([
      'claude',
      'codex',
      'grok',
    ]);

    // Path failure through composition marks probe stage not-ok.
    const composition = await composeApplication({
      appRootOverride: root,
      skipProcessHost: true,
      factories: {
        runCapabilityProbes: async () => {
          throw new Error(`configured CLI path probe failed: ${codexPath}`);
        },
      },
    });
    compositions.push(composition);
    expect(composition.effectiveSettings.codexCliPath).toBe(codexPath);
    expect(composition.effectiveSettings.claudeCliPath).toBe(claudePath);
    expect(composition.effectiveSettings.grokCliPath).toBe(grokPath);
    const probeStage = composition.stages.find(
      (stage) => stage.name === 'adapter_capability_health_probes',
    );
    expect(probeStage?.ok).toBe(false);
    expect(composition.reconcileReport).toBeUndefined();
    expect(composition.snapshot().screen).toBe('recovery');
  });

  it('rejects empty-object and missing completed_at baselines', async () => {
    const root = temporaryDirectory('triagent-baseline-strict-');
    const projectRoot = temporaryDirectory('triagent-baseline-strict-project-');
    const dbPath = join(root, 'triagent.db');
    mkdirSync(join(root, 'logs'), { recursive: true });
    mkdirSync(join(root, 'snapshots'), { recursive: true });
    const opened = openDatabase(dbPath);
    if (opened.mode !== 'read-write') throw new Error('rw');
    const now = new Date().toISOString();
    opened.connection
      .prepare(
        'INSERT INTO projects(id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run('project-strict', projectRoot, now, now);

    // Task with {} manifest
    opened.connection
      .prepare(
        `INSERT INTO tasks(
           id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-empty-manifest',
        'project-strict',
        'interrupted_needs_inspection',
        1,
        JSON.stringify({
          state: 'interrupted_needs_inspection',
          taskId: 'task-empty-manifest',
          requirementVersion: 1,
          reworkCount: 0,
          maxReworks: 3,
          pauseAfterAttempt: false,
          activeAttemptId: 'attempt-empty',
          inspectionResumeTargetState: 'implementing',
        }),
        now,
        now,
      );
    opened.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, role, status, baseline_id, requirement_version,
           started_at, pid, process_started_at
         ) VALUES (?, ?, 'implementer', 'active', ?, 1, ?, ?, ?)`,
      )
      .run('attempt-empty', 'task-empty-manifest', 'baseline-empty', now, 3001, now);
    opened.connection
      .prepare(
        `INSERT INTO file_baselines(
           id, task_id, attempt_id, status, manifest_json, created_at, completed_at
         ) VALUES (?, ?, ?, 'complete', ?, ?, ?)`,
      )
      .run(
        'baseline-empty',
        'task-empty-manifest',
        'attempt-empty',
        '{}',
        now,
        now,
      );

    // Task with complete status but missing completed_at
    opened.connection
      .prepare(
        `INSERT INTO tasks(
           id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-no-completed-at',
        'project-strict',
        'interrupted_needs_inspection',
        1,
        JSON.stringify({
          state: 'interrupted_needs_inspection',
          taskId: 'task-no-completed-at',
          requirementVersion: 1,
          reworkCount: 0,
          maxReworks: 3,
          pauseAfterAttempt: false,
          activeAttemptId: 'attempt-nocomp',
          inspectionResumeTargetState: 'implementing',
        }),
        now,
        now,
      );
    opened.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, role, status, baseline_id, requirement_version,
           started_at, pid, process_started_at
         ) VALUES (?, ?, 'implementer', 'active', ?, 1, ?, ?, ?)`,
      )
      .run('attempt-nocomp', 'task-no-completed-at', 'baseline-nocomp', now, 3002, now);
    const validShape = buildValidAttemptManifest({
      taskId: 'task-no-completed-at',
      baselineId: 'baseline-nocomp',
      attemptId: 'attempt-nocomp',
      projectRoot,
      createdAt: now,
    });
    opened.connection
      .prepare(
        `INSERT INTO file_baselines(
           id, task_id, attempt_id, status, manifest_json, created_at, completed_at
         ) VALUES (?, ?, ?, 'complete', ?, ?, NULL)`,
      )
      .run(
        'baseline-nocomp',
        'task-no-completed-at',
        'attempt-nocomp',
        JSON.stringify(validShape),
        now,
      );
    opened.close();

    const composition = await composeApplication({
      appRootOverride: root,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(composition);

    const emptyManifest = composition.reconcileReport?.items.find(
      (entry) => entry.taskId === 'task-empty-manifest',
    );
    expect(emptyManifest?.baselineEvidence.status).toMatch(/invalid|incomplete|mismatched/);
    expect(emptyManifest?.autoResume).toBe(false);
    expect(emptyManifest?.allowedNextActions).not.toContain('continue');

    const noCompletedAt = composition.reconcileReport?.items.find(
      (entry) => entry.taskId === 'task-no-completed-at',
    );
    expect(noCompletedAt?.baselineEvidence.status).toMatch(/invalid|incomplete/);
    expect(noCompletedAt?.autoResume).toBe(false);
    expect(noCompletedAt?.allowedNextActions).not.toContain('continue');
  });

  it('rejects forged checksum and checksum-mismatched baselines with no autoResume', async () => {
    const root = temporaryDirectory('triagent-baseline-forged-');
    const projectRoot = temporaryDirectory('triagent-baseline-forged-project-');
    const dbPath = join(root, 'triagent.db');
    mkdirSync(join(root, 'logs'), { recursive: true });
    mkdirSync(join(root, 'snapshots'), { recursive: true });
    const opened = openDatabase(dbPath);
    if (opened.mode !== 'read-write') throw new Error('rw');
    const now = new Date().toISOString();
    opened.connection
      .prepare(
        'INSERT INTO projects(id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run('project-forged', projectRoot, now, now);

    // Forged arbitrary 64-hex checksum that does not match canonical recomputation.
    opened.connection
      .prepare(
        `INSERT INTO tasks(
           id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-forged',
        'project-forged',
        'interrupted_needs_inspection',
        1,
        JSON.stringify({
          state: 'interrupted_needs_inspection',
          taskId: 'task-forged',
          requirementVersion: 1,
          reworkCount: 0,
          maxReworks: 3,
          pauseAfterAttempt: false,
          activeAttemptId: 'attempt-forged',
          inspectionResumeTargetState: 'implementing',
        }),
        now,
        now,
      );
    opened.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, role, status, baseline_id, requirement_version,
           started_at, pid, process_started_at
         ) VALUES (?, ?, 'implementer', 'active', ?, 1, ?, ?, ?)`,
      )
      .run('attempt-forged', 'task-forged', 'baseline-forged', now, 4001, now);
    const forged = buildValidAttemptManifest({
      taskId: 'task-forged',
      baselineId: 'baseline-forged',
      attemptId: 'attempt-forged',
      projectRoot,
      createdAt: now,
      checksumOverride: 'c'.repeat(64),
    });
    opened.connection
      .prepare(
        `INSERT INTO file_baselines(
           id, task_id, attempt_id, status, manifest_json, created_at, completed_at
         ) VALUES (?, ?, ?, 'complete', ?, ?, ?)`,
      )
      .run(
        'baseline-forged',
        'task-forged',
        'attempt-forged',
        JSON.stringify(forged),
        now,
        now,
      );

    // Malformed file entry / path escape
    opened.connection
      .prepare(
        `INSERT INTO tasks(
           id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-malformed-entry',
        'project-forged',
        'interrupted_needs_inspection',
        1,
        JSON.stringify({
          state: 'interrupted_needs_inspection',
          taskId: 'task-malformed-entry',
          requirementVersion: 1,
          reworkCount: 0,
          maxReworks: 3,
          pauseAfterAttempt: false,
          activeAttemptId: 'attempt-malformed',
          inspectionResumeTargetState: 'implementing',
        }),
        now,
        now,
      );
    opened.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, role, status, baseline_id, requirement_version,
           started_at, pid, process_started_at
         ) VALUES (?, ?, 'implementer', 'active', ?, 1, ?, ?, ?)`,
      )
      .run('attempt-malformed', 'task-malformed-entry', 'baseline-malformed', now, 4002, now);
    const base = buildValidAttemptManifest({
      taskId: 'task-malformed-entry',
      baselineId: 'baseline-malformed',
      attemptId: 'attempt-malformed',
      projectRoot,
      createdAt: now,
    });
    const malformed = {
      ...base,
      files: [
        {
          path: '../escape.txt',
          type: 'file',
          size: 1,
          mtimeMs: 1,
          hash: 'd'.repeat(64),
          blobHash: 'd'.repeat(64),
          missing: false,
          executable: false,
          binary: false,
          tracked: true,
        },
      ],
      // Keep forged checksum so shape fails first on path or checksum.
      checksum: 'e'.repeat(64),
    };
    opened.connection
      .prepare(
        `INSERT INTO file_baselines(
           id, task_id, attempt_id, status, manifest_json, created_at, completed_at
         ) VALUES (?, ?, ?, 'complete', ?, ?, ?)`,
      )
      .run(
        'baseline-malformed',
        'task-malformed-entry',
        'attempt-malformed',
        JSON.stringify(malformed),
        now,
        now,
      );
    opened.close();

    const composition = await composeApplication({
      appRootOverride: root,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(composition);

    const forgedItem = composition.reconcileReport?.items.find(
      (entry) => entry.taskId === 'task-forged',
    );
    expect(forgedItem?.baselineEvidence.status).toMatch(/invalid|incomplete|mismatched/);
    expect(forgedItem?.baselineEvidence.diagnostic).toMatch(/checksum/i);
    expect(forgedItem?.autoResume).toBe(false);
    expect(forgedItem?.allowedNextActions).not.toContain('continue');

    const malformedItem = composition.reconcileReport?.items.find(
      (entry) => entry.taskId === 'task-malformed-entry',
    );
    expect(malformedItem?.baselineEvidence.status).toMatch(/invalid|incomplete|mismatched/);
    expect(malformedItem?.autoResume).toBe(false);
    expect(malformedItem?.allowedNextActions).not.toContain('continue');
  });

  it('reports missing/incomplete/wrong-task baselines and blocks autoResume', async () => {
    const root = temporaryDirectory('triagent-baseline-');
    const dbPath = join(root, 'triagent.db');
    mkdirSync(join(root, 'logs'), { recursive: true });
    mkdirSync(join(root, 'snapshots'), { recursive: true });

    // Seed without file_baselines row.
    const opened = openDatabase(dbPath);
    expect(opened.mode).toBe('read-write');
    if (opened.mode !== 'read-write') throw new Error('expected rw');
    const now = new Date().toISOString();
    opened.connection
      .prepare(
        'INSERT INTO projects(id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run('project-b', 'D:\\projects\\b', now, now);
    opened.connection
      .prepare(
        `INSERT INTO tasks(
           id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-missing-base',
        'project-b',
        'interrupted_needs_inspection',
        1,
        JSON.stringify({
          state: 'interrupted_needs_inspection',
          taskId: 'task-missing-base',
          requirementVersion: 1,
          reworkCount: 0,
          maxReworks: 3,
          pauseAfterAttempt: false,
          activeAttemptId: 'attempt-b1',
          inspectionResumeTargetState: 'implementing',
        }),
        now,
        now,
      );
    opened.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, role, status, baseline_id, requirement_version,
           started_at, pid, process_started_at
         ) VALUES (?, ?, 'implementer', 'active', ?, 1, ?, ?, ?)`,
      )
      .run('attempt-b1', 'task-missing-base', 'baseline-missing', now, 1001, now);
    opened.close();

    const composition = await composeApplication({
      appRootOverride: root,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(composition);
    const item = composition.reconcileReport?.items.find(
      (entry) => entry.taskId === 'task-missing-base',
    );
    expect(item).toBeDefined();
    expect(item!.baselineEvidence.status).toMatch(/missing|incomplete|invalid/);
    expect(item!.autoResume).toBe(false);
    expect(item!.allowedNextActions).not.toContain('continue');
    expect(item!.evidenceLines.some((line) => /baseline/i.test(line))).toBe(true);

    // Incomplete baseline status
    const root2 = temporaryDirectory('triagent-baseline-incomplete-');
    const db2 = join(root2, 'triagent.db');
    mkdirSync(join(root2, 'logs'), { recursive: true });
    mkdirSync(join(root2, 'snapshots'), { recursive: true });
    const o2 = openDatabase(db2);
    if (o2.mode !== 'read-write') throw new Error('rw');
    const t2 = new Date().toISOString();
    o2.connection
      .prepare(
        'INSERT INTO projects(id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run('project-c', 'D:\\projects\\c', t2, t2);
    o2.connection
      .prepare(
        `INSERT INTO tasks(
           id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task-incomplete-base',
        'project-c',
        'awaiting_user',
        1,
        JSON.stringify({
          state: 'awaiting_user',
          taskId: 'task-incomplete-base',
          requirementVersion: 1,
          reworkCount: 0,
          maxReworks: 3,
          pauseAfterAttempt: false,
          activeAttemptId: 'attempt-c1',
          awaitingResumeTargetState: 'implementing',
          awaitingReason: 'test',
          allowedAwaitingActions: ['continue', 'cancel'],
        }),
        t2,
        t2,
      );
    o2.connection
      .prepare(
        `INSERT INTO run_attempts(
           id, task_id, role, status, baseline_id, requirement_version,
           started_at, pid, process_started_at
         ) VALUES (?, ?, 'implementer', 'active', ?, 1, ?, ?, ?)`,
      )
      .run('attempt-c1', 'task-incomplete-base', 'baseline-inc', t2, 1002, t2);
    o2.connection
      .prepare(
        `INSERT INTO file_baselines(
           id, task_id, attempt_id, status, manifest_json, created_at, completed_at
         ) VALUES (?, ?, ?, 'pending', NULL, ?, NULL)`,
      )
      .run('baseline-inc', 'task-incomplete-base', 'attempt-c1', t2);
    o2.close();

    const c2 = await composeApplication({
      appRootOverride: root2,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(c2);
    const incomplete = c2.reconcileReport?.items.find(
      (entry) => entry.taskId === 'task-incomplete-base',
    );
    expect(incomplete?.baselineEvidence.status).toBe('incomplete');
    expect(incomplete?.autoResume).toBe(false);

    // Wrong-task baseline ownership
    const root3 = temporaryDirectory('triagent-baseline-wrong-');
    const db3 = join(root3, 'triagent.db');
    mkdirSync(join(root3, 'logs'), { recursive: true });
    mkdirSync(join(root3, 'snapshots'), { recursive: true });
    const o3 = openDatabase(db3);
    if (o3.mode !== 'read-write') throw new Error('rw');
    const t3 = new Date().toISOString();
    o3.connection
      .prepare(
        'INSERT INTO projects(id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run('project-d', 'D:\\projects\\d', t3, t3);
    for (const taskId of ['task-owner', 'task-wrong'] as const) {
      o3.connection
        .prepare(
          `INSERT INTO tasks(
             id, project_id, status, workflow_version, workflow_snapshot, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          taskId,
          'project-d',
          'interrupted_needs_inspection',
          1,
          JSON.stringify({
            state: 'interrupted_needs_inspection',
            taskId,
            requirementVersion: 1,
            reworkCount: 0,
            maxReworks: 3,
            pauseAfterAttempt: false,
            activeAttemptId: `${taskId}-attempt`,
            inspectionResumeTargetState: 'implementing',
          }),
          t3,
          t3,
        );
      o3.connection
        .prepare(
          `INSERT INTO run_attempts(
             id, task_id, role, status, baseline_id, requirement_version,
             started_at, pid, process_started_at
           ) VALUES (?, ?, 'implementer', 'active', ?, 1, ?, ?, ?)`,
        )
        .run(`${taskId}-attempt`, taskId, 'baseline-shared', t3, 2000, t3);
    }
    o3.connection
      .prepare(
        `INSERT INTO file_baselines(
           id, task_id, attempt_id, status, manifest_json, created_at, completed_at
         ) VALUES (?, ?, ?, 'complete', ?, ?, ?)`,
      )
      .run(
        'baseline-shared',
        'task-owner',
        'task-owner-attempt',
        JSON.stringify({
          schemaVersion: 1,
          taskId: 'task-owner',
          attemptId: 'task-owner-attempt',
          kind: 'attempt',
          files: [],
          complete: true,
          contentHash: 'x',
        }),
        t3,
        t3,
      );
    o3.close();

    const c3 = await composeApplication({
      appRootOverride: root3,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(c3);
    const wrong = c3.reconcileReport?.items.find((entry) => entry.taskId === 'task-wrong');
    expect(wrong?.baselineEvidence.status).toMatch(/missing|mismatched|invalid/);
    expect(wrong?.autoResume).toBe(false);
  }, 15_000);
});
