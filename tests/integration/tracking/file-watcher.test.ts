import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  FileWatcher,
  FILE_WATCHER_AWAIT_WRITE_FINISH,
  type FileWatcherHint,
  type ReviewInvalidationPort,
} from '../../../src/tracking/file-watcher.js';
import { NonGitBaselineService } from '../../../src/tracking/non-git-baseline-service.js';

const temporaryDirectories: string[] = [];
const openWatchers: FileWatcher[] = [];

function temporaryDirectory(prefix = 'triagent-file-watcher-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createProject(): { projectRoot: string; snapshots: string } {
  const root = temporaryDirectory();
  const projectRoot = join(root, 'project');
  const snapshots = join(root, 'snapshots');
  mkdirSync(projectRoot);
  mkdirSync(snapshots);
  writeFileSync(join(projectRoot, 'seed.txt'), 'seed\n');
  return { projectRoot, snapshots };
}

async function startWatcher(
  projectRoot: string,
  options: ConstructorParameters<typeof FileWatcher>[0] extends infer T
    ? Omit<T, 'projectRoot'>
    : never = {},
): Promise<FileWatcher> {
  const watcher = new FileWatcher({
    projectRoot,
    ignoreInitial: true,
    ...options,
  });
  openWatchers.push(watcher);
  await watcher.start();
  expect(watcher.isActive).toBe(true);
  return watcher;
}

afterEach(async () => {
  while (openWatchers.length > 0) {
    const watcher = openWatchers.pop()!;
    try {
      await watcher.stop();
    } catch {
      // ensure cleanup continues
    }
  }
  for (const directory of temporaryDirectories.splice(0).reverse()) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(intervalMs);
  }
  throw new Error('condition not met before timeout');
}

describe('Chokidar file watcher safe-window semantics', () => {
  it('exports Chokidar 5 compatible awaitWriteFinish thresholds that stay bounded and tested', () => {
    expect(FILE_WATCHER_AWAIT_WRITE_FINISH.stabilityThreshold).toBeGreaterThan(0);
    expect(FILE_WATCHER_AWAIT_WRITE_FINISH.stabilityThreshold).toBeLessThanOrEqual(500);
    expect(FILE_WATCHER_AWAIT_WRITE_FINISH.pollInterval).toBeGreaterThan(0);
    expect(FILE_WATCHER_AWAIT_WRITE_FINISH.pollInterval).toBeLessThanOrEqual(
      FILE_WATCHER_AWAIT_WRITE_FINISH.stabilityThreshold,
    );
  });

  it('awaits ready before claiming active and always awaits close including after errors', async () => {
    const { projectRoot } = createProject();
    const watcher = new FileWatcher({ projectRoot, ignoreInitial: true });
    openWatchers.push(watcher);
    expect(watcher.isActive).toBe(false);
    await watcher.start();
    expect(watcher.isActive).toBe(true);
    expect(watcher.options.followSymlinks).toBe(false);
    expect(watcher.options.atomic).toBe(true);
    expect(watcher.options.awaitWriteFinish).toEqual(FILE_WATCHER_AWAIT_WRITE_FINISH);
    expect(watcher.options.ignoreInitial).toBe(true);

    await watcher.stop();
    expect(watcher.isActive).toBe(false);
    // second close is safe
    await watcher.stop();
    expect(watcher.isActive).toBe(false);
  });

  it('emits unattributed task-window hints during an active attempt and never assigns agent blame', async () => {
    const { projectRoot } = createProject();
    const hints: FileWatcherHint[] = [];
    const watcher = await startWatcher(projectRoot);
    watcher.setPhase('active_attempt', 1);
    const unsubscribe = watcher.onHint((hint) => {
      hints.push(hint);
    });

    writeFileSync(join(projectRoot, 'during-attempt.txt'), 'write\n');
    await waitFor(() => hints.length > 0);

    for (const hint of hints) {
      expect(hint.attributed).toBe(false);
      expect(hint.authoritative).toBe(false);
      expect(hint.agentId).toBeUndefined();
      if (hint.kind === 'task_window_hint') {
        expect(hint.phase).toBe('active_attempt');
        expect(hint.paths.every((path) => !path.includes('\\'))).toBe(true);
        expect(hint.paths).toContain('during-attempt.txt');
      }
    }
    unsubscribe();
  });

  it('coalesces bursts without dropping evidence path coverage', async () => {
    const { projectRoot } = createProject();
    const hints: FileWatcherHint[] = [];
    const watcher = await startWatcher(projectRoot, {
      coalesceMs: 80,
    });
    watcher.setPhase('active_attempt', 1);
    watcher.onHint((hint) => {
      hints.push(hint);
    });

    writeFileSync(join(projectRoot, 'burst-a.txt'), 'a\n');
    writeFileSync(join(projectRoot, 'burst-b.txt'), 'b\n');
    writeFileSync(join(projectRoot, 'burst-c.txt'), 'c\n');

    await waitFor(() =>
      hints.some(
        (hint) =>
          hint.kind === 'task_window_hint' &&
          hint.paths.includes('burst-a.txt') &&
          hint.paths.includes('burst-b.txt') &&
          hint.paths.includes('burst-c.txt'),
      ),
    );

    const windowHints = hints.filter((hint) => hint.kind === 'task_window_hint');
    expect(windowHints.length).toBeGreaterThanOrEqual(1);
    expect(windowHints.length).toBeLessThan(6);
  });

  it('after a fixed attempt baseline, confirmed changes require authoritative rescan, invalidate review evidence, and request awaiting_user', async () => {
    const { projectRoot, snapshots } = createProject();
    const tracker = new NonGitBaselineService({
      projectRoot,
      snapshotStore: snapshots,
    });
    const task = tracker.captureTaskBaseline({
      taskId: 'task-safe-window',
      baselineId: 'task-base',
    });
    const attempt = tracker.captureAttemptBaseline({
      taskId: 'task-safe-window',
      baselineId: 'attempt-base',
      attemptId: 'attempt-1',
      attemptNumber: 1,
      parentTaskBaselineId: task.baselineId,
    });

    const invalidations: Array<{
      readonly reason: string;
      readonly baselineId: string;
      readonly requestState: string;
    }> = [];
    const reviewPort: ReviewInvalidationPort = {
      invalidateReviewAndBundleEvidence(input) {
        invalidations.push({
          reason: input.reason,
          baselineId: input.baselineId,
          requestState: input.requestState,
        });
      },
    };

    const hints: FileWatcherHint[] = [];
    const watcher = await startWatcher(projectRoot, {
      reviewInvalidation: reviewPort,
      verifyChange: async (paths) => {
        const changes = tracker.diffAgainstBaseline(attempt.baselineId);
        const changedPaths = new Set(changes.changes.map((change) => change.path));
        return {
          confirmed: paths.some((path) => changedPaths.has(path)) || changes.changes.length > 0,
          evidencePaths: changes.changes.map((change) => change.path),
        };
      },
    });
    watcher.setPhase('post_baseline_fixed', 10);
    watcher.onHint((hint) => {
      hints.push(hint);
    });

    writeFileSync(join(projectRoot, 'after-baseline.txt'), 'new\n');
    await waitFor(() => invalidations.length > 0, 8_000);

    expect(hints.some((hint) => hint.kind === 'confirmed_change_candidate')).toBe(true);
    for (const hint of hints) {
      expect(hint.attributed).toBe(false);
      expect(hint.authoritative).toBe(false);
    }
    expect(invalidations[0]).toMatchObject({
      baselineId: 'attempt-base',
      requestState: 'awaiting_user',
    });
    expect(invalidations[0]?.reason).toMatch(/authoritative|rescan|diff|change/i);
  });

  it('drops stale events from before the baseline epoch so they cannot invalidate a new review', async () => {
    const { projectRoot } = createProject();
    const invalidations: string[] = [];
    const reviewPort: ReviewInvalidationPort = {
      invalidateReviewAndBundleEvidence(input) {
        invalidations.push(input.reason);
      },
    };
    const watcher = await startWatcher(projectRoot, {
      reviewInvalidation: reviewPort,
      verifyChange: async () => ({ confirmed: true, evidencePaths: ['stale.txt'] }),
      // Long coalesce so we can advance the baseline epoch after the event is queued
      // but before the coalesced flush runs.
      coalesceMs: 400,
    });

    // Events captured under epoch 1 must not apply after epoch advances.
    watcher.setPhase('post_baseline_fixed', 1);
    writeFileSync(join(projectRoot, 'stale.txt'), 'stale\n');
    // Wait past awaitWriteFinish so the raw event is accepted under epoch 1.
    await delay(250);
    // Advance epoch (and clear pending) before the coalesce window elapses.
    watcher.setPhase('post_baseline_fixed', 2);

    // Allow any pending coalesce timers for epoch 1 to fire (should be none / stale-dropped).
    await delay(500);
    expect(invalidations).toHaveLength(0);

    writeFileSync(join(projectRoot, 'fresh.txt'), 'fresh\n');
    await waitFor(() => invalidations.length > 0, 8_000);
    expect(invalidations).toHaveLength(1);
  });

  it('requires full rescan / fail-closed on watcher overflow or error', async () => {
    const { projectRoot } = createProject();
    const hints: FileWatcherHint[] = [];
    const watcher = await startWatcher(projectRoot);
    watcher.setPhase('post_baseline_fixed', 1);
    watcher.onHint((hint) => {
      hints.push(hint);
    });

    await watcher.emitSyntheticOverflow();
    await waitFor(() => hints.some((hint) => hint.kind === 'watcher_overflow'));
    const overflow = hints.find((hint) => hint.kind === 'watcher_overflow');
    expect(overflow).toMatchObject({
      requiresFullRescan: true,
      failClosed: true,
      authoritative: false,
      attributed: false,
    });
    expect(watcher.requiresFullRescan).toBe(true);

    await watcher.emitSyntheticError(new Error('watcher broken'));
    await waitFor(() => hints.some((hint) => hint.kind === 'watcher_error'));
    const errorHint = hints.find((hint) => hint.kind === 'watcher_error');
    expect(errorHint).toMatchObject({
      requiresFullRescan: true,
      failClosed: true,
      authoritative: false,
      attributed: false,
    });
    expect(watcher.isUnhealthy).toBe(true);
  });

  it('normalizes watcher paths to canonical project-relative posix form', async () => {
    const { projectRoot } = createProject();
    mkdirSync(join(projectRoot, 'nested'), { recursive: true });
    const hints: FileWatcherHint[] = [];
    const watcher = await startWatcher(projectRoot);
    watcher.setPhase('active_attempt', 1);
    watcher.onHint((hint) => {
      hints.push(hint);
    });
    writeFileSync(join(projectRoot, 'nested', 'path.txt'), 'p\n');
    await waitFor(() =>
      hints.some(
        (hint) =>
          hint.kind === 'task_window_hint' && hint.paths.includes('nested/path.txt'),
      ),
    );
    const paths = hints.flatMap((hint) => ('paths' in hint ? hint.paths : []));
    expect(paths.every((path) => !path.includes('\\'))).toBe(true);
    expect(paths.every((path) => !/^[A-Za-z]:/.test(path))).toBe(true);
  });

  it('does not leak watchers when start fails recovery path is exercised', async () => {
    const missingRoot = join(temporaryDirectory(), 'does-not-exist');
    const watcher = new FileWatcher({ projectRoot: missingRoot });
    openWatchers.push(watcher);
    await expect(watcher.start()).rejects.toThrow();
    expect(watcher.isActive).toBe(false);
    await watcher.stop();
    expect(watcher.isActive).toBe(false);
  });

  it('stop awaits in-flight verify/flush; late resolution after stop cannot invalidate', async () => {
    const { projectRoot } = createProject();
    const invalidations: Array<{ readonly reason: string; readonly baselineEpoch: number }> = [];
    let resolveVerify!: (value: { confirmed: boolean; evidencePaths: string[] }) => void;
    let markVerifyStarted: () => void = () => {};
    const verifyGate = new Promise<void>((resolveGate) => {
      markVerifyStarted = resolveGate;
    });

    const reviewPort: ReviewInvalidationPort = {
      invalidateReviewAndBundleEvidence(input) {
        invalidations.push({
          reason: input.reason,
          baselineEpoch: input.baselineEpoch,
        });
      },
    };

    const watcher = await startWatcher(projectRoot, {
      reviewInvalidation: reviewPort,
      coalesceMs: 20,
      verifyChange: async () => {
        markVerifyStarted();
        return await new Promise((resolve) => {
          resolveVerify = resolve;
        });
      },
    });
    watcher.setPhase('post_baseline_fixed', 5);
    writeFileSync(join(projectRoot, 'inflight.txt'), 'x\n');
    await verifyGate;

    const stopPromise = watcher.stop();
    // Late resolution after stop has begun must not invalidate.
    resolveVerify({ confirmed: true, evidencePaths: ['inflight.txt'] });
    await stopPromise;

    expect(watcher.isActive).toBe(false);
    expect(invalidations).toHaveLength(0);
  });

  it('restart after stop cannot receive stale invalidation from a prior generation flush', async () => {
    const { projectRoot } = createProject();
    const invalidations: Array<{ readonly reason: string; readonly baselineEpoch: number }> = [];
    let resolveFirstVerify!: (value: { confirmed: boolean; evidencePaths: string[] }) => void;
    let markFirst: () => void = () => {};
    const waitFirst = new Promise<void>((resolveGate) => {
      markFirst = resolveGate;
    });

    let verifyCall = 0;
    const reviewPort: ReviewInvalidationPort = {
      invalidateReviewAndBundleEvidence(input) {
        invalidations.push({
          reason: input.reason,
          baselineEpoch: input.baselineEpoch,
        });
      },
    };

    const watcher = await startWatcher(projectRoot, {
      reviewInvalidation: reviewPort,
      coalesceMs: 20,
      verifyChange: async () => {
        verifyCall += 1;
        if (verifyCall === 1) {
          markFirst();
          return await new Promise((resolve) => {
            resolveFirstVerify = resolve;
          });
        }
        return { confirmed: false, evidencePaths: [] };
      },
    });
    watcher.setPhase('post_baseline_fixed', 1);
    writeFileSync(join(projectRoot, 'gen1.txt'), 'g1\n');
    await waitFirst;

    // stop() bumps lifecycle generation then awaits in-flight verify/flush.
    // Resolve while draining so stop can complete; invalidation must still be dropped.
    const stopPromise = watcher.stop();
    resolveFirstVerify({ confirmed: true, evidencePaths: ['gen1.txt'] });
    await stopPromise;
    expect(watcher.isActive).toBe(false);
    expect(invalidations).toHaveLength(0);

    // Restart under a new lifecycle generation cannot inherit stale invalidation.
    await watcher.start();
    expect(watcher.isActive).toBe(true);
    watcher.setPhase('post_baseline_fixed', 2);
    await delay(150);

    expect(invalidations).toHaveLength(0);
  });

  it('error/overflow in post_baseline_fixed latch fail-closed and invalidate even without hint listeners', async () => {
    const { projectRoot } = createProject();
    const invalidations: Array<{
      readonly reason: string;
      readonly requestState: string;
      readonly baselineEpoch: number;
    }> = [];
    const reviewPort: ReviewInvalidationPort = {
      async invalidateReviewAndBundleEvidence(input) {
        invalidations.push({
          reason: input.reason,
          requestState: input.requestState,
          baselineEpoch: input.baselineEpoch,
        });
      },
    };

    // No onHint listener — invalidation must still run.
    const watcher = await startWatcher(projectRoot, {
      reviewInvalidation: reviewPort,
    });
    watcher.setPhase('post_baseline_fixed', 7);

    await watcher.emitSyntheticOverflow();
    expect(watcher.requiresFullRescan).toBe(true);
    expect(watcher.isUnhealthy).toBe(true);
    await waitFor(() => invalidations.length >= 1);
    expect(invalidations[0]).toMatchObject({
      requestState: 'awaiting_user',
      baselineEpoch: 7,
    });
    expect(invalidations[0]?.reason).toMatch(/overflow|rescan|fail/i);

    await watcher.emitSyntheticError(new Error('disk watcher failed'));
    await waitFor(() => invalidations.length >= 2);
    expect(watcher.requiresFullRescan).toBe(true);
    expect(watcher.isUnhealthy).toBe(true);
  });

  it('verifyChange failure in post_baseline_fixed latches rescan and invalidates to awaiting_user', async () => {
    const { projectRoot } = createProject();
    const invalidations: Array<{ readonly reason: string; readonly requestState: string }> = [];
    const reviewPort: ReviewInvalidationPort = {
      invalidateReviewAndBundleEvidence(input) {
        invalidations.push({
          reason: input.reason,
          requestState: input.requestState,
        });
      },
    };
    const hints: FileWatcherHint[] = [];
    const watcher = await startWatcher(projectRoot, {
      reviewInvalidation: reviewPort,
      coalesceMs: 20,
      verifyChange: async () => {
        throw new Error('authoritative rescan failed');
      },
    });
    watcher.setPhase('post_baseline_fixed', 3);
    watcher.onHint((hint) => {
      hints.push(hint);
    });

    writeFileSync(join(projectRoot, 'verify-fail.txt'), 'v\n');
    await waitFor(() => invalidations.length > 0, 8_000);

    expect(hints.some((hint) => hint.kind === 'watcher_error')).toBe(true);
    expect(watcher.requiresFullRescan).toBe(true);
    expect(watcher.isUnhealthy).toBe(true);
    expect(invalidations[0]?.requestState).toBe('awaiting_user');
    expect(invalidations[0]?.reason).toMatch(/rescan|verify|fail|error/i);
  });

  it('invalidation failure keeps unhealthy; only matching-epoch full-rescan ack clears the latch', async () => {
    const { projectRoot } = createProject();
    let shouldFailInvalidation = true;
    const reviewPort: ReviewInvalidationPort = {
      async invalidateReviewAndBundleEvidence() {
        if (shouldFailInvalidation) {
          throw new Error('persist review invalidation failed');
        }
      },
    };
    const watcher = await startWatcher(projectRoot, {
      reviewInvalidation: reviewPort,
    });
    watcher.setPhase('post_baseline_fixed', 4);

    await expect(watcher.emitSyntheticError(new Error('boom'))).rejects.toThrow(
      /persist review invalidation failed|boom/i,
    );
    // Even if emit rethrows invalidation failure, latch stays unhealthy.
    expect(watcher.requiresFullRescan).toBe(true);
    expect(watcher.isUnhealthy).toBe(true);

    // Wrong epoch cannot clear.
    expect(
      watcher.acknowledgeAuthoritativeFullRescan({
        baselineEpoch: 99,
        lifecycleGeneration: watcher.lifecycleGeneration,
      }),
    ).toBe(false);
    expect(watcher.requiresFullRescan).toBe(true);

    // Matching epoch + generation clears only after explicit ack.
    shouldFailInvalidation = false;
    expect(
      watcher.acknowledgeAuthoritativeFullRescan({
        baselineEpoch: 4,
        lifecycleGeneration: watcher.lifecycleGeneration,
      }),
    ).toBe(true);
    expect(watcher.requiresFullRescan).toBe(false);
    expect(watcher.isUnhealthy).toBe(false);
  });

  it('during active_attempt errors remain unattributed but still latch rescan requirement', async () => {
    const { projectRoot } = createProject();
    const invalidations: string[] = [];
    const reviewPort: ReviewInvalidationPort = {
      invalidateReviewAndBundleEvidence(input) {
        invalidations.push(input.reason);
      },
    };
    const hints: FileWatcherHint[] = [];
    const watcher = await startWatcher(projectRoot, {
      reviewInvalidation: reviewPort,
    });
    watcher.setPhase('active_attempt', 2);
    watcher.onHint((hint) => {
      hints.push(hint);
    });

    await watcher.emitSyntheticOverflow();
    expect(watcher.requiresFullRescan).toBe(true);
    // Active attempt: do not assign blame / do not invalidate review yet.
    expect(invalidations).toHaveLength(0);
    const overflow = hints.find((hint) => hint.kind === 'watcher_overflow');
    expect(overflow).toMatchObject({
      attributed: false,
      authoritative: false,
      requiresFullRescan: true,
      phase: 'active_attempt',
    });
  });

  it('real watcher error callback is tracked: stop drains deferred rejecting invalidation without unhandled rejection', async () => {
    const { projectRoot } = createProject();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    let settleInvalidation!: (error: Error) => void;
    let invalidationStarted = false;
    let invalidationSettled = false;
    let postStopInvalidationCalls = 0;
    let stopped = false;

    try {
      const reviewPort: ReviewInvalidationPort = {
        async invalidateReviewAndBundleEvidence() {
          if (stopped) {
            postStopInvalidationCalls += 1;
          }
          invalidationStarted = true;
          await new Promise<void>((_resolve, reject) => {
            settleInvalidation = (error) => {
              invalidationSettled = true;
              reject(error);
            };
          });
        },
      };

      const watcher = await startWatcher(projectRoot, {
        reviewInvalidation: reviewPort,
      });
      watcher.setPhase('post_baseline_fixed', 11);

      // Emulate the real Chokidar error callback path (tracked, not synthetic await).
      watcher.notifyRealWatcherError(new Error('chokidar native error'));
      await waitFor(() => invalidationStarted);

      expect(watcher.requiresFullRescan).toBe(true);
      expect(watcher.isUnhealthy).toBe(true);

      const stopPromise = watcher.stop().then(() => {
        stopped = true;
      });

      // stop must not finish while fault invalidation is still deferred.
      await delay(40);
      expect(stopped).toBe(false);
      expect(invalidationSettled).toBe(false);

      settleInvalidation(new Error('persist review invalidation failed'));
      await stopPromise;

      expect(stopped).toBe(true);
      expect(watcher.isActive).toBe(false);
      // Rejection was consumed by the tracked wrapper; latch stays fail-closed.
      expect(watcher.requiresFullRescan).toBe(true);
      expect(watcher.isUnhealthy).toBe(true);
      expect(postStopInvalidationCalls).toBe(0);
      // Allow microtasks from rejection handling to flush.
      await delay(20);
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
