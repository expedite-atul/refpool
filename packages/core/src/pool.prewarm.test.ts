import { describe, expect, it } from 'vitest';
import { makePool } from './test-utils.js';

describe('prewarm', () => {
  it('creates resources for the configured keys and leaves them idle', async () => {
    const { pool, created } = makePool({
      max: 10,
      prewarm: { keys: ['a', 'b', 'c'] },
    });

    await pool.warm();

    expect(created.sort()).toEqual(['a', 'b', 'c']);
    const stats = pool.getStats();
    expect(stats.live).toBe(3);
    expect(stats.idle).toBe(3);
    expect(stats.inUse).toBe(0);
  });

  it('honors a lazy key function and explicit strategy argument', async () => {
    const { pool, created } = makePool({ max: 10 });

    await pool.warm({ keys: () => Promise.resolve(['x', 'y']), perKey: 2 });

    expect(created.sort()).toEqual(['x', 'y']);
    expect(pool.getStats().idle).toBe(2);
  });
});
