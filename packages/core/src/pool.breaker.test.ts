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

describe('per-key breaker map is self-bounding', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prunes a closed per-key breaker once its key churns away', async () => {
    let breakerCount = 0;
    const pool = new RefCountedLruPool<string>({
      max: 1,
      mutexGcMs: 1000,
      breaker: () => {
        breakerCount += 1;
        return new InMemoryCircuitBreaker();
      },
      factory: async (key) => key,
    });
    pool.start();

    (await pool.acquire('a')).release(); // per-key breaker 'a' created
    (await pool.acquire('b')).release(); // evicts 'a' (max 1); breaker 'b' created
    expect(breakerCount).toBe(2);

    // 'a' has no live entry/orphan/pending and its breaker is closed → GC prunes it.
    await vi.advanceTimersByTimeAsync(1000);

    (await pool.acquire('a')).release(); // breaker must be recreated → observable proof of pruning
    expect(breakerCount).toBe(3);

    await pool.stop();
  });

  it('retains an open breaker even when its key is gone', async () => {
    let breakerCount = 0;
    const pool = new RefCountedLruPool<string>({
      max: 5,
      mutexGcMs: 1000,
      breaker: () => {
        breakerCount += 1;
        return new InMemoryCircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 });
      },
      factory: async () => {
        throw new Error('down');
      },
    });
    pool.start();

    await expect(pool.acquire('a')).rejects.toThrow('down'); // breaker 'a' trips open, nothing cached
    expect(breakerCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1000); // GC runs, but an open breaker is preserved

    // still open (cooldown not elapsed) → short-circuits on the SAME breaker, no recreation
    await expect(pool.acquire('a')).rejects.toBeTruthy();
    expect(breakerCount).toBe(1);

    await pool.stop();
  });
});
