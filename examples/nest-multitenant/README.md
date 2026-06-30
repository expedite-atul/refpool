# @refpool/example-nest-multitenant

A runnable [NestJS](https://nestjs.com) app that pools **one Postgres connection
pool per tenant** using [`@refpool/nestjs`](../../packages/nestjs) +
[`@refpool/pg`](../../packages/node-postgres) on top of
[`@refpool/core`](../../packages/core).

## What it demonstrates

- `RefPoolModule.forRootAsync<Pool>(...)` wired with a **createPgPool-style
  factory**: `config(tenantKey)` maps a tenant id → `pg.PoolConfig` built from a
  `DATABASE_URL_TEMPLATE`. Each distinct tenant lazily gets its own `pg.Pool`.
- The whole set of per-tenant pools is **bounded** (`max`), **reference-counted**,
  and idle tenants are reclaimed (`idleTtlMs`) — you never accumulate one live
  pool per tenant forever.
- `TenantConnectionMiddleware` keyed off the `x-tenant-id` header acquires the
  tenant's pool for the request and releases it when the response finishes.
- `ConnectionHealthController` exposes `GET /health/connections` (mounted
  automatically by `RefPoolModule`).
- Graceful shutdown drains every pool (`pool.end()`) via `onApplicationShutdown`.

## Routes

| Method & path             | Notes                                                        |
| ------------------------- | ----------------------------------------------------------- |
| `GET /tenant/now`         | Uses the per-request resource attached by the middleware.   |
| `GET /tenant/report`      | Uses the `@refpool/pg` `withResource()` helper explicitly.  |
| `GET /tenant/stats`       | Live pool stats (`RefPoolService.getStats()`).              |
| `GET /health/connections` | Built-in health controller from `@refpool/nestjs`.          |

All `/tenant/*` routes require an `x-tenant-id` header (`onMissing: 'error'`).

## Environment variables

| Var                        | Default                                                     | Meaning                                   |
| -------------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| `DATABASE_URL_TEMPLATE`    | `postgres://postgres:postgres@localhost:5432/tenant_{tenant}` | `{tenant}` is replaced with the tenant id |
| `PG_POOL_MAX`              | `5`                                                        | Inner node-postgres pool size per tenant  |
| `REFPOOL_MAX`              | `10`                                                       | Max live tenant pools held by refpool     |
| `REFPOOL_IDLE_TTL_MS`      | `30000`                                                    | Reclaim a tenant pool idle this long      |
| `PORT`                     | `3000`                                                     | HTTP port                                 |

## Run it

> **A reachable Postgres is required at runtime.** This example connects lazily
> per tenant, so it builds and boots without a DB, but `GET /tenant/*` calls will
> fail until `DATABASE_URL_TEMPLATE` points at a live server with the tenant
> databases. The example is verified to **typecheck and build** in CI; running
> against a live DB is optional.

```bash
# from the repo root
pnpm install

# build (tsc) and run the compiled output
pnpm --filter @refpool/example-nest-multitenant build
pnpm --filter @refpool/example-nest-multitenant start

# or run straight from TS during development
pnpm --filter @refpool/example-nest-multitenant dev
```

Then:

```bash
curl -H 'x-tenant-id: acme'  http://localhost:3000/tenant/now
curl -H 'x-tenant-id: globex' http://localhost:3000/tenant/report
curl http://localhost:3000/tenant/stats
curl http://localhost:3000/health/connections
```
