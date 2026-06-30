import { describe, expect, it } from 'vitest';
import { makePool } from './test-utils.js';

describe('LRU eviction', () => {
  it('evicts the least-recently-released idle key first', async () => {
    const { pool, disposed } = makePool({ max: 2 });

    (await pool.acquire('a')).release();
    (await pool.acquire('b')).release();
    // pool holds {a, b}; a was released first → LRU
    (await pool.acquire('c')).release();

    expect(disposed).toEqual(['a']);
    expect(pool.getStats().keys).toBe(2);

    // touching b keeps it; adding d should evict c (now the LRU)
    (await pool.acquire('b')).release();
    (await pool.acquire('d')).release();
    expect(disposed).toEqual(['a', 'c']);
  });
});
