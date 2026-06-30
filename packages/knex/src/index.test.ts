import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { instances, knexMock } = vi.hoisted(() => {
  const instances: Array<{ config: unknown; destroy: ReturnType<typeof vi.fn> }> = [];
  const knexMock = vi.fn((config: unknown) => {
    const instance = { config, destroy: vi.fn(async () => undefined) };
    instances.push(instance);
    return instance;
  });
  return { instances, knexMock };
});

vi.mock('knex', () => ({ knex: knexMock }));

import { createKnexPool, withResource } from './index.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  instances.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createKnexPool', () => {
  it('wires the factory: builds one Knex instance per key from config', async () => {
    const config = vi.fn((key: string) => ({ client: 'pg', connection: { database: key } }));
    const pool = createKnexPool({ config, max: 4 });

    const handle = await pool.acquire('tenant-a');

    expect(config).toHaveBeenCalledWith('tenant-a');
    expect(instances).toHaveLength(1);
    expect(handle.resource).toBe(instances[0]);

    handle.release();
    await pool.drain();
  });

  it('destroys on eviction beyond max', async () => {
    const pool = createKnexPool({ config: () => ({ client: 'pg' }), max: 1 });
    const a = await pool.acquire('t1');
    a.release();
    const b = await pool.acquire('t2');
    b.release();
    await tick();

    expect(instances[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(pool.getStats().live).toBeLessThanOrEqual(1);
    await pool.drain();
  });

  it('destroys every instance on drain', async () => {
    const pool = createKnexPool({ config: () => ({ client: 'pg' }), max: 4 });
    const a = await pool.acquire('t1');
    a.release();
    await pool.drain();
    expect(instances[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(pool.getStats().live).toBe(0);
  });
});

describe('withResource', () => {
  it('releases after a successful callback', async () => {
    const pool = createKnexPool({ config: () => ({ client: 'pg' }), max: 4 });
    const result = await withResource(pool, 't1', (k) => {
      expect(k).toBe(instances[0]);
      return 99;
    });
    expect(result).toBe(99);
    expect(pool.getStats().inUse).toBe(0);
    await pool.drain();
  });

  it('releases even when the callback throws', async () => {
    const pool = createKnexPool({ config: () => ({ client: 'pg' }), max: 4 });
    await expect(
      withResource(pool, 't1', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(pool.getStats().inUse).toBe(0);
    await pool.drain();
  });

  it('bounds live instances to max under sequential tenants', async () => {
    const pool = createKnexPool({ config: () => ({ client: 'pg' }), max: 2 });
    for (const key of ['t1', 't2', 't3', 't4', 't5']) {
      await withResource(pool, key, () => undefined);
      expect(pool.getStats().live).toBeLessThanOrEqual(2);
    }
    expect(instances.length).toBe(5);
    await pool.drain();
    expect(instances.filter((i) => i.destroy.mock.calls.length > 0).length).toBe(5);
  });
});
