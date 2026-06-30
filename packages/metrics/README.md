# @refpool/metrics

Prometheus and OpenTelemetry metric exporters for [`@refpool/core`](../core)
pools, plus a ready-to-import Grafana dashboard.

Both binders subscribe to the pool's typed events and sample `getStats()`, so you
get saturation, hit rate, in-flight waiters, and live circuit-breaker state with
one line of wiring.

## Install

```bash
npm install @refpool/metrics
# plus whichever exporter you use:
npm install prom-client            # for the Prometheus binding
npm install @opentelemetry/api     # for the OpenTelemetry binding
```

`prom-client` and `@opentelemetry/api` are **optional** peer dependencies — pull
in only the one you need.

## Metric names

All metrics are prefixed `refpool_` by default (override via `prefix`).

| Metric | Type | Meaning |
| --- | --- | --- |
| `refpool_live` | gauge | Undisposed resources (live pool + held orphans). |
| `refpool_idle` | gauge | Live resources at refcount 0 (reclaimable). |
| `refpool_in_use` | gauge | Live resources with at least one holder. |
| `refpool_keys` | gauge | Distinct keys held in the live pool. |
| `refpool_waiters` | gauge | Acquire calls blocked on resource creation. |
| `refpool_max` | gauge | Configured upper bound on live keyed resources. |
| `refpool_saturation_ratio` | gauge | Pool saturation as `live / max` (0..1). |
| `refpool_breaker_state` | gauge | Current breaker state (`0=closed, 1=half-open, 2=open`). |
| `refpool_created_total` | counter | Resources created. |
| `refpool_disposed_total` | counter | Resources disposed. |
| `refpool_evicted_total` | counter | Resources evicted (lru/ttl/drain). |
| `refpool_hits_total` | counter | Acquire cache hits. |
| `refpool_misses_total` | counter | Acquire cache misses. |
| `refpool_acquires_total` | counter | Acquire handles checked out. |
| `refpool_releases_total` | counter | Holder references released. |
| `refpool_breaker_transitions_total` | counter | Breaker transitions, labeled by `state`. |

> The core pool does not surface its `max` publicly — pass the same `max` you gave
> the pool so the saturation ratio is meaningful.

## Prometheus

```ts
import { RefCountedLruPool } from '@refpool/core';
import { bindPrometheus } from '@refpool/metrics/prometheus';
import express from 'express';

const pool = new RefCountedLruPool({ max: 50, factory });
const binding = bindPrometheus(pool, { max: 50, labels: { pool: 'tenant-db' } });

const app = express();
app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', binding.contentType);
  res.end(await binding.metrics());
});

// on shutdown: binding.unbind();
```

`bindPrometheus(pool, options)` returns `{ registry, contentType, metrics(), unbind(), dispose() }`.
Options: `registry?`, `prefix?`, `max?`, `labels?`.

## OpenTelemetry

```ts
import { metrics } from '@opentelemetry/api';
import { bindOpenTelemetry } from '@refpool/metrics/opentelemetry';

const meter = metrics.getMeter('refpool');
const binding = bindOpenTelemetry(pool, { meter, max: 50, attributes: { pool: 'tenant-db' } });

// on shutdown: binding.unbind();
```

`bindOpenTelemetry(pool, options)` returns `{ unbind(), dispose() }`.
Options: `meter` (**required**), `prefix?`, `max?`, `attributes?`.

## Grafana

A pre-built dashboard (saturation, hit rate, breaker state, RSS trend) lives at
[`grafana/refpool-dashboard.json`](../../grafana/refpool-dashboard.json) in the
repo. Import it into Grafana and point it at your Prometheus data source.

## Exports

| Subpath | Provides |
| --- | --- |
| `@refpool/metrics` | `bindPrometheus`, `bindOpenTelemetry`, `BREAKER_STATE_CODE`, `DEFAULT_PREFIX`, types |
| `@refpool/metrics/prometheus` | `bindPrometheus` + Prometheus types |
| `@refpool/metrics/opentelemetry` | `bindOpenTelemetry` + OpenTelemetry types |

## License

MIT © Atul Singh
