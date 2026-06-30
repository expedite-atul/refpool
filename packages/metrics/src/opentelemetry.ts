import type {
  Attributes,
  Counter,
  Meter,
  ObservableCounter,
  ObservableGauge,
  ObservableResult,
} from '@opentelemetry/api';
import type { BreakerState } from '@refpool/core';
import {
  BREAKER_STATE_CODE,
  DEFAULT_PREFIX,
  saturation,
  type MetricsSource,
} from './shared.js';

export interface OpenTelemetryBindingOptions {
  /** The `Meter` the instruments are created from. */
  meter: Meter;
  /** Instrument-name prefix. Defaults to `refpool_`. */
  prefix?: string;
  /**
   * Pool capacity used for the saturation ratio (`live / max`). The core pool
   * does not surface its `max` publicly, so pass the same value you gave it.
   */
  max?: number;
  /** Static attributes applied to every observation. */
  attributes?: Attributes;
}

export interface OpenTelemetryBinding {
  /** Remove all async callbacks and unsubscribe from pool events. */
  unbind(): void;
  /** Alias for {@link OpenTelemetryBinding.unbind}. */
  dispose(): void;
}

/**
 * Binds a `@refpool/core` pool to OpenTelemetry instruments on the supplied
 * `Meter`. Stats-derived signals use `ObservableGauge`/`ObservableCounter`
 * (sampled from `getStats()`); event-driven counts use synchronous `Counter`s.
 */
export function bindOpenTelemetry(
  pool: MetricsSource,
  options: OpenTelemetryBindingOptions,
): OpenTelemetryBinding {
  const { meter } = options;
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const attributes = options.attributes ?? {};

  let breakerState: BreakerState = 'closed';

  const observableGauges = {
    live: meter.createObservableGauge(`${prefix}live`, {
      description: 'Undisposed resources (live pool + held orphans).',
    }),
    idle: meter.createObservableGauge(`${prefix}idle`, {
      description: 'Live resources at refcount 0 (reclaimable).',
    }),
    inUse: meter.createObservableGauge(`${prefix}in_use`, {
      description: 'Live resources with at least one holder.',
    }),
    keys: meter.createObservableGauge(`${prefix}keys`, {
      description: 'Distinct keys held in the live pool.',
    }),
    waiters: meter.createObservableGauge(`${prefix}waiters`, {
      description: 'Acquire calls blocked on resource creation.',
    }),
    max: meter.createObservableGauge(`${prefix}max`, {
      description: 'Configured upper bound on live keyed resources.',
    }),
    saturation: meter.createObservableGauge(`${prefix}saturation_ratio`, {
      description: 'Pool saturation as live / max (0..1).',
    }),
    breakerState: meter.createObservableGauge(`${prefix}breaker_state`, {
      description: 'Current circuit-breaker state (0=closed, 1=half-open, 2=open).',
    }),
  };

  const observableCounters = {
    hits: meter.createObservableCounter(`${prefix}hits_total`, {
      description: 'Acquire cache hits.',
    }),
    misses: meter.createObservableCounter(`${prefix}misses_total`, {
      description: 'Acquire cache misses.',
    }),
  };

  const counters: Record<'created' | 'disposed' | 'evicted' | 'acquires' | 'releases', Counter> = {
    created: meter.createCounter(`${prefix}created_total`, { description: 'Resources created.' }),
    disposed: meter.createCounter(`${prefix}disposed_total`, { description: 'Resources disposed.' }),
    evicted: meter.createCounter(`${prefix}evicted_total`, {
      description: 'Resources evicted (lru/ttl/drain).',
    }),
    acquires: meter.createCounter(`${prefix}acquires_total`, {
      description: 'Acquire handles checked out.',
    }),
    releases: meter.createCounter(`${prefix}releases_total`, {
      description: 'Holder references released.',
    }),
  };

  const breakerTransitions: Counter = meter.createCounter(`${prefix}breaker_transitions_total`, {
    description: 'Cumulative circuit-breaker transitions into each state.',
  });

  const gaugeCallbacks: Array<[ObservableGauge, (result: ObservableResult) => void]> = [
    [observableGauges.live, (r) => r.observe(pool.getStats().live, attributes)],
    [observableGauges.idle, (r) => r.observe(pool.getStats().idle, attributes)],
    [observableGauges.inUse, (r) => r.observe(pool.getStats().inUse, attributes)],
    [observableGauges.keys, (r) => r.observe(pool.getStats().keys, attributes)],
    [observableGauges.waiters, (r) => r.observe(pool.getStats().waiters, attributes)],
    [observableGauges.max, (r) => r.observe(options.max ?? 0, attributes)],
    [
      observableGauges.saturation,
      (r) => r.observe(saturation(pool.getStats(), options.max), attributes),
    ],
    [
      observableGauges.breakerState,
      (r) => r.observe(BREAKER_STATE_CODE[breakerState], attributes),
    ],
  ];

  const counterCallbacks: Array<[ObservableCounter, (result: ObservableResult) => void]> = [
    [observableCounters.hits, (r) => r.observe(pool.getStats().hits, attributes)],
    [observableCounters.misses, (r) => r.observe(pool.getStats().misses, attributes)],
  ];

  for (const [instrument, callback] of gaugeCallbacks) instrument.addCallback(callback);
  for (const [instrument, callback] of counterCallbacks) instrument.addCallback(callback);

  const unsubscribers = [
    pool.on('create', () => counters.created.add(1, attributes)),
    pool.on('dispose', () => counters.disposed.add(1, attributes)),
    pool.on('evict', (event) =>
      counters.evicted.add(1, { ...attributes, reason: event.reason }),
    ),
    pool.on('acquire', () => counters.acquires.add(1, attributes)),
    pool.on('release', () => counters.releases.add(1, attributes)),
    pool.on('breaker-open', () => {
      breakerState = 'open';
      breakerTransitions.add(1, { ...attributes, state: 'open' });
    }),
    pool.on('breaker-close', () => {
      breakerState = 'closed';
      breakerTransitions.add(1, { ...attributes, state: 'closed' });
    }),
    pool.on('breaker-half-open', () => {
      breakerState = 'half-open';
      breakerTransitions.add(1, { ...attributes, state: 'half-open' });
    }),
  ];

  let unbound = false;
  const unbind = (): void => {
    if (unbound) return;
    unbound = true;
    for (const [instrument, callback] of gaugeCallbacks) instrument.removeCallback(callback);
    for (const [instrument, callback] of counterCallbacks) instrument.removeCallback(callback);
    for (const off of unsubscribers) off();
  };

  return { unbind, dispose: unbind };
}
