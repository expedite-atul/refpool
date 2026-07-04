import { describe, expect, it } from 'vitest';
import { makePool } from './test-utils.js';

describe('scales to a large working set', () => {
  it('stays bounded at max across thousands of distinct keys', async () => {
    const max = 50;
    const total = 5_000;
    const { pool, created, disposed } = makePool({ max });

    for (let i = 0; i < total; i += 1) {
      (await pool.acquire(`k${i}`)).release();
      expect(pool.getStats().live).toBeLessThanOrEqual(max);
    }

    // Every key was created once; everything past the ceiling was evicted.
    expect(created.length).toBe(total);
    expect(pool.getStats().live).toBe(max);
    expect(disposed.length).toBe(total - max);
  });

  it('evicts strictly in least-recently-released order', async () => {
    const { pool, disposed } = makePool({ max: 3 });

    (await pool.acquire('a')).release();
    (await pool.acquire('b')).release();
    (await pool.acquire('c')).release(); // live {a,b,c}; a is LRU

    // Re-touch a → b becomes the least-recently-released.
    (await pool.acquire('a')).release();

    (await pool.acquire('d')).release(); // evicts b
    expect(disposed).toEqual(['b']);

    (await pool.acquire('e')).release(); // evicts the next LRU, c
    expect(disposed).toEqual(['b', 'c']);

    expect(pool.getStats().keys).toBe(3); // live {a,d,e}
  });
});
