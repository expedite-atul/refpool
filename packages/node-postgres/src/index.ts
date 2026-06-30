import { RefCountedLruPool } from '@refpool/core';
import type { AcquireHandle, PoolOptions } from '@refpool/core';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

/** Options for a per-key node-postgres `Pool` pool. */
export type PgPoolOptions = Omit<PoolOptions<Pool>, 'factory' | 'dispose'> & {
  /** Build the node-postgres `PoolConfig` for a tenant key. */
  config: (key: string) => PoolConfig | Promise<PoolConfig>;
};

/**
 * Create a reference-counted, bounded LRU pool of node-postgres `Pool`
 * instances keyed by tenant. The factory builds a `Pool`; dispose `.end()`s
 * it on eviction/drain.
 */
export function createPgPool(options: PgPoolOptions): RefCountedLruPool<Pool> {
  const { config, ...rest } = options;
  return new RefCountedLruPool<Pool>({
    ...rest,
    factory: async (key) => new Pool(await config(key)),
    dispose: async (pool) => {
      await pool.end();
    },
  });
}

/** Acquire `key`, run `fn`, and release the holder in `finally`. */
export async function withResource<R>(
  pool: RefCountedLruPool<Pool>,
  key: string,
  fn: (pgPool: Pool) => Promise<R> | R,
): Promise<R> {
  const handle: AcquireHandle<Pool> = await pool.acquire(key);
  try {
    return await fn(handle.resource);
  } finally {
    handle.release();
  }
}
