import { isAbsolute, relative, resolve, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';

import { canonicalizeProjectPath } from '../project/canonical-path.js';

import { evaluateIgnorePath } from './ignore-policy.js';

/**
 * Bounded awaitWriteFinish thresholds used by FileWatcher.
 * Kept intentionally low so integration tests remain fast while still
 * coalescing partial writes.
 */
export const FILE_WATCHER_AWAIT_WRITE_FINISH = {
  stabilityThreshold: 100,
  pollInterval: 25,
} as const;

export type WatcherPhase = 'idle' | 'active_attempt' | 'post_baseline_fixed';

export type FileWatcherHint =
  | {
      readonly kind: 'task_window_hint';
      readonly phase: WatcherPhase;
      readonly baselineEpoch: number;
      readonly paths: readonly string[];
      readonly authoritative: false;
      readonly attributed: false;
      readonly agentId?: undefined;
      readonly receivedAt: string;
    }
  | {
      readonly kind: 'confirmed_change_candidate';
      readonly phase: 'post_baseline_fixed';
      readonly baselineEpoch: number;
      readonly paths: readonly string[];
      readonly evidencePaths: readonly string[];
      readonly authoritative: false;
      readonly attributed: false;
      readonly agentId?: undefined;
      readonly requiresAuthoritativeRescan: true;
      readonly receivedAt: string;
    }
  | {
      readonly kind: 'watcher_overflow';
      readonly phase: WatcherPhase;
      readonly baselineEpoch: number;
      readonly requiresFullRescan: true;
      readonly failClosed: true;
      readonly authoritative: false;
      readonly attributed: false;
      readonly agentId?: undefined;
      readonly receivedAt: string;
    }
  | {
      readonly kind: 'watcher_error';
      readonly phase: WatcherPhase;
      readonly baselineEpoch: number;
      readonly message: string;
      readonly requiresFullRescan: true;
      readonly failClosed: true;
      readonly authoritative: false;
      readonly attributed: false;
      readonly agentId?: undefined;
      readonly receivedAt: string;
    };

export interface ReviewInvalidationPort {
  /**
   * Typed port only — no SQL/UI coupling. Callers (workflow/app layer) decide
   * how to persist review/bundle invalidation and transition to awaiting_user.
   */
  readonly invalidateReviewAndBundleEvidence: (input: {
    readonly reason: string;
    readonly baselineId: string;
    readonly evidencePaths: readonly string[];
    readonly requestState: 'awaiting_user';
    readonly baselineEpoch: number;
  }) => void | Promise<void>;
}

export interface VerifyChangeResult {
  readonly confirmed: boolean;
  readonly evidencePaths: readonly string[];
}

export interface FileWatcherOptions {
  readonly projectRoot: string;
  readonly ignoreInitial?: boolean;
  readonly coalesceMs?: number;
  readonly reviewInvalidation?: ReviewInvalidationPort;
  /**
   * Authoritative verification after the attempt baseline is fixed.
   * Watcher events alone are never proof.
   */
  readonly verifyChange?: (
    paths: readonly string[],
    baselineEpoch: number,
  ) => Promise<VerifyChangeResult> | VerifyChangeResult;
  /** Attempt baseline id used when requesting review invalidation. */
  readonly fixedBaselineId?: string;
}

export interface FullRescanAcknowledgement {
  readonly baselineEpoch: number;
  readonly lifecycleGeneration: number;
}

type HintListener = (hint: FileWatcherHint) => void;

function normalizeProjectRelative(projectRoot: string, absoluteOrRelative: string): string | null {
  const absolute = isAbsolute(absoluteOrRelative)
    ? resolve(absoluteOrRelative)
    : resolve(projectRoot, absoluteOrRelative);
  const rel = relative(projectRoot, absolute);
  if (
    rel.length === 0 ||
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return null;
  }
  const posix = rel.split(sep).join('/');
  try {
    if (evaluateIgnorePath(posix).action === 'skip') return null;
  } catch {
    return null;
  }
  return posix;
}

export class FileWatcher {
  private readonly projectRootValue: string;
  private readonly ignoreInitial: boolean;
  private readonly coalesceMs: number;
  private readonly reviewInvalidation?: ReviewInvalidationPort;
  private readonly verifyChange?: FileWatcherOptions['verifyChange'];
  private fixedBaselineId: string;
  private watcher: FSWatcher | undefined;
  private active = false;
  private starting = false;
  private phaseValue: WatcherPhase = 'idle';
  private baselineEpochValue = 0;
  private lifecycleGenerationValue = 0;
  private requiresFullRescanValue = false;
  private unhealthyValue = false;
  private unhealthyEpoch: number | null = null;
  private readonly listeners = new Set<HintListener>();
  private readonly pendingPaths = new Map<string, number>();
  private coalesceTimer: NodeJS.Timeout | undefined;
  private flushPromise: Promise<void> | undefined;
  private inFlightWork: Promise<void> = Promise.resolve();

  public readonly options: {
    readonly followSymlinks: false;
    readonly atomic: true;
    readonly awaitWriteFinish: typeof FILE_WATCHER_AWAIT_WRITE_FINISH;
    readonly ignoreInitial: boolean;
  };

  public constructor(options: FileWatcherOptions) {
    if (!isAbsolute(options.projectRoot)) {
      throw new Error('projectRoot must be absolute');
    }
    let root = resolve(options.projectRoot);
    try {
      root = canonicalizeProjectPath(options.projectRoot, {
        reparseProbe: () => [],
      }).canonicalRoot;
    } catch {
      // Missing roots fail later in start(); keep resolved path for error messages.
    }
    this.projectRootValue = root;
    this.ignoreInitial = options.ignoreInitial ?? true;
    this.coalesceMs = options.coalesceMs ?? 50;
    this.reviewInvalidation = options.reviewInvalidation;
    this.verifyChange = options.verifyChange;
    this.fixedBaselineId = options.fixedBaselineId ?? 'attempt-base';
    this.options = {
      followSymlinks: false,
      atomic: true,
      awaitWriteFinish: FILE_WATCHER_AWAIT_WRITE_FINISH,
      ignoreInitial: this.ignoreInitial,
    };
  }

  public get isActive(): boolean {
    return this.active;
  }

  public get projectRoot(): string {
    return this.projectRootValue;
  }

  public get phase(): WatcherPhase {
    return this.phaseValue;
  }

  public get baselineEpoch(): number {
    return this.baselineEpochValue;
  }

  public get lifecycleGeneration(): number {
    return this.lifecycleGenerationValue;
  }

  public get requiresFullRescan(): boolean {
    return this.requiresFullRescanValue;
  }

  public get isUnhealthy(): boolean {
    return this.unhealthyValue;
  }

  public setPhase(phase: WatcherPhase, baselineEpoch: number): void {
    if (!Number.isInteger(baselineEpoch) || baselineEpoch < 0) {
      throw new Error('baselineEpoch must be a non-negative integer');
    }
    this.phaseValue = phase;
    this.baselineEpochValue = baselineEpoch;
    // Drop coalesced paths from prior epochs so stale bursts cannot fire later.
    this.pendingPaths.clear();
    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = undefined;
    }
  }

  public setFixedBaselineId(baselineId: string): void {
    this.fixedBaselineId = baselineId;
  }

  public onHint(listener: HintListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Explicit authoritative full-rescan acknowledgement.
   * Only clears the fail-closed latch when epoch and lifecycle generation match.
   */
  public acknowledgeAuthoritativeFullRescan(
    acknowledgement: FullRescanAcknowledgement,
  ): boolean {
    if (
      acknowledgement.baselineEpoch !== this.baselineEpochValue ||
      acknowledgement.lifecycleGeneration !== this.lifecycleGenerationValue
    ) {
      return false;
    }
    if (!this.requiresFullRescanValue && !this.unhealthyValue) {
      return true;
    }
    this.requiresFullRescanValue = false;
    this.unhealthyValue = false;
    this.unhealthyEpoch = null;
    return true;
  }

  public async start(): Promise<void> {
    if (this.active) return;
    if (this.starting) {
      throw new Error('FileWatcher start is already in progress');
    }
    this.starting = true;
    try {
      // New lifecycle generation for this start; stale work from prior generations is rejected.
      this.lifecycleGenerationValue += 1;
      const startGeneration = this.lifecycleGenerationValue;

      const canonical = canonicalizeProjectPath(this.projectRootValue, {
        reparseProbe: () => [],
      });
      const root = canonical.canonicalRoot;
      const watcher = watch(root, {
        persistent: true,
        ignoreInitial: this.ignoreInitial,
        followSymlinks: false,
        atomic: true,
        awaitWriteFinish: { ...FILE_WATCHER_AWAIT_WRITE_FINISH },
        ignored: (watchedPath) => {
          const relativePath = normalizeProjectRelative(root, watchedPath);
          if (relativePath === null) {
            const resolved = resolve(watchedPath);
            if (resolve(root) === resolved) return false;
            return true;
          }
          return evaluateIgnorePath(relativePath).action === 'skip';
        },
      });
      this.watcher = watcher;

      await new Promise<void>((resolveReady, rejectReady) => {
        const onReady = (): void => {
          cleanup();
          resolveReady();
        };
        const onError = (error: unknown): void => {
          cleanup();
          rejectReady(error instanceof Error ? error : new Error(String(error)));
        };
        const cleanup = (): void => {
          watcher.off('ready', onReady);
          watcher.off('error', onError);
        };
        watcher.on('ready', onReady);
        watcher.on('error', onError);
      });

      if (
        !this.starting ||
        this.lifecycleGenerationValue !== startGeneration ||
        this.watcher !== watcher
      ) {
        await this.closeWatcherInstance(watcher);
        throw new Error('FileWatcher start aborted by stop/restart');
      }

      watcher.on('all', (_eventName, eventPath) => {
        this.handleRawPath(eventPath);
      });
      watcher.on('error', (error) => {
        // Real Chokidar callbacks are fire-and-forget; track the promise so stop
        // drains fault invalidation and rejections never become unhandled.
        this.trackRealWatcherFault({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });

      this.active = true;
    } catch (error) {
      await this.closeWatcherQuietly();
      this.active = false;
      throw error;
    } finally {
      this.starting = false;
    }
  }

  public async stop(): Promise<void> {
    // Mark inactive and bump generation before close so in-flight work cannot publish/invalidate.
    this.active = false;
    this.lifecycleGenerationValue += 1;
    if (this.coalesceTimer !== undefined) {
      clearTimeout(this.coalesceTimer);
      this.coalesceTimer = undefined;
    }
    this.pendingPaths.clear();
    await this.closeWatcherQuietly();
    // Await any in-flight verify/flush/invalidation so stop is fully drained.
    await this.inFlightWork.catch(() => undefined);
    if (this.flushPromise !== undefined) {
      await this.flushPromise.catch(() => undefined);
    }
    this.active = false;
  }

  /**
   * Test/recovery hook: overflow is untrusted and requires full rescan.
   * Awaitable synthetic path — rejections surface to the caller.
   */
  public async emitSyntheticOverflow(): Promise<void> {
    await this.handleWatcherFault({ kind: 'overflow' });
  }

  /**
   * Test/recovery hook: watcher errors require full rescan / fail closed.
   * Awaitable synthetic path — rejections surface to the caller.
   */
  public async emitSyntheticError(error: Error): Promise<void> {
    await this.handleWatcherFault({
      kind: 'error',
      message: error.message,
    });
  }

  /**
   * Emulates a real Chokidar `error` event callback for tests.
   * Uses the same tracked fire-and-forget path as the live watcher listener
   * (not the awaitable synthetic API).
   */
  public notifyRealWatcherError(error: Error): void {
    this.trackRealWatcherFault({
      kind: 'error',
      message: error.message,
    });
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.active && this.lifecycleGenerationValue === generation;
  }

  /**
   * Track a real (non-synthetic) fault handler promise on the lifecycle work
   * chain. Consumes rejection so Chokidar callbacks never produce unhandled
   * rejections; latch/fail-closed evidence is preserved inside the handler.
   */
  private trackRealWatcherFault(fault: {
    readonly kind: 'overflow' | 'error';
    readonly message?: string;
  }): void {
    const work = this.handleWatcherFault(fault).then(
      () => undefined,
      () => undefined,
    );
    this.trackWork(work);
  }

  private publishHint(hint: FileWatcherHint, generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    for (const listener of this.listeners) {
      try {
        listener(hint);
      } catch {
        // Listeners must not break the watcher.
      }
    }
  }

  private latchFailClosed(epoch: number): void {
    this.requiresFullRescanValue = true;
    this.unhealthyValue = true;
    this.unhealthyEpoch = epoch;
  }

  private trackWork(work: Promise<void>): void {
    this.inFlightWork = this.inFlightWork
      .then(() => work)
      .catch(() => undefined)
      .then(() => undefined);
  }

  private async handleWatcherFault(fault: {
    readonly kind: 'overflow' | 'error';
    readonly message?: string;
  }): Promise<void> {
    const generation = this.lifecycleGenerationValue;
    const epoch = this.baselineEpochValue;
    const phase = this.phaseValue;
    this.latchFailClosed(epoch);

    const hint: FileWatcherHint =
      fault.kind === 'overflow'
        ? {
            kind: 'watcher_overflow',
            phase,
            baselineEpoch: epoch,
            requiresFullRescan: true,
            failClosed: true,
            authoritative: false,
            attributed: false,
            receivedAt: new Date().toISOString(),
          }
        : {
            kind: 'watcher_error',
            phase,
            baselineEpoch: epoch,
            message: fault.message ?? 'watcher error',
            requiresFullRescan: true,
            failClosed: true,
            authoritative: false,
            attributed: false,
            receivedAt: new Date().toISOString(),
          };

    this.publishHint(hint, generation);

    // During active_attempt: unattributed hint only — latch rescan, do not invalidate review yet.
    if (phase !== 'post_baseline_fixed') {
      return;
    }

    if (!this.isCurrentGeneration(generation) || epoch !== this.baselineEpochValue) {
      return;
    }

    await this.invokeInvalidation({
      generation,
      epoch,
      reason:
        fault.kind === 'overflow'
          ? 'watcher overflow requires full rescan; fail-closed review invalidation to awaiting_user'
          : `watcher error requires full rescan; fail-closed review invalidation to awaiting_user: ${fault.message ?? 'unknown'}`,
      evidencePaths: [],
    });
  }

  private async invokeInvalidation(input: {
    readonly generation: number;
    readonly epoch: number;
    readonly reason: string;
    readonly evidencePaths: readonly string[];
  }): Promise<void> {
    if (!this.isCurrentGeneration(input.generation)) return;
    if (input.epoch !== this.baselineEpochValue) return;
    if (this.reviewInvalidation === undefined) return;

    try {
      await this.reviewInvalidation.invalidateReviewAndBundleEvidence({
        reason: input.reason,
        baselineId: this.fixedBaselineId,
        evidencePaths: input.evidencePaths,
        requestState: 'awaiting_user',
        baselineEpoch: input.epoch,
      });
      // Re-check after await: stale generation/epoch must not leave a false healthy state.
      if (!this.isCurrentGeneration(input.generation) || input.epoch !== this.baselineEpochValue) {
        return;
      }
    } catch (error) {
      // Invalidation failure keeps unhealthy latch for the current epoch.
      this.latchFailClosed(input.epoch);
      throw error;
    }
  }

  private handleRawPath(eventPath: string): void {
    if (!this.active) return;
    const relativePath = normalizeProjectRelative(this.projectRootValue, eventPath);
    if (relativePath === null) return;
    const epoch = this.baselineEpochValue;
    this.pendingPaths.set(relativePath, epoch);
    if (this.coalesceTimer !== undefined) clearTimeout(this.coalesceTimer);
    const generation = this.lifecycleGenerationValue;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = undefined;
      if (!this.isCurrentGeneration(generation)) return;
      this.scheduleFlush(generation);
    }, this.coalesceMs);
  }

  private scheduleFlush(generation: number): void {
    if (!this.isCurrentGeneration(generation)) return;
    const previous = this.flushPromise;
    const work = (async () => {
      if (previous !== undefined) {
        await previous.catch(() => undefined);
      }
      await this.runFlush(generation);
    })();
    this.flushPromise = work;
    this.trackWork(work);
  }

  private async runFlush(generation: number): Promise<void> {
    try {
      if (!this.isCurrentGeneration(generation)) return;

      const snapshot = new Map(this.pendingPaths);
      this.pendingPaths.clear();
      if (snapshot.size === 0) return;

      const byEpoch = new Map<number, string[]>();
      for (const [path, epoch] of snapshot) {
        const group = byEpoch.get(epoch) ?? [];
        group.push(path);
        byEpoch.set(epoch, group);
      }

      for (const [epoch, paths] of byEpoch) {
        if (!this.isCurrentGeneration(generation)) return;
        if (epoch !== this.baselineEpochValue) continue;

        const uniquePaths = [...new Set(paths)].sort((left, right) => left.localeCompare(right));

        if (this.phaseValue === 'active_attempt' || this.phaseValue === 'idle') {
          this.publishHint(
            {
              kind: 'task_window_hint',
              phase: this.phaseValue,
              baselineEpoch: epoch,
              paths: uniquePaths,
              authoritative: false,
              attributed: false,
              receivedAt: new Date().toISOString(),
            },
            generation,
          );
          continue;
        }

        this.publishHint(
          {
            kind: 'confirmed_change_candidate',
            phase: 'post_baseline_fixed',
            baselineEpoch: epoch,
            paths: uniquePaths,
            evidencePaths: uniquePaths,
            authoritative: false,
            attributed: false,
            requiresAuthoritativeRescan: true,
            receivedAt: new Date().toISOString(),
          },
          generation,
        );

        if (this.verifyChange === undefined) continue;
        if (!this.isCurrentGeneration(generation) || epoch !== this.baselineEpochValue) return;

        let verification: VerifyChangeResult;
        try {
          verification = await this.verifyChange(uniquePaths, epoch);
        } catch (error) {
          if (!this.isCurrentGeneration(generation) || epoch !== this.baselineEpochValue) {
            return;
          }
          this.latchFailClosed(epoch);
          const message = error instanceof Error ? error.message : String(error);
          this.publishHint(
            {
              kind: 'watcher_error',
              phase: this.phaseValue,
              baselineEpoch: epoch,
              message,
              requiresFullRescan: true,
              failClosed: true,
              authoritative: false,
              attributed: false,
              receivedAt: new Date().toISOString(),
            },
            generation,
          );
          if (this.phaseValue === 'post_baseline_fixed') {
            await this.invokeInvalidation({
              generation,
              epoch,
              reason: `authoritative verify/rescan failed; fail-closed review invalidation to awaiting_user: ${message}`,
              evidencePaths: uniquePaths,
            });
          }
          continue;
        }

        // After every await: require active matching generation/epoch.
        if (!this.isCurrentGeneration(generation) || epoch !== this.baselineEpochValue) {
          return;
        }
        if (!verification.confirmed) continue;

        await this.invokeInvalidation({
          generation,
          epoch,
          reason:
            'authoritative rescan/diff confirmed post-baseline change; review and bundle evidence invalidated',
          evidencePaths: verification.evidencePaths,
        });
      }
    } finally {
      // Reschedule only when still active with the same generation.
      if (this.isCurrentGeneration(generation) && this.pendingPaths.size > 0) {
        if (this.coalesceTimer === undefined) {
          this.coalesceTimer = setTimeout(() => {
            this.coalesceTimer = undefined;
            if (!this.isCurrentGeneration(generation)) return;
            this.scheduleFlush(generation);
          }, this.coalesceMs);
        }
      }
    }
  }

  private async closeWatcherInstance(watcher: FSWatcher): Promise<void> {
    try {
      await watcher.close();
    } catch {
      // Always attempt close; swallow close errors so recovery cannot leak handles.
    }
  }

  private async closeWatcherQuietly(): Promise<void> {
    const current = this.watcher;
    this.watcher = undefined;
    if (current === undefined) return;
    await this.closeWatcherInstance(current);
  }
}
