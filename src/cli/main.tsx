import { pathToFileURL } from 'node:url';

import {
  composeApplication,
  type ApplicationComposition,
  type ComposeApplicationOptions,
} from '../app/app-context.js';
import type { LifecycleShutdownResult } from '../app/lifecycle-coordinator.js';
import { renderTuiApp } from '../tui/App.js';
import { createTuiStore } from '../tui/store.js';

/**
 * CLI entry composition. Avoid side effects on import.
 * Handlers return testable exit codes/errors and never call process.exit.
 */

export interface CliHelpResult {
  readonly kind: 'help';
  readonly exitCode: 0;
  readonly text: string;
}

export interface CliRunOptions {
  readonly appRoot?: string;
  readonly diagnosticOnly?: boolean;
  readonly skipHealthProbes?: boolean;
  readonly skipProcessHost?: boolean;
}

export interface CliRunParseResult {
  readonly kind: 'run';
  readonly options: CliRunOptions;
}

export interface CliErrorParseResult {
  readonly kind: 'error';
  readonly exitCode: 1;
  readonly text: string;
}

export type CliParseResult = CliHelpResult | CliRunParseResult | CliErrorParseResult;

export interface CliRenderResult {
  readonly exitCode: number;
  readonly unmount?: () => void;
}

export interface CliBlockedRetryResult {
  readonly exitAllowed: boolean;
  readonly stagesCompleted?: readonly string[];
  readonly failures?: readonly { readonly stage: string; readonly error: string }[];
}

/**
 * Fail-closed result when lifecycle cleanup is not authorized.
 * Composition remains open for explicit retry; never treat as normal completion.
 */
export interface CliBlockedResult {
  readonly kind: 'blocked';
  readonly blocked: true;
  readonly cleanupBlocked: true;
  readonly exitCode: number;
  readonly error: string;
  readonly stderr?: string;
  readonly composition: ApplicationComposition;
  readonly lastShutdown?: LifecycleShutdownResult;
  readonly retryShutdown: (
    reason?: string,
  ) => Promise<CliBlockedRetryResult>;
}

export interface CliCompletedResult {
  readonly kind: 'completed';
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
}

export type CliRunResult = CliCompletedResult | CliBlockedResult;

export interface InkWaitHandle {
  readonly waitUntilExit: () => Promise<void>;
  readonly unmount: () => void;
}

export interface RunCliDependencies {
  readonly compose?: (
    options: ComposeApplicationOptions,
  ) => Promise<ApplicationComposition>;
  readonly render?: (
    composition: ApplicationComposition,
  ) => Promise<CliRenderResult>;
  /**
   * Test seam: replace Ink render. Production uses renderTuiApp + waitUntilExit.
   */
  readonly createInkInstance?: (
    composition: ApplicationComposition,
  ) => InkWaitHandle;
  /** Test seam for the directory from which the global command was launched. */
  readonly cwd?: () => string;
}

const HELP_TEXT = `TriAgent — Windows-first multi-agent coding orchestrator

Usage:
  triagent [options]

Options:
  --help                 Show this help and exit (does not start the app)
  --diagnostic           Open in database diagnostic / recovery-oriented mode
  --app-root <path>      Override durable app data root (tests; absolute path)
  --skip-health-probes   Skip adapter capability/health probes at startup
  --skip-process-host    Do not start the native ProcessHost helper

Environment:
  TRIAGENT_APP_ROOT          Absolute app data root override
  TRIAGENT_REAL_AI_TESTS     Opt-in real AI tests at runtime (not auto-persisted)
  LOCALAPPDATA               Windows durable data parent (TriAgent subdirectory)

Durable data is stored under %LOCALAPPDATA%\\TriAgent (never project cwd).
No credentials or API tokens are stored by TriAgent.
`;

export function parseCliArgs(argv: readonly string[]): CliParseResult {
  const args = [...argv];
  if (args.includes('--help') || args.includes('-h')) {
    return {
      kind: 'help',
      exitCode: 0,
      text: HELP_TEXT,
    };
  }

  const options: {
    appRoot?: string;
    diagnosticOnly?: boolean;
    skipHealthProbes?: boolean;
    skipProcessHost?: boolean;
  } = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--diagnostic') {
      options.diagnosticOnly = true;
      continue;
    }
    if (arg === '--skip-health-probes') {
      options.skipHealthProbes = true;
      continue;
    }
    if (arg === '--skip-process-host') {
      options.skipProcessHost = true;
      continue;
    }
    if (arg === '--app-root') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        return {
          kind: 'error',
          exitCode: 1,
          text: 'error: --app-root requires an absolute path argument',
        };
      }
      options.appRoot = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--app-root=')) {
      options.appRoot = arg.slice('--app-root='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      return {
        kind: 'error',
        exitCode: 1,
        text: `error: unknown option ${arg}\n\n${HELP_TEXT}`,
      };
    }
  }

  return {
    kind: 'run',
    options,
  };
}

/**
 * Default Ink render: await waitUntilExit. User exits go through
 * LifecycleCoordinator.shutdown; only after exitAllowed/onAuthorizedExit
 * succeeds does Ink unmount.
 */
export async function defaultRender(
  composition: ApplicationComposition,
  createInkInstance?: (
    composition: ApplicationComposition,
  ) => InkWaitHandle,
): Promise<CliRenderResult> {
  const store = createTuiStore({
    initial: composition.snapshot(),
    controller: composition.controller,
  });

  // Live task progress (stage changes, activity lines, elapsed) → Ink store.
  // Do not preserveUiState: statusMessage/logs must update while work runs.
  composition.setTaskProgressSink?.((partial) => {
    store.replaceSnapshot(partial, { preserveUiState: false });
  });

  let unmounted = false;
  const safeUnmount = (unmount: () => void): void => {
    if (unmounted) return;
    unmounted = true;
    try {
      unmount();
    } catch {
      // ignore
    }
  };

  const instance =
    createInkInstance?.(composition)
    ?? (() => {
      const ink = renderTuiApp({
        snapshot: composition.snapshot(),
        store,
        controller: composition.controller,
        onSnapshotChange: undefined,
      });
      return {
        waitUntilExit: () => ink.waitUntilExit(),
        unmount: () => ink.unmount(),
      };
    })();

  // Wire authorized exit: lifecycle calls this only after cleanup succeeds.
  const compositionWithHook = composition as ApplicationComposition & {
    setOnAuthorizedExit?: (hook: () => void | Promise<void>) => void;
  };
  compositionWithHook.setOnAuthorizedExit?.(() => {
    safeUnmount(instance.unmount);
  });

  // Await real Ink lifetime (or injected equivalent). Do not return early.
  try {
    await instance.waitUntilExit();
  } catch {
    // Ink may reject on forced unmount; still proceed to return.
  }

  const exitAllowed = composition.lifecycle.isExitAuthorized();
  return {
    exitCode: exitAllowed ? 0 : 2,
    unmount: () => safeUnmount(instance.unmount),
  };
}

function buildBlockedResult(
  composition: ApplicationComposition,
  message: string,
  lastShutdown: LifecycleShutdownResult | undefined,
  closeOnce: () => void,
): CliBlockedResult {
  return {
    kind: 'blocked',
    blocked: true,
    cleanupBlocked: true,
    exitCode: 2,
    error: message,
    stderr: message,
    composition,
    lastShutdown,
    async retryShutdown(reason = 'operator_retry'): Promise<CliBlockedRetryResult> {
      composition.lifecycle.resetForRetry();
      composition.lifecycle.clearCleanupFailure();
      const result = await composition.lifecycle.shutdown({ reason });
      if (result.exitAllowed && composition.lifecycle.isExitAuthorized()) {
        closeOnce();
      }
      return {
        exitAllowed: result.exitAllowed,
        stagesCompleted: result.stagesCompleted,
        failures: result.failures,
      };
    },
  };
}

/**
 * Run the CLI. Never calls process.exit — returns a testable result.
 * --help / parse errors do not compose the application.
 *
 * Fail-closed: if render ends or throws without lifecycle exit authorization,
 * call lifecycle.shutdown, inspect the result, and NEVER close composition
 * while exitAllowed/isExitAuthorized is false. Return a typed blocked handle
 * with retryShutdown. Normal authorized exit closes exactly once.
 */
export async function runCli(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: RunCliDependencies = {},
): Promise<CliRunResult> {
  const parsed = parseCliArgs(argv);
  if (parsed.kind === 'help') {
    return {
      kind: 'completed',
      exitCode: parsed.exitCode,
      stdout: parsed.text,
    };
  }
  if (parsed.kind === 'error') {
    return {
      kind: 'completed',
      exitCode: parsed.exitCode,
      stderr: parsed.text,
      error: parsed.text,
    };
  }

  const compose = dependencies.compose ?? composeApplication;
  const render =
    dependencies.render
    ?? ((composition: ApplicationComposition) =>
      defaultRender(composition, dependencies.createInkInstance));

  let composition: ApplicationComposition | undefined;
  let closed = false;
  const closeOnce = (): void => {
    if (composition === undefined || closed) return;
    closed = true;
    composition.close();
  };

  try {
    composition = await compose({
      appRootOverride: parsed.options.appRoot,
      diagnosticOnly: parsed.options.diagnosticOnly === true,
      skipHealthProbes: parsed.options.skipHealthProbes === true,
      skipProcessHost: parsed.options.skipProcessHost === true,
    });

    // Normal startup uses the command's launch directory as the project root.
    // Recovery/diagnostic snapshots remain untouched and retain their evidence.
    if (composition.snapshot().screen === 'project') {
      await composition.dispatch({
        type: 'SELECT_PROJECT',
        projectPath: dependencies.cwd?.() ?? process.cwd(),
      });
    }

    const rendered = await render(composition);

    // Authorized path: already cleaned up by REQUEST_EXIT / shutdown.
    if (
      composition.lifecycle.isExitAuthorized()
      && composition.lifecycle.isExitAuthorized()
    ) {
      closeOnce();
      rendered.unmount?.();
      return {
        kind: 'completed',
        exitCode: rendered.exitCode === 0 ? 0 : rendered.exitCode,
      };
    }

    // Render ended without authorization — attempt shutdown once and inspect.
    let shutdown: LifecycleShutdownResult | undefined;
    try {
      shutdown = await composition.lifecycle.shutdown({
        reason: 'cli_render_ended',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildBlockedResult(
        composition,
        `cleanup blocked after render end: ${message}`,
        undefined,
        closeOnce,
      );
    }

    if (shutdown.exitAllowed && composition.lifecycle.isExitAuthorized()) {
      closeOnce();
      rendered.unmount?.();
      return {
        kind: 'completed',
        exitCode: 0,
      };
    }

    // Fail closed: do NOT close. Keep handles for retry.
    const failureText =
      shutdown.failures.map((failure) => failure.error).join('; ')
      || 'exit not authorized after render end';
    return buildBlockedResult(
      composition,
      `cleanup blocked: ${failureText}`,
      shutdown,
      closeOnce,
    );
  } catch (error) {
    const original = error instanceof Error ? error.message : String(error);
    if (composition === undefined) {
      return {
        kind: 'completed',
        exitCode: 1,
        error: original,
        stderr: original,
      };
    }

    let shutdown: LifecycleShutdownResult | undefined;
    try {
      shutdown = await composition.lifecycle.shutdown({
        reason: 'cli_error_cleanup',
      });
    } catch (cleanupError) {
      const cleanupMessage =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      return buildBlockedResult(
        composition,
        `${original}; cleanup blocked: ${cleanupMessage}`,
        undefined,
        closeOnce,
      );
    }

    if (shutdown.exitAllowed && composition.lifecycle.isExitAuthorized()) {
      closeOnce();
      return {
        kind: 'completed',
        exitCode: 1,
        error: original,
        stderr: original,
      };
    }

    const failureText =
      shutdown.failures.map((failure) => failure.error).join('; ')
      || 'exit not authorized after error cleanup';
    return buildBlockedResult(
      composition,
      `${original}; cleanup blocked: ${failureText}`,
      shutdown,
      closeOnce,
    );
  }
}

export function AppBootstrapMessage(): string {
  return 'TriAgent';
}

const isDirectExecution =
  process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  // Side effects only when executed as the program entry — not on import.
  void runCli(process.argv.slice(2)).then((result) => {
    if (result.kind === 'completed' && result.stdout !== undefined && result.stdout.length > 0) {
      process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    }
    const errText =
      result.kind === 'blocked'
        ? result.error
        : result.stderr ?? result.error;
    if (errText !== undefined && errText.length > 0) {
      process.stderr.write(errText.endsWith('\n') ? errText : `${errText}\n`);
    }
    process.exitCode = result.exitCode;
  });
}
