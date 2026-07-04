import { RefCountedLruPool } from '@refpool/core';
import type { AcquireHandle, PoolOptions } from '@refpool/core';

/**
 * Minimal structural shape of a `PrismaClient`. Adapting against this avoids a
 * hard dependency on a generated client at build time.
 */
export interface PrismaClientLike {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
}

/** Options for a per-key `PrismaClient` pool. */
export type PrismaPoolOptions<TClient extends PrismaClientLike> = Omit<
  PoolOptions<TClient>,
  'factory' | 'dispose'
> & {
  /** Construct a (not-yet-connected) PrismaClient for a tenant key. */
  client: (key: string) => TClient | Promise<TClient>;
};

/**
 * Create a reference-counted, bounded LRU pool of `PrismaClient` instances
 * keyed by tenant. The factory `$connect`s a client; dispose `$disconnect`s it
 * on eviction/drain.
 */
export function createPrismaPool<TClient extends PrismaClientLike>(
  options: PrismaPoolOptions<TClient>,
): RefCountedLruPool<TClient> {
  const { client, ...rest } = options;
  return new RefCountedLruPool<TClient>({
    ...rest,
    factory: async (key) => {
      const instance = await client(key);
      try {
        await instance.$connect();
      } catch (error) {
        await instance.$disconnect().catch(() => {});
        throw error;
      }
      return instance;
    },
    dispose: async (instance) => {
      await instance.$disconnect();
    },
  });
}

/** Acquire `key`, run `fn`, and release the holder in `finally`. */
export async function withResource<TClient extends PrismaClientLike, R>(
  pool: RefCountedLruPool<TClient>,
  key: string,
  fn: (client: TClient) => Promise<R> | R,
): Promise<R> {
  const handle: AcquireHandle<TClient> = await pool.acquire(key);
  try {
    return await fn(handle.resource);
  } finally {
    handle.release();
  }
}
