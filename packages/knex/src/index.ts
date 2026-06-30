import { RefCountedLruPool } from '@refpool/core';
import type { AcquireHandle, PoolOptions } from '@refpool/core';
import { knex } from 'knex';
import type { Knex } from 'knex';

/** Options for a per-key Knex instance pool. */
export type KnexPoolOptions = Omit<PoolOptions<Knex>, 'factory' | 'dispose'> & {
  /** Build the Knex config for a tenant key. */
  config: (key: string) => Knex.Config | Promise<Knex.Config>;
};

/**
 * Create a reference-counted, bounded LRU pool of Knex instances keyed by
 * tenant. The factory builds a Knex instance; dispose `.destroy()`s it on
 * eviction/drain.
 */
export function createKnexPool(options: KnexPoolOptions): RefCountedLruPool<Knex> {
  const { config, ...rest } = options;
  return new RefCountedLruPool<Knex>({
    ...rest,
    factory: async (key) => knex(await config(key)),
    dispose: async (instance) => {
      await instance.destroy();
    },
  });
}

/** Acquire `key`, run `fn`, and release the holder in `finally`. */
export async function withResource<R>(
  pool: RefCountedLruPool<Knex>,
  key: string,
  fn: (instance: Knex) => Promise<R> | R,
): Promise<R> {
  const handle: AcquireHandle<Knex> = await pool.acquire(key);
  try {
    return await fn(handle.resource);
  } finally {
    handle.release();
  }
}
