import { describe, expect, it } from 'vitest';
import { makePool } from './test-utils.js';

describe('shutdown drain', () => {
  it('disposes idle resources immediately and waits for in-flight holders', async () => {
    const { pool, disposed } = makePool({ max: 10 });

    (await pool.acquire('idle')).release();
    const held = await pool.acquire('held');

    const events: string[] = [];
    pool.on('drain-start', () => events.push('start'));
    pool.on('drain-complete', () => events.push('complete'));

    const draining = pool.drain();

    // idle resource gone right away; held one survives until released
    expect(disposed).toContain('idle');
    expect(disposed).not.toContain('held');

    held.release();
    await draining;

    expect(disposed.sort()).toEqual(['held', 'idle']);
    expect(pool.getStats().live).toBe(0);
    expect(events).toEqual(['start', 'complete']);
  });
});
