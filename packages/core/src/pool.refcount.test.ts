import { describe, expect, it } from 'vitest';
import { makePool } from './test-utils.js';

describe('reference counting', () => {
  it('creates once per key and shares across holders', async () => {
    const { pool, created } = makePool();
    const h1 = await pool.acquire('a');
    const h2 = await pool.acquire('a');

    expect(created).toEqual(['a']);
    expect(h1.resource).toBe(h2.resource);

    const stats = pool.getStats();
    expect(stats.inUse).toBe(1);
    expect(stats.idle).toBe(0);
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);

    h1.release();
    h2.release();
  });

  it('disposes only when refcount reaches zero', async () => {
    const { pool, disposed } = makePool({ max: 10 });
    const h1 = await pool.acquire('a');
    const h2 = await pool.acquire('a');

    h1.release();
    expect(disposed).toEqual([]);
    expect(pool.getStats().inUse).toBe(1);

    h2.release();
    // refcount 0 but under max → kept idle, not disposed
    expect(disposed).toEqual([]);
    expect(pool.getStats().idle).toBe(1);

    await pool.drain();
    expect(disposed).toEqual(['a']);
  });

  it('release(key) drops a single reference on the live resource', async () => {
    const { pool, disposed } = makePool();
    await pool.acquire('a');
    await pool.acquire('a');

    pool.release('a');
    expect(disposed).toEqual([]);
    expect(pool.getStats().inUse).toBe(1);

    pool.release('a');
    expect(pool.getStats().idle).toBe(1);
  });
});
