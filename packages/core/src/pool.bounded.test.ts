import { describe, expect, it } from 'vitest';
import { makePool } from './test-utils.js';

describe('bounded under pressure', () => {
  it('never exceeds max live keyed resources', async () => {
    const max = 3;
    const { pool, created, disposed } = makePool({ max });

    for (let i = 0; i < 10; i += 1) {
      const handle = await pool.acquire(`k${i}`);
      expect(pool.getStats().live).toBeLessThanOrEqual(max);
      handle.release();
      expect(pool.getStats().live).toBeLessThanOrEqual(max);
    }

    expect(created.length).toBe(10);
    expect(disposed.length).toBe(7);
    expect(pool.getStats().live).toBe(max);
  });
});
