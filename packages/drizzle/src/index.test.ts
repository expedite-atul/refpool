import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pools, drizzleMock, FakePool } = vi.hoisted(() => {
  class FakePool {
    readonly options: unknown;
    end = vi.fn(async () => undefined);
    constructor(options: unknown) {
      this.options = options;
      pools.push(this);
    }
  }
  const pools: FakePool[] = [];
  const drizzleMock = vi.fn((client: unknown) => ({ __drizzle: true, client }));
  return { pools, drizzleMock, FakePool };
});

vi.mock('pg', () => ({ Pool: FakePool }));
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: drizzleMock }));

import { createDrizzlePool, withResource } from './index.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  pools.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createDrizzlePool', () => {
  it('wires the factory: builds a Pool, wraps it with drizzle', async () => {
    const config = vi.fn((key: string) => ({ database: key }));
    const pool = createDrizzlePool({ config, max: 4 });

    const handle = await pool.acquire('tenant-a');

    expect(config).toHaveBeenCalledWith('tenant-a');
    expect(pools).toHaveLength(1);
    expect(drizzleMock).toHaveBeenCalledWith(pools[0]);
    expect((handle.resource as unknown as { client: unknown }).client).toBe(pools[0]);

    handle.release();
    await pool.drain();
  });

  it('disposes by ending the underlying Pool on eviction beyond max', async () => {
    const pool = createDrizzlePool({ config: () => ({}), max: 1 });
    const a = await pool.acquire('t1');
    a.release();
    const b = await pool.acquire('t2');
    b.release();
    await tick();

    expect(pools[0]?.end).toHaveBeenCalledTimes(1);
    expect(pool.getStats().live).toBeLessThanOrEqual(1);
    await pool.drain();
  });

  it('ends every underlying Pool on drain', async () => {
    const pool = createDrizzlePool({ config: () => ({}), max: 4 });
    const a = await pool.acquire('t1');
    a.release();
    await pool.drain();
    expect(pools[0]?.end).toHaveBeenCalledTimes(1);
    expect(pool.getStats().live).toBe(0);
  });
});

describe('withResource', () => {
  it('releases after a successful callback', async () => {
    const pool = createDrizzlePool({ config: () => ({}), max: 4 });
    const result = await withResource(pool, 't1', (db) => {
      expect((db as unknown as { __drizzle: boolean }).__drizzle).toBe(true);
      return 7;
    });
    expect(result).toBe(7);
    expect(pool.getStats().inUse).toBe(0);
    await pool.drain();
  });

  it('releases even when the callback throws', async () => {
    const pool = createDrizzlePool({ config: () => ({}), max: 4 });
    await expect(
      withResource(pool, 't1', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(pool.getStats().inUse).toBe(0);
    await pool.drain();
  });

  it('bounds live databases to max under sequential tenants', async () => {
    const pool = createDrizzlePool({ config: () => ({}), max: 2 });
    for (const key of ['t1', 't2', 't3', 't4', 't5']) {
      await withResource(pool, key, () => undefined);
      expect(pool.getStats().live).toBeLessThanOrEqual(2);
    }
    expect(pools.length).toBe(5);
    await pool.drain();
    expect(pools.filter((p) => p.end.mock.calls.length > 0).length).toBe(5);
  });
});
