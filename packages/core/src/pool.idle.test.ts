import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePool } from './test-utils.js';

describe('idle TTL sweep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('disposes resources idle longer than idleTtlMs', async () => {
    const { pool, disposed } = makePool({ max: 10, idleTtlMs: 1000 });
    pool.start();

    (await pool.acquire('a')).release();
    expect(disposed).toEqual([]);
    expect(pool.getStats().idle).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);

    expect(disposed).toEqual(['a']);
    expect(pool.getStats().live).toBe(0);

    await pool.stop();
  });

  it('does not sweep resources still in use', async () => {
    const { pool, disposed } = makePool({ max: 10, idleTtlMs: 1000 });
    pool.start();

    const handle = await pool.acquire('a');
    await vi.advanceTimersByTimeAsync(5000);

    expect(disposed).toEqual([]);
    expect(pool.getStats().inUse).toBe(1);

    handle.release();
    await pool.stop();
  });
});
