import { RefCountedLruPool } from './pool.js';
import type { PoolOptions } from './types.js';

export interface TestResource {
  key: string;
  id: number;
}

export interface Harness {
  pool: RefCountedLruPool<TestResource>;
  created: string[];
  disposed: string[];
  factoryCalls: () => number;
}

/**
 * Builds a pool over a trivial in-memory resource, recording every factory and
 * dispose invocation so tests can assert create/dispose-once semantics.
 */
export function makePool(overrides: Partial<PoolOptions<TestResource>> = {}): Harness {
  const created: string[] = [];
  const disposed: string[] = [];
  let counter = 0;

  const pool = new RefCountedLruPool<TestResource>({
    max: 100,
    factory: async (key) => {
      created.push(key);
      counter += 1;
      return { key, id: counter };
    },
    dispose: (_resource, key) => {
      disposed.push(key);
    },
    ...overrides,
  });

  return {
    pool,
    created,
    disposed,
    factoryCalls: () => created.length,
  };
}
