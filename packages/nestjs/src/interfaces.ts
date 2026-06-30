import type {
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
} from '@nestjs/common';
import type { PoolOptions } from '@refpool/core';

/** Behavior when an incoming request lacks the configured tenant header. */
export type MissingTenantBehavior = 'next' | 'error';

export interface TenantMiddlewareOptions {
  /** Request header carrying the tenant key. Default `x-tenant-id`. */
  header?: string;
  /** What to do when the header is absent. Default `next` (skip acquisition). */
  onMissing?: MissingTenantBehavior;
  /** Property on the request used to attach the acquired resource. Default `tenantResource`. */
  requestProperty?: string;
}

export interface RefPoolModuleOptions<T = unknown> extends PoolOptions<T> {
  /** Register the module globally so its exports are available app-wide. */
  isGlobal?: boolean;
  /** Run `pool.warm()` during `OnModuleInit`. Defaults to `true` when `prewarm` is set. */
  warmOnInit?: boolean;
  /** Defaults for {@link TenantConnectionMiddleware}. */
  middleware?: TenantMiddlewareOptions;
}

export interface RefPoolModuleAsyncOptions<T = unknown>
  extends Pick<ModuleMetadata, 'imports'> {
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (
    ...args: any[]
  ) => RefPoolModuleOptions<T> | Promise<RefPoolModuleOptions<T>>;
  /** Register the module globally so its exports are available app-wide. */
  isGlobal?: boolean;
}
