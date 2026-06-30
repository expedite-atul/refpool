import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { instances, FakeDataSource } = vi.hoisted(() => {
  class FakeDataSource {
    readonly options: unknown;
    initialize = vi.fn(async () => this);
    destroy = vi.fn(async () => undefined);
    constructor(options: unknown) {
      this.options = options;
      instances.push(this);
    }
  }
  const instances: FakeDataSource[] = [];
  return { instances, FakeDataSource };
});

vi.mock('typeorm', () => ({ DataSource: FakeDataSource }));

import { createTypeOrmPool, withResource } from './index.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  instances.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createTypeOrmPool', () => {
  it('wires the factory: builds + initializes a DataSource per key', async () => {
    const config = vi.fn((key: string) => ({ type: 'postgres', database: key }) as never);
    const pool = createTypeOrmPool({ config, max: 4 });

    const handle = await pool.acquire('tenant-a');

    expect(config).toHaveBeenCalledWith('tenant-a');
    expect(instances).toHaveLength(1);
    expect(instances[0]?.initialize).toHaveBeenCalledTimes(1);
    expect((instances[0]?.options as { database: string }).database).toBe('tenant-a');
    expect(handle.resource).toBe(instances[0]);

    handle.release();
    await pool.drain();
  });

  it('reuses one DataSource for repeated keys (factory called once)', async () => {
    const config = vi.fn(() => ({ type: 'postgres' }) as never);
    const pool = createTypeOrmPool({ config, max: 4 });

    const a = await pool.acquire('t1');
    const b = await pool.acquire('t1');

    expect(instances).toHaveLength(1);
    a.release();
    b.release();
    await pool.drain();
  });

  it('disposes (destroy) on eviction beyond max', async () => {
    const pool = createTypeOrmPool({ config: () => ({ type: 'postgres' }) as never, max: 1 });

    const a = await pool.acquire('t1');
    a.release();
    const b = await pool.acquire('t2');
    b.release();
    await tick();

    expect(instances[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(pool.getStats().live).toBeLessThanOrEqual(1);
    await pool.drain();
  });

  it('disposes every resource on drain', async () => {
    const pool = createTypeOrmPool({ config: () => ({ type: 'postgres' }) as never, max: 4 });
    const a = await pool.acquire('t1');
    a.release();
    await pool.drain();

    expect(instances[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(pool.getStats().live).toBe(0);
  });
});

describe('withResource', () => {
  it('releases after a successful callback', async () => {
    const pool = createTypeOrmPool({ config: () => ({ type: 'postgres' }) as never, max: 4 });

    const result = await withResource(pool, 't1', (ds) => {
      expect(ds).toBe(instances[0]);
      return 42;
    });

    expect(result).toBe(42);
    expect(pool.getStats().inUse).toBe(0);
    await pool.drain();
  });

  it('releases even when the callback throws', async () => {
    const pool = createTypeOrmPool({ config: () => ({ type: 'postgres' }) as never, max: 4 });

    await expect(
      withResource(pool, 't1', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(pool.getStats().inUse).toBe(0);
    await pool.drain();
  });

  it('bounds live DataSources to max under sequential tenants', async () => {
    const pool = createTypeOrmPool({ config: () => ({ type: 'postgres' }) as never, max: 2 });

    for (const key of ['t1', 't2', 't3', 't4', 't5']) {
      await withResource(pool, key, () => undefined);
      expect(pool.getStats().live).toBeLessThanOrEqual(2);
    }

    expect(instances.length).toBe(5);
    await pool.drain();
    expect(pool.getStats().live).toBe(0);
    const destroyed = instances.filter((i) => i.destroy.mock.calls.length > 0).length;
    expect(destroyed).toBe(5);
  });
});
