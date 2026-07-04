import { describe, expect, it } from 'vitest';
import { makePool } from './test-utils.js';

describe('stats stay exact and O(1)', () => {
  it('keeps idle + inUse === live and bounded under single-holder churn', async () => {
    const max = 3;
    const { pool } = makePool({ max });

    for (let i = 0; i < 50; i += 1) {
      const handle = await pool.acquire(`k${i % 8}`);
      let s = pool.getStats();
      expect(s.idle + s.inUse).toBe(s.live);
      expect(s.live).toBeLessThanOrEqual(max);
      expect(s.inUse).toBeGreaterThanOrEqual(1);

      handle.release();
      s = pool.getStats();
      expect(s.inUse).toBe(0);
      expect(s.idle).toBe(s.live);
      expect(s.idle + s.inUse).toBe(s.live);
      expect(s.live).toBeLessThanOrEqual(max);
    }
  });

  it('counts shared holders and idle transitions precisely', async () => {
    const { pool } = makePool({ max: 10 });

    const a1 = await pool.acquire('a');
    const a2 = await pool.acquire('a'); // shared entry, refCount 2
    const b = await pool.acquire('b');

    let s = pool.getStats();
    expect(s.keys).toBe(2);
    expect(s.inUse).toBe(2); // a and b each have holders
    expect(s.idle).toBe(0);

    a1.release(); // a still held by a2
    expect(pool.getStats().inUse).toBe(2);

    a2.release(); // a now idle
    s = pool.getStats();
    expect(s.inUse).toBe(1);
    expect(s.idle).toBe(1);

    b.release();
    s = pool.getStats();
    expect(s.inUse).toBe(0);
    expect(s.idle).toBe(2);
    expect(s.live).toBe(2);
  });
});
