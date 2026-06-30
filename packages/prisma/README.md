# @refpool/prisma

Multi-tenant **`PrismaClient` pooling** built on [`@refpool/core`](../core)'s
reference-counted, bounded LRU pool.

A pool of `PrismaClient` instances keyed by tenant — useful for per-tenant
database URLs — bounded at `max`, shared between concurrent requests for the same
tenant, with idle clients `$disconnect`ed automatically.

## Install

```bash
npm install @refpool/prisma @prisma/client
```

`@prisma/client` is an **optional** peer dependency (`>=5.0.0`). The adapter
types against a minimal `{ $connect, $disconnect }` shape, so it works with any
generated client without a hard build-time dependency.

## Usage

```ts
import { createPrismaPool, withResource } from '@refpool/prisma';
import { PrismaClient } from '@prisma/client';

const pool = createPrismaPool({
  max: 20,
  idleTtlMs: 60_000,
  client: (tenantId) =>
    new PrismaClient({
      datasources: { db: { url: `postgres://localhost:5432/tenant_${tenantId}` } },
    }),
});
pool.start();

const users = await withResource(pool, tenantId, (prisma) => prisma.user.findMany());

await pool.stop(); // on shutdown: disconnects every live client
```

The factory calls your `client(key)` then `$connect`s it; `dispose` `$disconnect`s
it on eviction/drain. All other [`PoolOptions`](../core#pooloptionst) pass through.

## API

- `createPrismaPool<TClient>(options)` → `RefCountedLruPool<TClient>` —
  `options` is `PoolOptions` minus `factory`/`dispose`, plus
  `client: (key) => TClient | Promise<TClient>` (a *not-yet-connected* client).
- `withResource(pool, key, fn)` — acquire `key`, run `fn(client)`, release in `finally`.

## License

MIT © Atul Singh
