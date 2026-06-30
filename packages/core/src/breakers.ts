import type { BreakerState, CircuitBreaker } from './types.js';

export class CircuitOpenError extends Error {
  constructor(message = 'Circuit breaker is open') {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

/** Default breaker: never trips, no overhead. */
export const noopBreaker: CircuitBreaker = {
  state: 'closed',
  exec<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  },
};

export interface InMemoryCircuitBreakerOptions {
  /** Consecutive failures that trip the breaker open. */
  failureThreshold?: number;
  /** Time the breaker stays open before allowing a half-open probe. */
  cooldownMs?: number;
  /** Concurrent probes permitted in the half-open state. */
  halfOpenMaxAttempts?: number;
  /** Clock injection point (defaults to `Date.now`). */
  now?: () => number;
}

/**
 * Dependency-free breaker:
 * closed → (consecutive failures ≥ threshold) → open
 *        → (after cooldown) half-open
 *        → (probe success) closed / (probe failure) open
 */
export class InMemoryCircuitBreaker implements CircuitBreaker {
  private _state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private halfOpenAttempts = 0;
  private readonly listeners = new Set<(state: BreakerState) => void>();

  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly halfOpenMaxAttempts: number;
  private readonly now: () => number;

  constructor(options: InMemoryCircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.halfOpenMaxAttempts = options.halfOpenMaxAttempts ?? 1;
    this.now = options.now ?? (() => Date.now());
  }

  get state(): BreakerState {
    return this._state;
  }

  onStateChange(listener: (state: BreakerState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this._state === 'open') {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.halfOpenAttempts = 0;
        this.transition('half-open');
      } else {
        throw new CircuitOpenError();
      }
    }

    if (this._state === 'half-open') {
      if (this.halfOpenAttempts >= this.halfOpenMaxAttempts) {
        throw new CircuitOpenError();
      }
      this.halfOpenAttempts += 1;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    if (this._state !== 'closed') {
      this.halfOpenAttempts = 0;
      this.transition('closed');
    }
  }

  private onFailure(): void {
    if (this._state === 'half-open') {
      this.openedAt = this.now();
      this.transition('open');
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
      this.transition('open');
    }
  }

  private transition(next: BreakerState): void {
    if (next === this._state) return;
    this._state = next;
    for (const listener of [...this.listeners]) listener(next);
  }
}
