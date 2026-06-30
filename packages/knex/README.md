# @refpool/knex

Multi-tenant **Knex instance pooling** built on [`@refpool/core`](../core)'s
reference-counted, bounded LRU pool.

A pool of Knex instances keyed by tenant — bounded at `max`, shared between
concurrent requests for the same tenant, with idle instances `.destroy()`ed
automatically.

## Install

```bash
npm install @refpool/knex knex
```

`knex` is an **optional** peer dependency (`^3.0.0`).

## Usage

```ts
import { createKnexPool, withResource } from '@refpool/knex';

const pool = createKnexPool({
  max: 20,
  idleTtlMs: 60_000,
  config: (tenantId) => ({
    client: 'pg',
    connection: `postgres://localhost:5432/tenant_${tenantId}`,
    pool: { min: 0, max: 5 }, // inner Knex pool, per tenant
  }),
});
pool.start();

const users = await withResource(pool, tenantId, (db) => db('users').select('*'));

await pool.stop(); // on shutdown: destroys every live Knex instance
```

The factory builds a Knex instance from `config(key)`; `dispose` calls
`.destroy()` on eviction/drain. All other [`PoolOptions`](../core#pooloptionst)
pass through.

## API

- `createKnexPool(options)` → `RefCountedLruPool<Knex>` —
  `options` is `PoolOptions` minus `factory`/`dispose`, plus
  `config: (key) => Knex.Config | Promise<Knex.Config>`.
- `withResource(pool, key, fn)` — acquire `key`, run `fn(knex)`, release in `finally`.

## License

MIT © Atul Singh
