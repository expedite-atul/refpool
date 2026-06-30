import { describe, expect, it } from 'vitest';
import { makePool } from './test-utils.js';

describe('orphan resurrection', () => {
  it('hands a still-held key to the orphan pool and resurrects it on re-acquire', async () => {
    const { pool, created, disposed } = makePool({ max: 10 });

    const resurrected: string[] = [];
    pool.on('orphan-resurrect', (e) => resurrected.push(e.key));

    const first = await pool.acquire('a');

    // drain condemns the in-use key into the orphan pool; do not await yet
    const draining = pool.drain();

    // re-acquiring the orphaned key reuses the same resource (no new factory call)
    const second = await pool.acquire('a');
    expect(created).toEqual(['a']);
    expect(resurrected).toEqual(['a']);
    expect(second.resource).toBe(first.resource);

    first.release();
    expect(disposed).toEqual([]);

    second.release();
    await draining;

    // disposed exactly once when the final reference dropped
    expect(disposed).toEqual(['a']);
  });
});
