import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitOpenError, InMemoryCircuitBreaker, noopBreaker } from './breakers.js';
import type { BreakerState } from './types.js';

describe('noopBreaker', () => {
  it('passes through and stays closed', async () => {
    await expect(noopBreaker.exec(() => Promise.resolve(7))).resolves.toBe(7);
    expect(noopBreaker.state).toBe('closed');
  });
});

describe('InMemoryCircuitBreaker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('transitions closed → open → half-open → closed', async () => {
    const breaker = new InMemoryCircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
    const states: BreakerState[] = [];
    breaker.onStateChange((state) => states.push(state));

    const boom = () => Promise.reject(new Error('boom'));
    await expect(breaker.exec(boom)).rejects.toThrow('boom');
    expect(breaker.state).toBe('closed');
    await expect(breaker.exec(boom)).rejects.toThrow('boom');
    expect(breaker.state).toBe('open');

    // open: rejects fast without invoking the action
    await expect(breaker.exec(() => Promise.resolve('nope'))).rejects.toBeInstanceOf(
      CircuitOpenError,
    );

    await vi.advanceTimersByTimeAsync(1000);

    await expect(breaker.exec(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
    expect(states).toEqual(['open', 'half-open', 'closed']);
  });

  it('returns to open if the half-open probe fails', async () => {
    const breaker = new InMemoryCircuitBreaker({ failureThreshold: 1, cooldownMs: 500 });
    const boom = () => Promise.reject(new Error('boom'));

    await expect(breaker.exec(boom)).rejects.toThrow();
    expect(breaker.state).toBe('open');

    await vi.advanceTimersByTimeAsync(500);
    await expect(breaker.exec(boom)).rejects.toThrow('boom');
    expect(breaker.state).toBe('open');
  });
});
