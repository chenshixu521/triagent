import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  composeApplication,
  type ApplicationComposition,
} from '../../../src/app/app-context.js';
import { createLifecycleCoordinator } from '../../../src/app/lifecycle-coordinator.js';
import {
  parseCliArgs,
  runCli,
  type CliRunResult,
} from '../../../src/cli/main.js';

const temporaryDirectories: string[] = [];
const compositions: ApplicationComposition[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
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
  delete process.env.TRIAGENT_REAL_AI_TESTS;
});

describe('application lifecycle and CLI composition', () => {
  it('parses --help and diagnostic options without starting the application', async () => {
    const help = parseCliArgs(['--help']);
    expect(help.kind).toBe('help');
    if (help.kind !== 'help') throw new Error('expected help');
    expect(help.exitCode).toBe(0);
    expect(help.text).toMatch(/triagent/i);

    const diagnostic = parseCliArgs(['--diagnostic']);
    expect(diagnostic.kind).toBe('run');
    if (diagnostic.kind !== 'run') throw new Error('expected run');
    expect(diagnostic.options.diagnosticOnly).toBe(true);

    const helpResult = await runCli(['--help'], {
      // Must not compose or open DB for help.
      compose: async () => {
        throw new Error('compose must not run for --help');
      },
      render: async () => {
        throw new Error('render must not run for --help');
      },
    });
    expect(helpResult.exitCode).toBe(0);
    expect(helpResult.kind).toBe('completed');
    if (helpResult.kind === 'completed') {
      expect(helpResult.stdout).toMatch(/Usage|triagent/i);
    }
  });

  it('shuts down in required order, is idempotent, and blocks exit until cleanup completes', async () => {
    const root = temporaryDirectory('triagent-lifecycle-');
    const composition = await composeApplication({
      appRootOverride: root,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(composition);

    const first = await composition.lifecycle.shutdown({ reason: 'user_exit' });
    expect(first.exitAllowed).toBe(true);
    expect(first.stagesCompleted).toEqual([
      'stop_accepting_intents',
      'persist_stop_intent_reconcile_active_runs',
      'cooperative_forced_job_cleanup',
      'positive_tree_verification',
      'flush_jsonl',
      'close_workers_watchers',
      'release_locks',
      'close_database',
      'authorize_ink_exit',
    ]);
    expect(composition.acceptingIntents).toBe(false);

    // Concurrent/repeated shutdown must not double-close or skip stages.
    const second = await composition.lifecycle.shutdown({ reason: 'user_exit_again' });
    expect(second.exitAllowed).toBe(true);
    expect(second.alreadyCompleted).toBe(true);
    expect(second.stagesCompleted).toEqual(first.stagesCompleted);

    const concurrent = await Promise.all([
      composition.lifecycle.shutdown({ reason: 'a' }),
      composition.lifecycle.shutdown({ reason: 'b' }),
    ]);
    expect(concurrent.every((result) => result.exitAllowed)).toBe(true);

    // REQUEST_EXIT through AppContext controller path.
    const exitGate = await composition.controller.dispatch({ type: 'REQUEST_EXIT' });
    expect(exitGate.kind).toBe('exit_gate');
    if (exitGate.kind === 'exit_gate') {
      expect(exitGate.gate.allowed).toBe(true);
    }
  });

  it('aggregates cleanup failures and keeps exit blocked until required cleanup succeeds', async () => {
    const root = temporaryDirectory('triagent-lifecycle-block-');
    const composition = await composeApplication({
      appRootOverride: root,
      skipHealthProbes: true,
      skipProcessHost: true,
      testHooks: {
        forceCleanupFailure: true,
      },
    });
    compositions.push(composition);

    const blocked = await composition.lifecycle.shutdown({ reason: 'blocked_exit' });
    expect(blocked.exitAllowed).toBe(false);
    expect(blocked.failures.length).toBeGreaterThan(0);
    expect(blocked.stagesCompleted).not.toContain('authorize_ink_exit');

    const gate = await composition.controller.dispatch({ type: 'REQUEST_EXIT' });
    expect(gate.kind).toBe('exit_gate');
    if (gate.kind === 'exit_gate') {
      expect(gate.gate.allowed).toBe(false);
      expect(gate.gate.reason).toMatch(/cleanup|blocked/i);
    }

    // Clear failure and complete cleanup.
    composition.testHooks?.clearCleanupFailure?.();
    const recovered = await composition.lifecycle.shutdown({ reason: 'retry_exit' });
    expect(recovered.exitAllowed).toBe(true);
    expect(recovered.stagesCompleted).toContain('authorize_ink_exit');
  });

  it('runCli composes, reconciles, and returns testable exit codes without process.exit', async () => {
    const root = temporaryDirectory('triagent-cli-run-');
    process.env.TRIAGENT_APP_ROOT = root;

    let rendered = false;
    const result: CliRunResult = await runCli(
      ['--app-root', root, '--skip-health-probes', '--skip-process-host'],
      {
        render: async (composition) => {
          rendered = true;
          expect(composition.mode).toBe('read-write');
          // Request exit through lifecycle; do not process.exit.
          const shutdown = await composition.lifecycle.shutdown({ reason: 'cli_test_exit' });
          return {
            exitCode: shutdown.exitAllowed ? 0 : 2,
            unmount: () => undefined,
          };
        },
      },
    );

    expect(rendered).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.error).toBeUndefined();
    }
  });

  it('selects the launch working directory before the first render', async () => {
    const appRoot = temporaryDirectory('triagent-cli-cwd-app-');
    const projectRoot = temporaryDirectory('triagent-cli-cwd-project-');
    let rendered = false;

    const result = await runCli(
      ['--app-root', appRoot, '--skip-health-probes', '--skip-process-host'],
      {
        cwd: () => projectRoot,
        render: async (composition) => {
          rendered = true;
          expect(composition.snapshot().screen).toBe('new_task');
          expect(composition.snapshot().projectPath?.toLowerCase()).toBe(
            projectRoot.toLowerCase(),
          );
          const shutdown = await composition.lifecycle.shutdown({
            reason: 'cwd_selection_test_exit',
          });
          return { exitCode: shutdown.exitAllowed ? 0 : 2 };
        },
      },
    );

    expect(rendered).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('keeps the project fallback when the launch working directory is invalid', async () => {
    const appRoot = temporaryDirectory('triagent-cli-cwd-invalid-app-');
    const missingProject = join(appRoot, 'missing-project');

    const result = await runCli(
      ['--app-root', appRoot, '--skip-health-probes', '--skip-process-host'],
      {
        cwd: () => missingProject,
        render: async (composition) => {
          const snapshot = composition.snapshot();
          expect(snapshot.screen).toBe('project');
          expect(snapshot.statusMessage).toMatch(/project selection failed|does not exist/i);
          const shutdown = await composition.lifecycle.shutdown({
            reason: 'cwd_fallback_test_exit',
          });
          return { exitCode: shutdown.exitAllowed ? 0 : 2 };
        },
      },
    );

    expect(result.exitCode).toBe(0);
  });

  it('does not read or select cwd when startup is in recovery/diagnostic mode', async () => {
    const appRoot = temporaryDirectory('triagent-cli-cwd-recovery-');
    writeFileSync(join(appRoot, 'triagent.db'), Buffer.from('corrupt-db-bytes', 'utf8'));
    let cwdCalls = 0;

    const result = await runCli(
      ['--app-root', appRoot, '--diagnostic', '--skip-health-probes', '--skip-process-host'],
      {
        cwd: () => {
          cwdCalls += 1;
          return temporaryDirectory('triagent-should-not-select-');
        },
        render: async (composition) => {
          expect(composition.snapshot().screen).toBe('recovery');
          const shutdown = await composition.lifecycle.shutdown({
            reason: 'cwd_recovery_test_exit',
          });
          return { exitCode: shutdown.exitAllowed ? 0 : 2 };
        },
      },
    );

    expect(cwdCalls).toBe(0);
    expect(result.exitCode).toBe(0);
  });

  it('runCli diagnostic path for corrupt DB returns actionable result without side-effect services', async () => {
    const root = temporaryDirectory('triagent-cli-diag-');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'triagent.db'), Buffer.from('corrupt-db-bytes', 'utf8'));

    const result = await runCli(
      ['--app-root', root, '--diagnostic', '--skip-health-probes', '--skip-process-host'],
      {
        render: async (composition) => {
          expect(composition.mode).toBe('diagnostic');
          expect(composition.sideEffects.workerStarted).toBe(false);
          expect(composition.sideEffects.processHostStarted).toBe(false);
          const shutdown = await composition.lifecycle.shutdown({ reason: 'diag_exit' });
          return {
            exitCode: shutdown.exitAllowed ? 0 : 2,
            unmount: () => undefined,
          };
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(root, 'triagent.db'))).toBe(true);
    expect(readFileSync(join(root, 'triagent.db'), 'utf8')).toContain('corrupt-db-bytes');
  });

  it('keeps DB open during pending render and only closes after authorized lifecycle exit', async () => {
    const root = temporaryDirectory('triagent-cli-lifetime-');
    process.env.TRIAGENT_APP_ROOT = root;

    let releaseRender!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const events: string[] = [];
    let compositionRef: ApplicationComposition | undefined;

    const runPromise = runCli(
      ['--app-root', root, '--skip-health-probes', '--skip-process-host'],
      {
        render: async (composition) => {
          compositionRef = composition;
          events.push('render_started');
          // DB must still be open while render is pending.
          if (composition.database.mode === 'read-write') {
            expect(composition.database.connection.isOpen).toBe(true);
          }
          await renderGate;
          events.push('render_authorized_exit');
          const shutdown = await composition.lifecycle.shutdown({
            reason: 'authorized_user_exit',
          });
          events.push('shutdown_done');
          expect(shutdown.exitAllowed).toBe(true);
          expect(shutdown.stagesCompleted).toContain('close_database');
          expect(shutdown.stagesCompleted).toContain('authorize_ink_exit');
          return { exitCode: 0, unmount: () => {
            events.push('unmount');
          } };
        },
      },
    );

    // Allow compose+render to start without finishing.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toContain('render_started');
    expect(compositionRef).toBeDefined();
    if (compositionRef!.database.mode === 'read-write') {
      expect(compositionRef!.database.connection.isOpen).toBe(true);
    }
    expect(events).not.toContain('shutdown_done');

    releaseRender();
    const result = await runPromise;
    expect(result.exitCode).toBe(0);
    expect(events).toEqual([
      'render_started',
      'render_authorized_exit',
      'shutdown_done',
      'unmount',
    ]);
  });

  it('forced --diagnostic does not create/migrate/modify DB even when healthy or missing', async () => {
    const root = temporaryDirectory('triagent-forced-diag-');
    mkdirSync(root, { recursive: true });
    const dbPath = join(root, 'triagent.db');
    // Missing DB case first.
    const beforeEntries = readdirSync(root);

    const missing = await composeApplication({
      appRootOverride: root,
      diagnosticOnly: true,
      skipHealthProbes: true,
      skipProcessHost: true,
      createDirectories: true,
    });
    compositions.push(missing);

    expect(missing.mode).toBe('diagnostic');
    expect(missing.repositories).toBeUndefined();
    expect(missing.budgetController).toBeUndefined();
    expect(missing.sideEffects.workerStarted).toBe(false);
    expect(missing.sideEffects.adapterStarted).toBe(false);
    expect(missing.sideEffects.projectLockAcquired).toBe(false);
    expect(missing.sideEffects.processHostStarted).toBe(false);
    expect(missing.sideEffects.watcherStarted).toBe(false);
    expect(missing.sideEffects.nativeHelperStarted).toBe(false);
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(root, 'settings.json'))).toBe(false);
    // Only path directories may exist — never triagent.db from diagnostic.
    expect(readdirSync(root).filter((name) => name.endsWith('.db'))).toEqual([]);
    void beforeEntries;

    // Healthy DB must not be migrated/modified under forced diagnostic.
    const healthyRoot = temporaryDirectory('triagent-forced-diag-healthy-');
    const healthyDb = join(healthyRoot, 'triagent.db');
    const { openDatabase } = await import('../../../src/persistence/database.js');
    const created = openDatabase(healthyDb);
    expect(created.mode).toBe('read-write');
    created.close();
    const beforeBytes = readFileSync(healthyDb);
    const beforeMtime = statSync(healthyDb).mtimeMs;

    const forced = await composeApplication({
      appRootOverride: healthyRoot,
      diagnosticOnly: true,
      skipHealthProbes: true,
      skipProcessHost: true,
    });
    compositions.push(forced);
    expect(forced.mode).toBe('diagnostic');
    expect(forced.repositories).toBeUndefined();
    expect(readFileSync(healthyDb)).toEqual(beforeBytes);
    expect(statSync(healthyDb).mtimeMs).toBe(beforeMtime);
    expect(forced.snapshot().screen).toBe('recovery');
    expect(forced.snapshot().error).toMatch(/diagnostic/i);
  });

  it('fail-closed: render end without authorization never closes; retry then close once', async () => {
    const root = temporaryDirectory('triagent-cli-blocked-');
    process.env.TRIAGENT_APP_ROOT = root;

    let closeCount = 0;
    let compositionRef: ApplicationComposition | undefined;
    const result = await runCli(
      ['--app-root', root, '--skip-health-probes', '--skip-process-host'],
      {
        compose: async (options) => {
          // Force cleanup failure so render-end shutdown cannot authorize exit.
          const composition = await composeApplication({
            ...options,
            testHooks: { forceCleanupFailure: true },
          });
          compositions.push(composition);
          compositionRef = composition;
          const originalClose = composition.close.bind(composition);
          composition.close = () => {
            closeCount += 1;
            originalClose();
          };
          return composition;
        },
        render: async (composition) => {
          // Simulate Ink ending without authorized lifecycle exit.
          expect(composition.lifecycle.isExitAuthorized()).toBe(false);
          return { exitCode: 2, unmount: () => undefined };
        },
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(
      result.kind === 'blocked'
      || (result as { blocked?: boolean }).blocked === true
      || (result as { cleanupBlocked?: boolean }).cleanupBlocked === true
      || (result as { status?: string }).status === 'cleanup_blocked'
      || result.error !== undefined,
    ).toBe(true);
    // Must NOT have closed composition while unauthorized.
    expect(closeCount).toBe(0);
    expect(compositionRef).toBeDefined();
    expect(compositionRef!.lifecycle.isExitAuthorized()).toBe(false);
    if (compositionRef!.database.mode === 'read-write') {
      expect(compositionRef!.database.connection.isOpen).toBe(true);
    }

    // Typed blocked handle / retry path must authorize then close once.
    const blocked = result as {
      readonly blocked?: boolean;
      readonly cleanupBlocked?: boolean;
      readonly kind?: string;
      readonly retryShutdown?: (reason?: string) => Promise<{
        readonly exitAllowed: boolean;
      }>;
      readonly composition?: ApplicationComposition;
    };
    if (typeof blocked.retryShutdown === 'function') {
      const retry = await blocked.retryShutdown('operator_retry');
      expect(retry.exitAllowed).toBe(true);
      expect(compositionRef!.lifecycle.isExitAuthorized()).toBe(true);
      expect(closeCount).toBe(1);
    } else if (blocked.composition !== undefined) {
      blocked.composition.lifecycle.resetForRetry();
      const retry = await blocked.composition.lifecycle.shutdown({
        reason: 'operator_retry',
      });
      expect(retry.exitAllowed).toBe(true);
      blocked.composition.close();
      expect(closeCount).toBe(1);
    } else {
      // Fallback: use compositionRef via returned handle fields.
      compositionRef!.lifecycle.resetForRetry();
      const retry = await compositionRef!.lifecycle.shutdown({
        reason: 'operator_retry',
      });
      expect(retry.exitAllowed).toBe(true);
      compositionRef!.close();
      expect(closeCount).toBe(1);
    }
  });

  it('fail-closed error path preserves original error and does not close when cleanup blocked', async () => {
    const root = temporaryDirectory('triagent-cli-error-block-');
    process.env.TRIAGENT_APP_ROOT = root;
    let closeCount = 0;

    const result = await runCli(
      ['--app-root', root, '--skip-health-probes', '--skip-process-host'],
      {
        compose: async (options) => {
          const composition = await composeApplication({
            ...options,
            testHooks: { forceCleanupFailure: true },
          });
          compositions.push(composition);
          const originalClose = composition.close.bind(composition);
          composition.close = () => {
            closeCount += 1;
            originalClose();
          };
          return composition;
        },
        render: async () => {
          throw new Error('ink render exploded');
        },
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.error).toMatch(/ink render exploded/i);
    expect(
      result.error?.includes('cleanup')
        || result.stderr?.includes('cleanup')
        || (result as { cleanupBlocked?: boolean }).cleanupBlocked === true
        || (result as { kind?: string }).kind === 'blocked',
    ).toBe(true);
    expect(closeCount).toBe(0);
  });

  it('authorized Ink exit closes composition exactly once', async () => {
    const root = temporaryDirectory('triagent-cli-once-');
    process.env.TRIAGENT_APP_ROOT = root;
    let closeCount = 0;

    const result = await runCli(
      ['--app-root', root, '--skip-health-probes', '--skip-process-host'],
      {
        compose: async (options) => {
          const composition = await composeApplication(options);
          compositions.push(composition);
          const originalClose = composition.close.bind(composition);
          composition.close = () => {
            closeCount += 1;
            originalClose();
          };
          return composition;
        },
        render: async (composition) => {
          const shutdown = await composition.lifecycle.shutdown({
            reason: 'authorized_exit',
          });
          expect(shutdown.exitAllowed).toBe(true);
          return { exitCode: 0, unmount: () => undefined };
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(closeCount).toBe(1);
  });

  it('sets exitAuthorized only after onAuthorizedExit succeeds; rejection is retryable', async () => {
    let rejectOnce = true;
    let authorizedHookCalls = 0;
    const lifecycle = createLifecycleCoordinator({
      hooks: {
        stopAcceptingIntents: () => undefined,
        persistStopAndReconcile: async () => undefined,
        cleanupJobs: async () => undefined,
        verifyProcessTrees: async () => undefined,
        flushJsonl: async () => undefined,
        closeWorkersAndWatchers: async () => undefined,
        releaseLocks: async () => undefined,
        closeDatabase: () => undefined,
        onAuthorizedExit: async () => {
          authorizedHookCalls += 1;
          if (rejectOnce) {
            rejectOnce = false;
            throw new Error('ink exit rejected');
          }
        },
      },
    });

    const first = await lifecycle.shutdown({ reason: 'first' });
    expect(first.exitAllowed).toBe(false);
    expect(lifecycle.isExitAuthorized()).toBe(false);
    expect(first.failures.some((failure) => /ink exit rejected/i.test(failure.error))).toBe(
      true,
    );
    expect(authorizedHookCalls).toBe(1);

    // After failure, concurrent retries share work; only one successful auth.
    lifecycle.resetForRetry();
    const concurrent = await Promise.all([
      lifecycle.shutdown({ reason: 'retry-a' }),
      lifecycle.shutdown({ reason: 'retry-b' }),
    ]);
    expect(concurrent.every((result) => result.exitAllowed)).toBe(true);
    expect(lifecycle.isExitAuthorized()).toBe(true);
    // Shared in-flight means hook runs once for the concurrent pair.
    expect(authorizedHookCalls).toBe(2);
  });
});
