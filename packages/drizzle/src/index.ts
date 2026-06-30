import { RefCountedLruPool } from '@refpool/core';
import type { AcquireHandle, PoolOptions } from '@refpool/core';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** Options for a per-key Drizzle (node-postgres) database pool. */
export type DrizzlePoolOptions<TSchema extends Record<string, unknown>> = Omit<
  PoolOptions<NodePgDatabase<TSchema>>,
  'factory' | 'dispose'
> & {
  /** Build the node-postgres `PoolConfig` for a tenant key. */
  config: (key: string) => PoolConfig | Promise<PoolConfig>;
  /** Optional Drizzle schema bound to every db instance. */
  schema?: TSchema;
};

/**
 * Create a reference-counted, bounded LRU pool of Drizzle database instances
 * keyed by tenant. Each db wraps a dedicated node-postgres `Pool`; dispose
 * `.end()`s that underlying pool on eviction/drain.
 */
export function createDrizzlePool<TSchema extends Record<string, unknown> = Record<string, never>>(
  options: DrizzlePoolOptions<TSchema>,
): RefCountedLruPool<NodePgDatabase<TSchema>> {
  const { config, schema, ...rest } = options;
  const clients = new WeakMap<NodePgDatabase<TSchema>, Pool>();

  return new RefCountedLruPool<NodePgDatabase<TSchema>>({
    ...rest,
    factory: async (key) => {
      const client = new Pool(await config(key));
      const db = (
        schema ? drizzle(client, { schema }) : drizzle(client)
      ) as NodePgDatabase<TSchema>;
      clients.set(db, client);
      return db;
    },
    dispose: async (db) => {
      const client = clients.get(db);
      clients.delete(db);
      await client?.end();
    },
  });
}

/** Acquire `key`, run `fn`, and release the holder in `finally`. */
export async function withResource<TSchema extends Record<string, unknown>, R>(
  pool: RefCountedLruPool<NodePgDatabase<TSchema>>,
  key: string,
  fn: (db: NodePgDatabase<TSchema>) => Promise<R> | R,
): Promise<R> {
  const handle: AcquireHandle<NodePgDatabase<TSchema>> = await pool.acquire(key);
  try {
    return await fn(handle.resource);
  } finally {
    handle.release();
  }
}
