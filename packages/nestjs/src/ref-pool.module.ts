import { Inject, Module } from '@nestjs/common';
import type {
  DynamicModule,
  MiddlewareConsumer,
  NestModule,
  Provider,
} from '@nestjs/common';
import { ConnectionHealthController } from './health.controller.js';
import { RefPoolService } from './ref-pool.service.js';
import { TenantConnectionMiddleware } from './tenant-connection.middleware.js';
import { REFPOOL_MIDDLEWARE_OPTIONS, REFPOOL_OPTIONS } from './tokens.js';
import type {
  RefPoolModuleAsyncOptions,
  RefPoolModuleOptions,
  TenantMiddlewareOptions,
} from './interfaces.js';

const SHARED = [RefPoolService, TenantConnectionMiddleware];
const EXPORTS = [
  RefPoolService,
  TenantConnectionMiddleware,
  REFPOOL_OPTIONS,
  REFPOOL_MIDDLEWARE_OPTIONS,
];

@Module({})
export class RefPoolModule implements NestModule {
  constructor(
    @Inject(REFPOOL_OPTIONS) private readonly options: RefPoolModuleOptions,
  ) {}

  /**
   * Auto-wires {@link TenantConnectionMiddleware} when the drop-in multi-tenant
   * path is opted into via `applyMiddleware` or `middleware.routes`. Defaults to
   * `'*'` (all routes) when enabled without explicit routes.
   */
  configure(consumer: MiddlewareConsumer): void {
    const routes = this.options.middleware?.routes;
    const shouldApply = this.options.applyMiddleware ?? routes !== undefined;
    if (!shouldApply) return;
    const forRoutes = routes === undefined ? ['*'] : Array.isArray(routes) ? routes : [routes];
    consumer.apply(TenantConnectionMiddleware).forRoutes(...forRoutes);
  }

  static forRoot<T = unknown>(options: RefPoolModuleOptions<T>): DynamicModule {
    const providers: Provider[] = [
      { provide: REFPOOL_OPTIONS, useValue: options },
      { provide: REFPOOL_MIDDLEWARE_OPTIONS, useValue: options.middleware ?? {} },
      ...SHARED,
    ];
    return {
      module: RefPoolModule,
      global: options.isGlobal ?? false,
      providers,
      controllers: [ConnectionHealthController],
      exports: EXPORTS,
    };
  }

  static forRootAsync<T = unknown>(options: RefPoolModuleAsyncOptions<T>): DynamicModule {
    const optionsProvider: Provider = {
      provide: REFPOOL_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };
    const middlewareOptionsProvider: Provider = {
      provide: REFPOOL_MIDDLEWARE_OPTIONS,
      useFactory: (resolved: RefPoolModuleOptions<T>): TenantMiddlewareOptions =>
        resolved.middleware ?? {},
      inject: [REFPOOL_OPTIONS],
    };
    return {
      module: RefPoolModule,
      global: options.isGlobal ?? false,
      imports: options.imports ?? [],
      providers: [optionsProvider, middlewareOptionsProvider, ...SHARED],
      controllers: [ConnectionHealthController],
      exports: EXPORTS,
    };
  }
}
