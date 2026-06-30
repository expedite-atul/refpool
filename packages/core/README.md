# @refpool/core

A keyed, **reference-counted, bounded LRU resource pool** with orphan handoff and
pluggable circuit breakers. Runtime-dependency-free.

`@refpool/core` pools *any* expensive keyed resource — a database connection, an
HTTP client with a keep-alive agent, a gRPC channel, an SDK instance. You give it
a `factory(key)` that creates a resource and a `dispose(resource)` that tears it
down; it guarantees you never hold more than `max` live resources, shares one
resource between concurrent holders of the same key, and reclaims the coldest
idle ones under pressure.

> **Generic-first.** The flagship use case is multi-tenant database connection
> pooling (see the `@refpool/*` adapters), but nothing here is database-specific.

## Install

```bash
npm install @refpool/core
# or: pnpm add @refpool/core
```

`opossum` is an **optional** peer dependency, only needed if you use the
`@refpool/core/opossum` breaker subpath.

## Quick start

```ts
import { RefCountedLruPool } from '@refpool/core';

const pool = new RefCountedLruPool<MyClient>({
  max: 50,                       // never hold more than 50 live resources
  factory: async (key) => createClient(key),
  dispose: async (client) => client.close(),
  idleTtlMs: 30_000,             // reclaim idle resources after 30s
  statsIntervalMs: 10_000,       // emit a `stats` event + [POOL_STATS] log line
});

pool.start();                    // arm the idle sweep / stats timers

const { resource, release } = await pool.acquire('tenant-a');
try {
  await resource.doWork();
} finally {
  release();                     // idempotent; drops exactly this holder's ref
}

await pool.stop();               // drain + dispose everything on shutdown
```

## Public API

### `new RefCountedLruPool<T>(options: PoolOptions<T>)`

| Method | Description |
| --- | --- |
| `acquire(key)` | Resolve an `AcquireHandle<T>` (`{ resource, release() }`). Concurrent acquires of the same key share one resource. |
| `release(key)` | Convenience: drop one reference from the live (or orphaned) resource for `key`. Prefer the handle's `release()`. |
| `getStats()` | Snapshot of `PoolStats` (see below). |
| `warm(strategy?)` | Pre-create resources per a `PrewarmStrategy` (defaults to `options.prewarm`). |
| `start()` | Arm the idle-sweep, mutex-GC, and stats timers (unref'd). |
| `stop()` | Stop timers and `drain()`. |
| `drain()` | Dispose all idle resources now; condemn in-use ones to dispose on final release. |
| `on(type, listener)` / `off(type, listener)` | Subscribe/unsubscribe to a typed `PoolEvent`. `on` returns an unsubscribe fn. |

### `PoolOptions<T>`

| Option | Type | Notes |
| --- | --- | --- |
| `factory` | `(key) => Promise<T>` | **Required.** Invoked at most once per live key. |
| `max` | `number` | **Required.** Upper bound on live keyed resources. |
| `dispose` | `(resource, key) => void \| Promise<void>` | Tear-down; invoked at most once per resource. |
| `idleTtlMs` | `number` | Reclaim resources idle at least this long. |
| `mutexGcMs` | `number` | Drop unused per-key mutex cells older than this. |
| `statsIntervalMs` | `number` | Cadence for the `stats` event + `[POOL_STATS]` log line. |
| `validate` | `(resource) => boolean \| Promise<boolean>` | Validate an idle resource before reuse; falsy ⇒ recreate. |
| `breaker` | `CircuitBreaker \| (() => CircuitBreaker)` | Shared breaker, or a factory for per-key breakers. |
| `prewarm` | `PrewarmStrategy<T>` | Default strategy for `warm()`. |
| `logger` | `Logger` | Structured logger; defaults to a no-op. |

### `PoolStats`

`keys`, `live`, `idle`, `inUse`, `waiters`, `created`, `disposed`, `evicted`,
`hits`, `misses`, and `breaker` (cumulative transitions per state).

### Events

`acquire`, `release`, `create`, `dispose`, `evict` (`reason: 'lru' | 'ttl' | 'drain'`),
`idle-sweep`, `breaker-open`, `breaker-close`, `breaker-half-open`,
`drain-start`, `drain-complete`, `orphan-resurrect`, `stats`. Listeners receive
a precisely-narrowed payload:

```ts
const off = pool.on('evict', (e) => console.log('evicted', e.key, e.reason));
off();
```

### Circuit breakers

```ts
import { InMemoryCircuitBreaker, noopBreaker } from '@refpool/core';

const pool = new RefCountedLruPool<T>({
  max: 50,
  factory,
  breaker: () => new InMemoryCircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 }),
});
```

- `noopBreaker` — the default; never trips, zero overhead.
- `InMemoryCircuitBreaker` — dependency-free `closed → open → half-open → closed`
  state machine guarding `factory` calls. Throws `CircuitOpenError` while open.

## Subpath export: `@refpool/core/opossum`

Wrap the optional [`opossum`](https://github.com/nodeshift/opossum) breaker
(lazily imported on first use, so importing this subpath never hard-requires it):

```ts
import { createOpossumBreaker } from '@refpool/core/opossum';

const pool = new RefCountedLruPool<T>({
  max: 50,
  factory,
  breaker: () => createOpossumBreaker({ timeout: 3000, errorThresholdPercentage: 50 }),
});
```

`opossum` must be installed separately (`npm install opossum`).

## Exports

| Subpath | Entry points |
| --- | --- |
| `@refpool/core` | `import` → `dist/index.js` · `require` → `dist/index.cjs` · types → `dist/index.d.ts` |
| `@refpool/core/opossum` | `import` → `dist/opossum.js` · `require` → `dist/opossum.cjs` · types → `dist/opossum.d.ts` |

## License

MIT © Atul Singh
