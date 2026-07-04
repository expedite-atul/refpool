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

  it('completes drain even when a dispose listener throws', async () => {
    const { pool, disposed } = makePool({ max: 10 });
    // A misbehaving listener must never be able to wedge shutdown.
    pool.on('dispose', () => {
      throw new Error('listener boom');
    });

    (await pool.acquire('idle')).release();
    const held = await pool.acquire('held');

    const draining = pool.drain();
    held.release();

    await expect(draining).resolves.toBeUndefined();
    expect(disposed.sort()).toEqual(['held', 'idle']);
    expect(pool.getStats().live).toBe(0);
  });
});
