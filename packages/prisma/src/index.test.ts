import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaPool, withResource } from './index.js';
import type { PrismaClientLike } from './index.js';

class FakePrismaClient implements PrismaClientLike {
  $connect = vi.fn(async () => undefined);
  $disconnect = vi.fn(async () => undefined);
  constructor(readonly key: string) {}
}

let instances: FakePrismaClient[] = [];
const makeClient = (key: string): FakePrismaClient => {
  const instance = new FakePrismaClient(key);
  instances.push(instance);
  return instance;
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  instances = [];
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createPrismaPool', () => {
  it('wires the factory: builds + $connects a client per key', async () => {
    const client = vi.fn((key: string) => makeClient(key));
    const pool = createPrismaPool({ client, max: 4 });

    const handle = await pool.acquire('tenant-a');

    expect(client).toHaveBeenCalledWith('tenant-a');
    expect(instances).toHaveLength(1);
    expect(instances[0]?.$connect).toHaveBeenCalledTimes(1);
    expect(handle.resource).toBe(instances[0]);

    handle.release();
    await pool.drain();
  });

  it('$disconnects on eviction beyond max', async () => {
    const pool = createPrismaPool({ client: makeClient, max: 1 });
    const a = await pool.acquire('t1');
    a.release();
    const b = await pool.acquire('t2');
    b.release();
    await tick();

    expect(instances[0]?.$disconnect).toHaveBeenCalledTimes(1);
    expect(pool.getStats().live).toBeLessThanOrEqual(1);
    await pool.drain();
  });

  it('$disconnects every client on drain', async () => {
    const pool = createPrismaPool({ client: makeClient, max: 4 });
    const a = await pool.acquire('t1');
    a.release();
    await pool.drain();
    expect(instances[0]?.$disconnect).toHaveBeenCalledTimes(1);
    expect(pool.getStats().live).toBe(0);
  });
});

describe('withResource', () => {
  it('releases after a successful callback', async () => {
    const pool = createPrismaPool({ client: makeClient, max: 4 });
    const result = await withResource(pool, 't1', (c) => {
      expect(c).toBe(instances[0]);
      return 1;
    });
    expect(result).toBe(1);
    expect(pool.getStats().inUse).toBe(0);
    await pool.drain();
  });

  it('releases even when the callback throws', async () => {
    const pool = createPrismaPool({ client: makeClient, max: 4 });
    await expect(
      withResource(pool, 't1', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(pool.getStats().inUse).toBe(0);
    await pool.drain();
  });

  it('bounds live clients to max under sequential tenants', async () => {
    const pool = createPrismaPool({ client: makeClient, max: 2 });
    for (const key of ['t1', 't2', 't3', 't4', 't5']) {
      await withResource(pool, key, () => undefined);
      expect(pool.getStats().live).toBeLessThanOrEqual(2);
    }
    expect(instances.length).toBe(5);
    await pool.drain();
    expect(instances.filter((i) => i.$disconnect.mock.calls.length > 0).length).toBe(5);
  });
});
