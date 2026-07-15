export interface BudgetClockSource {
  now(): string;
  schedule(afterMs: number, action: () => void): void;
  advanceBy?(milliseconds: number): void;
}

/**
 * Thin adapter over the deterministic FakeClock (or any compatible source)
 * so BudgetController does not depend on test fakes directly.
 */
export class BudgetClock {
  readonly #source: BudgetClockSource;

  public constructor(source: BudgetClockSource) {
    this.#source = source;
  }

  public now(): string {
    return this.#source.now();
  }

  public nowMs(): number {
    const parsed = Date.parse(this.now());
    if (!Number.isFinite(parsed)) {
      throw new Error('budget clock requires a valid ISO timestamp');
    }
    return parsed;
  }

  public schedule(afterMs: number, action: () => void): void {
    if (!Number.isSafeInteger(afterMs) || afterMs < 0) {
      throw new Error('budget clock delay must be a non-negative safe integer');
    }
    this.#source.schedule(afterMs, action);
  }

  public elapsedBetween(startedAt: string, endedAt: string): number {
    const startMs = Date.parse(startedAt);
    const endMs = Date.parse(endedAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      throw new Error('budget clock elapsed requires valid ISO timestamps');
    }
    if (endMs < startMs) {
      throw new Error('budget clock elapsed cannot be negative');
    }
    return endMs - startMs;
  }
}
