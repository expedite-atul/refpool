# @refpool/typeorm

Multi-tenant **TypeORM `DataSource` pooling** built on
[`@refpool/core`](../core)'s reference-counted, bounded LRU pool.

Instead of holding one initialized `DataSource` per tenant forever, you get a
bounded pool: at most `max` live data sources, shared between concurrent requests
for the same tenant, with the coldest idle ones reclaimed automatically.

## Install

```bash
npm install @refpool/typeorm typeorm
```

`typeorm` (`^0.3.0`) is a **required** peer dependency — this package statically
imports it, so you must install `typeorm` alongside `@refpool/typeorm`.

## Usage

```ts
import { createTypeOrmPool, withResource } from '@refpool/typeorm';

const pool = createTypeOrmPool({
  max: 20,
  idleTtlMs: 60_000,
  config: (tenantId) => ({
    type: 'postgres',
    url: `postgres://localhost:5432/tenant_${tenantId}`,
    entities: [/* ... */],
  }),
});
pool.start();

// Acquire, run, release — release is guaranteed even if `fn` throws.
const users = await withResource(pool, tenantId, async (dataSource) => {
  return dataSource.getRepository(User).find();
});

await pool.stop(); // on shutdown: destroys every live DataSource
```

The factory builds a `DataSource` from `config(key)` and calls `.initialize()`;
`dispose` calls `.destroy()` on eviction/drain. All other
[`PoolOptions`](../core#pooloptionst) (`max`, `idleTtlMs`, `breaker`, `prewarm`,
`statsIntervalMs`, …) pass straight through.

## API

- `createTypeOrmPool(options)` → `RefCountedLruPool<DataSource>` —
  `options` is `PoolOptions` minus `factory`/`dispose`, plus
  `config: (key) => DataSourceOptions | Promise<DataSourceOptions>`.
- `withResource(pool, key, fn)` — acquire `key`, run `fn(dataSource)`, release in `finally`.

## License

MIT © Atul Singh
