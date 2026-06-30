import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryCircuitBreaker } from './breakers.js';
import { RefCountedLruPool } from './pool.js';
import type { PoolEventType } from './types.js';

describe('pool surfaces breaker events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits breaker-open / half-open / close as creation fails then recovers', async () => {
    const breaker = new InMemoryCircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    let healthy = false;

    const pool = new RefCountedLruPool<string>({
      max: 10,
      breaker,
      factory: async (key) => {
        if (!healthy) throw new Error('factory down');
        return key;
      },
    });

    const events: PoolEventType[] = [];
    pool.on('breaker-open', () => events.push('breaker-open'));
    pool.on('breaker-half-open', () => events.push('breaker-half-open'));
    pool.on('breaker-close', () => events.push('breaker-close'));

    await expect(pool.acquire('a')).rejects.toThrow('factory down');
    expect(breaker.state).toBe('open');

    // breaker open: acquire rejects without hitting the factory
    await expect(pool.acquire('a')).rejects.toBeTruthy();

    healthy = true;
    await vi.advanceTimersByTimeAsync(1000);

    const handle = await pool.acquire('a');
    expect(handle.resource).toBe('a');
    expect(breaker.state).toBe('closed');
    expect(events).toEqual(['breaker-open', 'breaker-half-open', 'breaker-close']);

    handle.release();
    expect(pool.getStats().breaker.open).toBe(1);
  });
});
