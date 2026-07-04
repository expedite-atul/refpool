import { describe, expect, it } from 'vitest';
import { AcquireTimeoutError, PoolExhaustedError } from './errors.js';
import { makePool } from './test-utils.js';

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('backpressure enforces max as a hard ceiling', () => {
  it('blocks a (max+1)th acquire until a holder releases, never exceeding max', async () => {
    const max = 2;
    const { pool } = makePool({ max, acquireTimeoutMs: 1000 });

    const h0 = await pool.acquire('k0');
    const h1 = await pool.acquire('k1');
    expect(pool.getStats().live).toBe(max);

    let served = false;
    const pending = pool.acquire('k2').then((handle) => {
      served = true;
      return handle;
    });

    await tick();
    expect(served).toBe(false); // saturated: the acquire is parked
    expect(pool.getStats().waiters).toBe(1);
    expect(pool.getStats().live).toBe(max); // never over the ceiling

    h0.release(); // frees a slot → wakes the waiter, which evicts k0 and creates k2
    const h2 = await pending;
    expect(served).toBe(true);
    expect(pool.getStats().live).toBe(max);
    expect(pool.getStats().waiters).toBe(0);

    h1.release();
    h2.release();
  });

  it('serves a backlog of distinct keys as holders release, staying at max', async () => {
    const max = 3;
    const { pool } = makePool({ max, acquireTimeoutMs: 2000 });

    const held = await Promise.all(['a', 'b', 'c'].map((k) => pool.acquire(k)));
    const backlog = Promise.all(['d', 'e', 'f'].map((k) => pool.acquire(k)));

    await tick();
    expect(pool.getStats().live).toBe(max);
    expect(pool.getStats().waiters).toBe(3);

    for (const handle of held) {
      handle.release();
      await tick(5);
      expect(pool.getStats().live).toBeLessThanOrEqual(max);
    }

    const later = await backlog;
    expect(pool.getStats().live).toBe(max);
    expect(pool.getStats().waiters).toBe(0);
    for (const handle of later) handle.release();
  });

  it('rejects with AcquireTimeoutError when saturated past the timeout', async () => {
    const { pool } = makePool({ max: 1, acquireTimeoutMs: 30 });

    const h = await pool.acquire('a');
    await expect(pool.acquire('b')).rejects.toBeInstanceOf(AcquireTimeoutError);
    // The timed-out waiter is removed from the queue (no leak).
    expect(pool.getStats().waiters).toBe(0);

    h.release();
  });

  it('rejects with PoolExhaustedError when the waiter queue is full', async () => {
    const { pool } = makePool({ max: 1, maxWaiters: 1, acquireTimeoutMs: 1000 });

    const h = await pool.acquire('a');
    const first = pool.acquire('b'); // parks (queue length 1)
    await tick();
    expect(pool.getStats().waiters).toBe(1);

    // Queue is full → a further acquire rejects immediately.
    await expect(pool.acquire('c')).rejects.toBeInstanceOf(PoolExhaustedError);
    expect(pool.getStats().waiters).toBe(1);

    h.release();
    (await first).release();
  });
});
