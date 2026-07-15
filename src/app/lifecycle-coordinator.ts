import type { OpenedDatabase } from '../persistence/database.js';

/**
 * Ordered, idempotent application shutdown.
 *
 * Stages (required order):
 * 1. stop accepting new intents
 * 2. persist stop intent / reconcile active runs
 * 3. cooperative/forced Job cleanup
 * 4. positive tree verification
 * 5. flush JSONL
 * 6. close Workers/watchers
 * 7. release locks
 * 8. close DB
 * 9. authorize Ink exit (onAuthorizedExit must resolve before exitAuthorized)
 *
 * Exit remains blocked until required cleanup succeeds. Repeated/concurrent
 * shutdown calls share one in-flight promise and never double-close.
 */

export type LifecycleShutdownStage =
  | 'stop_accepting_intents'
  | 'persist_stop_intent_reconcile_active_runs'
  | 'cooperative_forced_job_cleanup'
  | 'positive_tree_verification'
  | 'flush_jsonl'
  | 'close_workers_watchers'
  | 'release_locks'
  | 'close_database'
  | 'authorize_ink_exit';

export const LIFECYCLE_SHUTDOWN_STAGES: readonly LifecycleShutdownStage[] = [
  'stop_accepting_intents',
  'persist_stop_intent_reconcile_active_runs',
  'cooperative_forced_job_cleanup',
  'positive_tree_verification',
  'flush_jsonl',
  'close_workers_watchers',
  'release_locks',
  'close_database',
  'authorize_ink_exit',
] as const;

export interface LifecycleShutdownRequest {
  readonly reason: string;
}

export interface LifecycleShutdownResult {
  readonly exitAllowed: boolean;
  readonly alreadyCompleted?: boolean;
  readonly stagesCompleted: readonly LifecycleShutdownStage[];
  readonly failures: readonly {
    readonly stage: LifecycleShutdownStage;
    readonly error: string;
  }[];
  readonly reason: string;
}

export interface LifecycleHooks {
  readonly stopAcceptingIntents: () => void | Promise<void>;
  readonly persistStopAndReconcile: () => void | Promise<void>;
  readonly cleanupJobs: () => void | Promise<void>;
  readonly verifyProcessTrees: () => void | Promise<void>;
  readonly flushJsonl: () => void | Promise<void>;
  readonly closeWorkersAndWatchers: () => void | Promise<void>;
  readonly releaseLocks: () => void | Promise<void>;
  readonly closeDatabase: () => void | Promise<void>;
  readonly onAuthorizedExit?: () => void | Promise<void>;
}

export interface LifecycleCoordinatorOptions {
  readonly hooks: LifecycleHooks;
  readonly forceCleanupFailure?: boolean;
}

export interface LifecycleCoordinator {
  shutdown(request: LifecycleShutdownRequest): Promise<LifecycleShutdownResult>;
  isAcceptingIntents(): boolean;
  isExitAuthorized(): boolean;
  clearCleanupFailure(): void;
  resetForRetry(): void;
}

export function createLifecycleCoordinator(
  options: LifecycleCoordinatorOptions,
): LifecycleCoordinator {
  let acceptingIntents = true;
  let exitAuthorized = false;
  let completedResult: LifecycleShutdownResult | undefined;
  let inFlight: Promise<LifecycleShutdownResult> | undefined;
  let forceCleanupFailure = options.forceCleanupFailure === true;

  const runStage = async (
    stage: LifecycleShutdownStage,
    action: () => void | Promise<void>,
    failures: { stage: LifecycleShutdownStage; error: string }[],
    completed: LifecycleShutdownStage[],
  ): Promise<boolean> => {
    try {
      await action();
      completed.push(stage);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ stage, error: message });
      return false;
    }
  };

  const execute = async (
    request: LifecycleShutdownRequest,
  ): Promise<LifecycleShutdownResult> => {
    if (completedResult !== undefined && completedResult.exitAllowed) {
      return {
        ...completedResult,
        alreadyCompleted: true,
        reason: request.reason,
      };
    }

    const failures: { stage: LifecycleShutdownStage; error: string }[] = [];
    const completed: LifecycleShutdownStage[] = [];

    await runStage(
      'stop_accepting_intents',
      async () => {
        acceptingIntents = false;
        await options.hooks.stopAcceptingIntents();
      },
      failures,
      completed,
    );

    await runStage(
      'persist_stop_intent_reconcile_active_runs',
      () => options.hooks.persistStopAndReconcile(),
      failures,
      completed,
    );

    const cleanupOk = await runStage(
      'cooperative_forced_job_cleanup',
      async () => {
        if (forceCleanupFailure) {
          throw new Error('cleanup incomplete: forced cleanup failure (test)');
        }
        await options.hooks.cleanupJobs();
      },
      failures,
      completed,
    );

    let treeOk = false;
    if (cleanupOk) {
      treeOk = await runStage(
        'positive_tree_verification',
        () => options.hooks.verifyProcessTrees(),
        failures,
        completed,
      );
    } else {
      failures.push({
        stage: 'positive_tree_verification',
        error: 'skipped: job cleanup did not succeed',
      });
    }

    // Fail closed: when job cleanup / tree verification fails, keep
    // DB/workers/watchers/locks available for an explicit retry path.
    // Do not tear down durable handles until cleanup succeeds.
    if (cleanupOk && treeOk) {
      await runStage(
        'flush_jsonl',
        () => options.hooks.flushJsonl(),
        failures,
        completed,
      );

      await runStage(
        'close_workers_watchers',
        () => options.hooks.closeWorkersAndWatchers(),
        failures,
        completed,
      );

      await runStage(
        'release_locks',
        () => options.hooks.releaseLocks(),
        failures,
        completed,
      );

      await runStage(
        'close_database',
        () => options.hooks.closeDatabase(),
        failures,
        completed,
      );
    } else {
      failures.push({
        stage: 'flush_jsonl',
        error: 'skipped: cleanup incomplete; durable handles retained for retry',
      });
      failures.push({
        stage: 'close_workers_watchers',
        error: 'skipped: cleanup incomplete; durable handles retained for retry',
      });
      failures.push({
        stage: 'release_locks',
        error: 'skipped: cleanup incomplete; durable handles retained for retry',
      });
      failures.push({
        stage: 'close_database',
        error: 'skipped: cleanup incomplete; durable handles retained for retry',
      });
    }

    const requiredOk =
      cleanupOk
      && treeOk
      && !failures.some(
        (failure) =>
          failure.stage === 'cooperative_forced_job_cleanup'
          || failure.stage === 'positive_tree_verification'
          || failure.stage === 'close_database'
          || failure.stage === 'flush_jsonl',
      );

    const hasRequired =
      completed.includes('stop_accepting_intents')
      && completed.includes('cooperative_forced_job_cleanup')
      && completed.includes('positive_tree_verification')
      && completed.includes('flush_jsonl')
      && completed.includes('close_workers_watchers')
      && completed.includes('release_locks')
      && completed.includes('close_database');

    if (hasRequired && requiredOk && failures.length === 0) {
      // Set exitAuthorized ONLY after onAuthorizedExit resolves successfully.
      const authOk = await runStage(
        'authorize_ink_exit',
        async () => {
          await options.hooks.onAuthorizedExit?.();
          // Flag set only after hook success (below after authOk check).
        },
        failures,
        completed,
      );
      if (authOk) {
        exitAuthorized = true;
      } else {
        exitAuthorized = false;
      }
    }

    const exitAllowed =
      exitAuthorized
      && completed.includes('authorize_ink_exit')
      && failures.length === 0;

    const result: LifecycleShutdownResult = {
      exitAllowed,
      stagesCompleted: [...completed],
      failures: [...failures],
      reason: request.reason,
    };

    if (exitAllowed) {
      completedResult = result;
    }
    return result;
  };

  return {
    async shutdown(request) {
      if (completedResult !== undefined && completedResult.exitAllowed) {
        return {
          ...completedResult,
          alreadyCompleted: true,
          reason: request.reason,
        };
      }

      // Concurrent callers share the same in-flight promise — never observe
      // premature authorization from a parallel execute.
      if (inFlight !== undefined) {
        return inFlight.then((shared) => ({
          ...shared,
          alreadyCompleted: shared.exitAllowed === true,
          reason: request.reason,
        }));
      }

      const flight = execute(request).finally(() => {
        if (inFlight === flight) {
          inFlight = undefined;
        }
      });
      inFlight = flight;
      return flight;
    },

    isAcceptingIntents(): boolean {
      return acceptingIntents;
    },

    isExitAuthorized(): boolean {
      return exitAuthorized;
    },

    clearCleanupFailure(): void {
      forceCleanupFailure = false;
      completedResult = undefined;
      exitAuthorized = false;
    },

    resetForRetry(): void {
      completedResult = undefined;
      exitAuthorized = false;
    },
  };
}

export function safeCloseDatabase(database: OpenedDatabase | undefined): void {
  if (database === undefined) return;
  try {
    database.close();
  } catch {
    // Closing must remain safe even if SQLite is already closed.
  }
}
