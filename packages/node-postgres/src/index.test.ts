import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { instances, FakePool } = vi.hoisted(() => {
  class FakePool {
    readonly options: unknown;
    end = vi.fn(async () => undefined);
    query = vi.fn(async () => ({ rows: [] }));
    constructor(options: unknown) {
      this.options = options;
      instances.push(this);
    }
  }
  const instances: FakePool[] = [];
  return { instances, FakePool };
});

vi.mock('pg', () => ({ Pool: FakePool }));

import { createPgPool, withResource } from './index.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  instances.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createPgPool', () => {
  it('wires the factory: builds one Pool per key from config', async () => {
    const config = vi.fn((key: string) => ({ database: key }));
    const pool = createPgPool({ config, max: 4 });

    const handle = await pool.acquire('tenant-a');

    expect(config).toHaveBeenCalledWith('tenant-a');
    expect(instances).toHaveLength(1);
    expect((instances[0]?.options as { database: string }).database).toBe('tenant-a');
    expect(handle.resource).toBe(instances[0]);

    handle.release();
    await pool.drain();
  });

  it('reuses one Pool for repeated keys', async () => {
    const pool = createPgPool({ config: () => ({}), max: 4 });
    const a = await pool.acquire('t1');
    const b = await pool.acquire('t1');
    expect(instances).toHaveLength(1);
    a.release();
    b.release();
    await pool.drain();
  });

  it('disposes (end) on eviction beyond max', async () => {
    const pool = createPgPool({ config: () => ({}), max: 1 });
    const a = await pool.acquire('t1');
    a.release();
    const b = await pool.acquire('t2');
    b.release();
    await tick();

    expect(instances[0]?.end).toHaveBeenCalledTimes(1);
    expect(pool.getStats().live).toBeLessThanOrEqual(1);
    await pool.drain();
  });

  it('disposes every Pool on drain', async () => {
    const pool = createPgPool({ config: () => ({}), max: 4 });
    const a = await pool.acquire('t1');
    a.release();
    await pool.drain();
    expect(instances[0]?.end).toHaveBeenCalledTimes(1);
    expect(pool.getStats().live).toBe(0);
  });
});

describe('withResource', () => {
  it('releases after a successful callback', async () => {
    const pool = createPgPool({ config: () => ({}), max: 4 });
    const result = await withResource(pool, 't1', (p) => {
      expect(p).toBe(instances[0]);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(pool.getStats().inUse).toBe(0);
    await pool.drain();
  });

  it('releases even when the callback throws', async () => {
    const pool = createPgPool({ config: () => ({}), max: 4 });
    await expect(
      withResource(pool, 't1', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(pool.getStats().inUse).toBe(0);
    await pool.drain();
  });

  it('bounds live Pools to max under sequential tenants', async () => {
    const pool = createPgPool({ config: () => ({}), max: 2 });
    for (const key of ['t1', 't2', 't3', 't4', 't5']) {
      await withResource(pool, key, () => undefined);
      expect(pool.getStats().live).toBeLessThanOrEqual(2);
    }
    expect(instances.length).toBe(5);
    await pool.drain();
    expect(instances.filter((i) => i.end.mock.calls.length > 0).length).toBe(5);
  });
});
