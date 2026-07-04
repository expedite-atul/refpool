import { RefCountedLruPool } from '@refpool/core';
import type { AcquireHandle, PoolOptions } from '@refpool/core';
import { DataSource } from 'typeorm';
import type { DataSourceOptions } from 'typeorm';

/** Options for a per-key TypeORM `DataSource` pool. */
export type TypeOrmPoolOptions = Omit<PoolOptions<DataSource>, 'factory' | 'dispose'> & {
  /** Build the `DataSource` options for a tenant key. */
  config: (key: string) => DataSourceOptions | Promise<DataSourceOptions>;
};

/**
 * Create a reference-counted, bounded LRU pool of TypeORM `DataSource`
 * instances keyed by tenant. The factory builds and `.initialize()`s a
 * `DataSource`; dispose `.destroy()`s it on eviction/drain.
 */
export function createTypeOrmPool(options: TypeOrmPoolOptions): RefCountedLruPool<DataSource> {
  const { config, ...rest } = options;
  return new RefCountedLruPool<DataSource>({
    ...rest,
    factory: async (key) => {
      const dataSource = new DataSource(await config(key));
      try {
        await dataSource.initialize();
      } catch (error) {
        await dataSource.destroy().catch(() => {});
        throw error;
      }
      return dataSource;
    },
    dispose: async (dataSource) => {
      await dataSource.destroy();
    },
  });
}

/** Acquire `key`, run `fn`, and release the holder in `finally`. */
export async function withResource<R>(
  pool: RefCountedLruPool<DataSource>,
  key: string,
  fn: (dataSource: DataSource) => Promise<R> | R,
): Promise<R> {
  const handle: AcquireHandle<DataSource> = await pool.acquire(key);
  try {
    return await fn(handle.resource);
  } finally {
    handle.release();
  }
}
