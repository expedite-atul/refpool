import { describe, expect, it } from 'vitest';
import { PoolClosedError } from './errors.js';
import { RefCountedLruPool } from './pool.js';
import { makePool, type TestResource } from './test-utils.js';

describe('closed state', () => {
  it('rejects acquire after stop()', async () => {
    const { pool } = makePool({ max: 2 });
    await pool.stop();
    await expect(pool.acquire('a')).rejects.toBeInstanceOf(PoolClosedError);
  });

  it('rejects acquire after drain()', async () => {
    const { pool } = makePool({ max: 2 });
    await pool.drain();
    await expect(pool.acquire('a')).rejects.toBeInstanceOf(PoolClosedError);
  });

  it('re-opens after start()', async () => {
    const { pool } = makePool({ max: 2 });
    await pool.stop();
    pool.start();
    const h = await pool.acquire('a');
    expect(h.resource.key).toBe('a');
    h.release();
    await pool.stop();
  });

  it('does not leak a key whose factory resolves after drain() begins', async () => {
    let resolveFactory: (value: TestResource) => void = () => {};
    const gate = new Promise<TestResource>((resolve) => {
      resolveFactory = resolve;
    });
    const disposed: string[] = [];

    const pool = new RefCountedLruPool<TestResource>({
      max: 5,
      factory: async (key) => (key === 'slow' ? gate : { key, id: 1 }),
      dispose: (_resource, key) => {
        disposed.push(key);
      },
    });

    const pending = pool.acquire('slow'); // enters the factory, awaiting the gate
    await new Promise((resolve) => setTimeout(resolve, 10));

    const draining = pool.drain(); // closes the pool while the create is in flight
    resolveFactory({ key: 'slow', id: 1 });

    await expect(pending).rejects.toBeInstanceOf(PoolClosedError);
    await draining;

    // The late resource was disposed, not inserted → nothing leaks past shutdown.
    expect(pool.getStats().live).toBe(0);
    expect(disposed).toContain('slow');
  });

  it('rejects parked capacity waiters when drain() begins', async () => {
    const { pool } = makePool({ max: 1, acquireTimeoutMs: 1000 });
    const h = await pool.acquire('a');

    const parked = pool.acquire('b');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pool.getStats().waiters).toBe(1);

    const draining = pool.drain();
    await expect(parked).rejects.toBeInstanceOf(PoolClosedError);

    h.release();
    await draining;
    expect(pool.getStats().live).toBe(0);
  });
});
