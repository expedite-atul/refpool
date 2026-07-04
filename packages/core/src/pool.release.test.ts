import { describe, expect, it } from 'vitest';
import { makePool } from './test-utils.js';

describe('release(key) safety on an already-idle entry', () => {
  it('is a no-op: no double-count and no spurious release event', async () => {
    const { pool, disposed } = makePool({ max: 2 });
    const releaseRefCounts: number[] = [];
    pool.on('release', (event) => releaseRefCounts.push(event.refCount));

    const handle = await pool.acquire('a');
    handle.release(); // the real 1→0 edge
    expect(releaseRefCounts).toEqual([0]);
    expect(pool.getStats().idle).toBe(1);

    pool.release('a'); // already idle → must do nothing
    pool.release('a');
    expect(releaseRefCounts).toEqual([0]); // no extra events
    expect(pool.getStats().idle).toBe(1);
    expect(disposed).toEqual([]);
  });

  it('preserves LRU order (no re-stamp / reorder of an idle entry)', async () => {
    const { pool, disposed } = makePool({ max: 2 });

    (await pool.acquire('a')).release(); // idle list: [a]
    (await pool.acquire('b')).release(); // idle list: [a, b], a is LRU

    pool.release('a'); // no-op: must NOT move 'a' to the most-recent end

    (await pool.acquire('c')).release(); // evicts the LRU head, which is still 'a'
    expect(disposed).toEqual(['a']);
  });
});
