# @refpool/pg

Multi-tenant **node-postgres (`pg`) `Pool` pooling** built on
[`@refpool/core`](../core)'s reference-counted, bounded LRU pool.

A pool of `pg.Pool` instances keyed by tenant: at most `max` live pools, shared
between concurrent requests for the same tenant, with idle ones reclaimed and
`.end()`ed automatically — so you never accumulate one live connection pool per
tenant forever.

## Install

```bash
npm install @refpool/pg pg
```

`pg` (`^8.0.0`) is a **required** peer dependency — this package statically
imports it, so you must install `pg` alongside `@refpool/pg`.

## Usage

```ts
import { createPgPool, withResource } from '@refpool/pg';

const pool = createPgPool({
  max: 25,
  idleTtlMs: 60_000,
  config: (tenantId) => ({
    connectionString: `postgres://localhost:5432/tenant_${tenantId}`,
    max: 5, // inner node-postgres pool size, per tenant
  }),
});
pool.start();

const { rows } = await withResource(pool, tenantId, (pg) =>
  pg.query('select now()'),
);

await pool.stop(); // on shutdown: ends every live pg.Pool
```

The factory builds a `pg.Pool` from `config(key)`; `dispose` calls `.end()` on
eviction/drain. All other [`PoolOptions`](../core#pooloptionst) pass through.

## API

- `createPgPool(options)` → `RefCountedLruPool<Pool>` —
  `options` is `PoolOptions` minus `factory`/`dispose`, plus
  `config: (key) => PoolConfig | Promise<PoolConfig>`.
- `withResource(pool, key, fn)` — acquire `key`, run `fn(pgPool)`, release in `finally`.

## License

MIT © Atul Singh
