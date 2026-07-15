export interface WorkerHeartbeatOptions {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly onBeat?: (sequence: number, sentAt: string) => void;
  readonly onTimeout?: (lastSeenAt: number, sequence: number) => void;
}

/**
 * Tracks Worker liveness. Emits periodic beats from the worker side and
 * detects heartbeat timeout on the manager side. Timers are always cleared
 * by {@link stop}.
 */
export class WorkerHeartbeatMonitor {
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #onBeat?: (sequence: number, sentAt: string) => void;
  readonly #onTimeout?: (lastSeenAt: number, sequence: number) => void;
  #sequence = 0;
  #lastSeenAt: number;
  #beatTimer: ReturnType<typeof setInterval> | undefined;
  #watchTimer: ReturnType<typeof setInterval> | undefined;
  #stopped = true;
  #timedOut = false;

  public constructor(options: WorkerHeartbeatOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1) {
      throw new Error('heartbeat intervalMs must be a positive integer');
    }
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new Error('heartbeat timeoutMs must be a positive integer');
    }
    if (options.timeoutMs < options.intervalMs) {
      throw new Error('heartbeat timeoutMs must be >= intervalMs');
    }
    this.#intervalMs = options.intervalMs;
    this.#timeoutMs = options.timeoutMs;
    this.#now = options.now ?? (() => Date.now());
    this.#onBeat = options.onBeat;
    this.#onTimeout = options.onTimeout;
    this.#lastSeenAt = this.#now();
  }

  public get sequence(): number {
    return this.#sequence;
  }

  public get lastSeenAt(): number {
    return this.#lastSeenAt;
  }

  public get timedOut(): boolean {
    return this.#timedOut;
  }

  public get stopped(): boolean {
    return this.#stopped;
  }

  /** Start emitting beats (worker side). */
  public startBeating(): void {
    this.#stopped = false;
    this.#timedOut = false;
    this.#lastSeenAt = this.#now();
    this.#clearBeatTimer();
    this.#emitBeat();
    this.#beatTimer = setInterval(() => {
      this.#emitBeat();
    }, this.#intervalMs);
    if (typeof this.#beatTimer.unref === 'function') {
      this.#beatTimer.unref();
    }
  }

  /** Start watching for missing beats (manager side). */
  public startWatching(): void {
    this.#stopped = false;
    this.#timedOut = false;
    this.#lastSeenAt = this.#now();
    this.#clearWatchTimer();
    this.#watchTimer = setInterval(() => {
      this.#checkTimeout();
    }, Math.min(this.#intervalMs, 100));
    if (typeof this.#watchTimer.unref === 'function') {
      this.#watchTimer.unref();
    }
  }

  public noteBeat(sequence: number, sentAt?: string): void {
    if (this.#stopped) return;
    if (Number.isSafeInteger(sequence) && sequence >= this.#sequence) {
      this.#sequence = sequence;
    }
    if (sentAt !== undefined) {
      const parsed = Date.parse(sentAt);
      this.#lastSeenAt = Number.isFinite(parsed) ? parsed : this.#now();
    } else {
      this.#lastSeenAt = this.#now();
    }
  }

  public stop(): void {
    this.#stopped = true;
    this.#clearBeatTimer();
    this.#clearWatchTimer();
  }

  #emitBeat(): void {
    if (this.#stopped) return;
    this.#sequence += 1;
    const sentAt = new Date(this.#now()).toISOString();
    this.#lastSeenAt = this.#now();
    this.#onBeat?.(this.#sequence, sentAt);
  }

  #checkTimeout(): void {
    if (this.#stopped || this.#timedOut) return;
    const elapsed = this.#now() - this.#lastSeenAt;
    if (elapsed > this.#timeoutMs) {
      this.#timedOut = true;
      this.#clearWatchTimer();
      this.#onTimeout?.(this.#lastSeenAt, this.#sequence);
    }
  }

  #clearBeatTimer(): void {
    if (this.#beatTimer !== undefined) {
      clearInterval(this.#beatTimer);
      this.#beatTimer = undefined;
    }
  }

  #clearWatchTimer(): void {
    if (this.#watchTimer !== undefined) {
      clearInterval(this.#watchTimer);
      this.#watchTimer = undefined;
    }
  }
}
