# @refpool/drizzle

Multi-tenant **Drizzle (node-postgres) database pooling** built on
[`@refpool/core`](../core)'s reference-counted, bounded LRU pool.

Each pooled Drizzle `db` wraps its own dedicated `pg.Pool`. You get at most `max`
live database instances, shared between concurrent requests for the same tenant,
with idle ones reclaimed and their underlying pools `.end()`ed automatically.

## Install

```bash
npm install @refpool/drizzle drizzle-orm pg
```

`drizzle-orm` and `pg` are **required** peer dependencies — this package
statically imports both, so you must install them alongside `@refpool/drizzle`.

## Usage

```ts
import { createDrizzlePool, withResource } from '@refpool/drizzle';
import * as schema from './schema';

const pool = createDrizzlePool({
  max: 20,
  idleTtlMs: 60_000,
  schema, // optional — binds the schema to every db instance
  config: (tenantId) => ({
    connectionString: `postgres://localhost:5432/tenant_${tenantId}`,
  }),
});
pool.start();

const users = await withResource(pool, tenantId, (db) =>
  db.select().from(schema.users),
);

await pool.stop(); // on shutdown: ends every underlying pg.Pool
```

The factory builds a `pg.Pool` from `config(key)` and wraps it with `drizzle()`
(binding `schema` when provided); `dispose` `.end()`s the underlying pool on
eviction/drain. All other [`PoolOptions`](../core#pooloptionst) pass through.

## API

- `createDrizzlePool<TSchema>(options)` → `RefCountedLruPool<NodePgDatabase<TSchema>>` —
  `options` is `PoolOptions` minus `factory`/`dispose`, plus
  `config: (key) => PoolConfig | Promise<PoolConfig>` and an optional `schema`.
- `withResource(pool, key, fn)` — acquire `key`, run `fn(db)`, release in `finally`.

## License

MIT © Atul Singh
