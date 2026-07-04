# @refpool/nestjs

NestJS integration for [`@refpool/core`](../core): a dynamic module, an injectable
service with lifecycle hooks, multi-tenant connection middleware, and a
connection-health controller.

## Install

```bash
npm install @refpool/nestjs @refpool/core
```

Peer dependencies (required): `@nestjs/common`, `@nestjs/core`,
`reflect-metadata`, `rxjs`.

## Module wiring

`RefPoolModule.forRoot` takes the same [`PoolOptions`](../core#pooloptionst) as the
core pool, plus a few module-level flags (`isGlobal`, `warmOnInit`, `middleware`).

```ts
import { Module } from '@nestjs/common';
import { RefPoolModule } from '@refpool/nestjs';
import { Pool } from 'pg';

@Module({
  imports: [
    RefPoolModule.forRoot<Pool>({
      isGlobal: true,
      max: 20,
      idleTtlMs: 60_000,
      factory: async (tenantId) =>
        new Pool({ connectionString: `postgres://localhost:5432/tenant_${tenantId}` }),
      dispose: async (pool) => pool.end(),
      middleware: { header: 'x-tenant-id', onMissing: 'error' },
    }),
  ],
})
export class AppModule {}
```

Async configuration (inject config/other providers):

```ts
RefPoolModule.forRootAsync<Pool>({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    max: config.get('REFPOOL_MAX', 20),
    factory: async (tenantId) => new Pool({ connectionString: config.urlFor(tenantId) }),
    dispose: async (pool) => pool.end(),
  }),
});
```

`RefPoolService` starts the pool on `OnModuleInit` (and runs `warm()` when
`prewarm` is set or `warmOnInit: true`) and drains it on `OnApplicationShutdown`.
Enable shutdown hooks in `main.ts` with `app.enableShutdownHooks()`.

## RefPoolService

Inject it anywhere to use the pool:

```ts
import { Injectable } from '@nestjs/common';
import { RefPoolService } from '@refpool/nestjs';
import type { Pool } from 'pg';

@Injectable()
export class ReportService {
  constructor(private readonly refpool: RefPoolService<Pool>) {}

  run(tenantId: string) {
    // acquire → run → release (released even on throw)
    return this.refpool.withResource(tenantId, (pool) => pool.query('select now()'));
  }

  stats() {
    return this.refpool.getStats();
  }
}
```

`RefPoolService<T>` exposes `acquire(key)`, `withResource(key, fn)`, `getStats()`,
and the underlying `.pool` (for event subscription, etc.).

## Tenant middleware

`TenantConnectionMiddleware` reads the tenant key from a request header
(default `x-tenant-id`), acquires that tenant's resource for the lifetime of the
request, and releases it when the response finishes/closes. The resource is
attached to the request (default property `tenantResource`, plus
`tenantResourceKey`).

### Drop-in (auto-applied)

`RefPoolModule` implements `NestModule` and wires the middleware for you when you
opt in via `applyMiddleware: true` or `middleware.routes`. No `configure()` in
your `AppModule` required:

```ts
@Module({
  imports: [
    RefPoolModule.forRoot<Pool>({
      max: 20,
      factory: async (tenantId) => new Pool({ /* ... */ }),
      // Opt in to auto-wiring. Either flag works:
      applyMiddleware: true,                       // applies to '*' (all routes)
      middleware: {
        header: 'x-tenant-id',
        onMissing: 'error',
        routes: ['tenant/*'],                      // or scope to specific routes
      },
    }),
  ],
})
export class AppModule {}
```

`applyMiddleware` defaults to `true` when `middleware.routes` is set, otherwise
`false`. When enabled without explicit `routes`, the middleware is applied to
`'*'`.

### Manual wiring

You can still apply it yourself for full control over the route configuration:

```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TenantConnectionMiddleware } from '@refpool/nestjs';

@Module({ /* imports: [RefPoolModule.forRoot(...)] */ })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantConnectionMiddleware).forRoutes('tenant/*');
  }
}
```

Middleware options (set via `forRoot({ middleware })`): `header`,
`onMissing` (`'next' | 'error'`), `requestProperty`, `routes`. Plus the
module-level `applyMiddleware` flag.

## Health route

`RefPoolModule` automatically mounts `ConnectionHealthController`, exposing:

```
GET /health/connections   →   PoolStats (live, idle, inUse, waiters, hits, …)
```

## Exports

`RefPoolModule`, `RefPoolService`, `TenantConnectionMiddleware`,
`ConnectionHealthController`, the DI tokens `REFPOOL_OPTIONS` /
`REFPOOL_MIDDLEWARE_OPTIONS`, and the option types.

## License

MIT © Atul Singh
