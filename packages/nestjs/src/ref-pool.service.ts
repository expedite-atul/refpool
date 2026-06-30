import { Inject, Injectable } from '@nestjs/common';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { RefCountedLruPool } from '@refpool/core';
import type { AcquireHandle, PoolStats } from '@refpool/core';
import { REFPOOL_OPTIONS } from './tokens.js';
import type { RefPoolModuleOptions } from './interfaces.js';

@Injectable()
export class RefPoolService<T = unknown> implements OnModuleInit, OnApplicationShutdown {
  /** The underlying pool. Exposed for advanced use (event subscription, etc.). */
  readonly pool: RefCountedLruPool<T>;

  constructor(@Inject(REFPOOL_OPTIONS) private readonly options: RefPoolModuleOptions<T>) {
    this.pool = new RefCountedLruPool<T>(options);
  }

  async onModuleInit(): Promise<void> {
    this.pool.start();
    const shouldWarm = this.options.warmOnInit ?? Boolean(this.options.prewarm);
    if (shouldWarm) {
      await this.pool.warm();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.stop();
  }

  acquire(key: string): Promise<AcquireHandle<T>> {
    return this.pool.acquire(key);
  }

  /** Acquire a resource for `key`, run `fn`, and release the handle regardless of outcome. */
  async withResource<R>(key: string, fn: (resource: T) => R | Promise<R>): Promise<R> {
    const handle = await this.pool.acquire(key);
    try {
      return await fn(handle.resource);
    } finally {
      handle.release();
    }
  }

  getStats(): PoolStats {
    return this.pool.getStats();
  }
}
