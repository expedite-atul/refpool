import { Counter, Gauge, Registry } from 'prom-client';
import type { BreakerState, PoolStats } from '@refpool/core';
import {
  BREAKER_STATE_CODE,
  DEFAULT_PREFIX,
  saturation,
  type MetricsSource,
} from './shared.js';

export interface PrometheusBindingOptions {
  /** Registry to register on. Defaults to a fresh `Registry`. */
  registry?: Registry;
  /** Metric-name prefix. Defaults to `refpool_`. */
  prefix?: string;
  /**
   * Pool capacity used for the saturation ratio (`live / max`). The core pool
   * does not surface its `max` publicly, so pass the same value you gave it.
   */
  max?: number;
  /** Static labels applied to every metric (e.g. `{ pool: 'tenant-db' }`). */
  labels?: Record<string, string>;
}

export interface PrometheusBinding {
  /** The registry the instruments were registered on. */
  registry: Registry;
  /** `registry.contentType`, for the `Content-Type` response header. */
  contentType: string;
  /** Resolves to the exposition-format payload for a `/metrics` handler. */
  metrics(): Promise<string>;
  /** Unsubscribe from pool events and drop the instruments from the registry. */
  unbind(): void;
  /** Alias for {@link PrometheusBinding.unbind}. */
  dispose(): void;
}

const BREAKER_STATES = Object.keys(BREAKER_STATE_CODE) as BreakerState[];

/**
 * Binds a `@refpool/core` pool to Prometheus instruments. Stats-derived gauges
 * and cumulative counters are refreshed lazily from `getStats()` on each scrape;
 * acquire/release rates and the live breaker state are driven by pool events.
 */
export function bindPrometheus(
  pool: MetricsSource,
  options: PrometheusBindingOptions = {},
): PrometheusBinding {
  const registry = options.registry ?? new Registry();
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const labels = options.labels ?? {};
  const labelNames = Object.keys(labels);
  const names: string[] = [];

  const gauge = (name: string, help: string): Gauge => {
    names.push(name);
    return new Gauge({ name, help, registers: [registry], labelNames });
  };
  const counter = (name: string, help: string, extraLabels: string[] = []): Counter => {
    names.push(name);
    return new Counter({ name, help, registers: [registry], labelNames: [...labelNames, ...extraLabels] });
  };

  const gauges = {
    live: gauge(`${prefix}live`, 'Undisposed resources (live pool + held orphans).'),
    idle: gauge(`${prefix}idle`, 'Live resources at refcount 0 (reclaimable).'),
    inUse: gauge(`${prefix}in_use`, 'Live resources with at least one holder.'),
    keys: gauge(`${prefix}keys`, 'Distinct keys held in the live pool.'),
    waiters: gauge(`${prefix}waiters`, 'Acquire calls blocked on resource creation.'),
    max: gauge(`${prefix}max`, 'Configured upper bound on live keyed resources.'),
    saturation: gauge(`${prefix}saturation_ratio`, 'Pool saturation as live / max (0..1).'),
    breakerState: gauge(
      `${prefix}breaker_state`,
      'Current circuit-breaker state (0=closed, 1=half-open, 2=open).',
    ),
  };

  const counters = {
    created: counter(`${prefix}created_total`, 'Resources created.'),
    disposed: counter(`${prefix}disposed_total`, 'Resources disposed.'),
    evicted: counter(`${prefix}evicted_total`, 'Resources evicted (lru/ttl/drain).'),
    hits: counter(`${prefix}hits_total`, 'Acquire cache hits.'),
    misses: counter(`${prefix}misses_total`, 'Acquire cache misses.'),
    acquires: counter(`${prefix}acquires_total`, 'Acquire handles checked out.'),
    releases: counter(`${prefix}releases_total`, 'Holder references released.'),
    breakerTransitions: counter(
      `${prefix}breaker_transitions_total`,
      'Cumulative circuit-breaker transitions into each state.',
      ['state'],
    ),
  };

  const last: Pick<PoolStats, 'created' | 'disposed' | 'evicted' | 'hits' | 'misses'> & {
    breaker: Record<BreakerState, number>;
  } = {
    created: 0,
    disposed: 0,
    evicted: 0,
    hits: 0,
    misses: 0,
    breaker: { closed: 0, open: 0, 'half-open': 0 },
  };

  const sync = (): void => {
    const stats = pool.getStats();
    gauges.live.set(labels, stats.live);
    gauges.idle.set(labels, stats.idle);
    gauges.inUse.set(labels, stats.inUse);
    gauges.keys.set(labels, stats.keys);
    gauges.waiters.set(labels, stats.waiters);
    gauges.max.set(labels, options.max ?? 0);
    gauges.saturation.set(labels, saturation(stats, options.max));

    counters.created.inc(labels, stats.created - last.created);
    counters.disposed.inc(labels, stats.disposed - last.disposed);
    counters.evicted.inc(labels, stats.evicted - last.evicted);
    counters.hits.inc(labels, stats.hits - last.hits);
    counters.misses.inc(labels, stats.misses - last.misses);
    last.created = stats.created;
    last.disposed = stats.disposed;
    last.evicted = stats.evicted;
    last.hits = stats.hits;
    last.misses = stats.misses;

    for (const state of BREAKER_STATES) {
      const delta = stats.breaker[state] - last.breaker[state];
      if (delta !== 0) {
        counters.breakerTransitions.inc({ ...labels, state }, delta);
        last.breaker[state] = stats.breaker[state];
      }
    }
  };

  // All registered collect callbacks are awaited before formatting, so attaching
  // the shared sync to a single instrument refreshes every metric per scrape.
  (gauges.live as Gauge & { collect: () => void }).collect = sync;

  gauges.breakerState.set(labels, BREAKER_STATE_CODE.closed);

  const unsubscribers = [
    pool.on('acquire', () => counters.acquires.inc(labels, 1)),
    pool.on('release', () => counters.releases.inc(labels, 1)),
    pool.on('breaker-open', () => gauges.breakerState.set(labels, BREAKER_STATE_CODE.open)),
    pool.on('breaker-close', () => gauges.breakerState.set(labels, BREAKER_STATE_CODE.closed)),
    pool.on('breaker-half-open', () =>
      gauges.breakerState.set(labels, BREAKER_STATE_CODE['half-open']),
    ),
  ];

  let unbound = false;
  const unbind = (): void => {
    if (unbound) return;
    unbound = true;
    for (const off of unsubscribers) off();
    for (const name of names) registry.removeSingleMetric(name);
  };

  return {
    registry,
    contentType: registry.contentType,
    metrics: () => registry.metrics(),
    unbind,
    dispose: unbind,
  };
}
