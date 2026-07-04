import { describe, expect, it } from 'vitest';
import { InMemoryCircuitBreaker } from './breakers.js';
import { RefCountedLruPool } from './pool.js';
import { makePool } from './test-utils.js';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('per-key state maps stay bounded without mutexGcMs', () => {
  it('drops mutex cells once each key settles', async () => {
    const { pool } = makePool({ max: 100 }); // no mutexGcMs configured

    for (let i = 0; i < 100; i += 1) {
      (await pool.acquire(`k${i}`)).release();
    }
    await flush();

    const internals = pool as unknown as { mutexes: Map<string, unknown> };
    expect(internals.mutexes.size).toBe(0);
  });

  it('drops closed per-key breakers as their keys churn away', async () => {
    let created = 0;
    const pool = new RefCountedLruPool<string>({
      max: 1, // each new key evicts the previous one
      breaker: () => {
        created += 1;
        return new InMemoryCircuitBreaker();
      },
      factory: async (key) => key,
      dispose: () => {},
    });

    (await pool.acquire('a')).release();
    (await pool.acquire('b')).release(); // evicts + disposes 'a' → drops breaker 'a'
    (await pool.acquire('c')).release(); // evicts + disposes 'b' → drops breaker 'b'
    await flush();

    const internals = pool as unknown as { breakers: Map<string, unknown> };
    expect(internals.breakers.size).toBe(1); // only the surviving live key retains a breaker
    expect(created).toBe(3);
  });
});
