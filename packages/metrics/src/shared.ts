import type { BreakerState, PoolStats, RefCountedLruPool } from '@refpool/core';

/** Prefix prepended to every metric name. Trailing separator is the caller's choice. */
export const DEFAULT_PREFIX = 'refpool_';

/**
 * Numeric encoding of the circuit-breaker state, exposed as a gauge so it can be
 * graphed and alerted on. Mirrors common breaker conventions (higher == worse).
 */
export const BREAKER_STATE_CODE: Record<BreakerState, number> = {
  closed: 0,
  'half-open': 1,
  open: 2,
};

/** Any object exposing the slice of the core pool surface the exporters consume. */
export type MetricsSource<T = unknown> = Pick<
  RefCountedLruPool<T>,
  'getStats' | 'on'
>;

/** Saturation as `live / max`, clamped so a non-positive `max` yields `0`. */
export function saturation(stats: PoolStats, max: number | undefined): number {
  if (!max || max <= 0) return 0;
  return stats.live / max;
}

/** Builds a typed map of `name -> fully-prefixed metric name`. */
export function withPrefix<const N extends readonly string[]>(
  prefix: string,
  names: N,
): { [K in N[number]]: string } {
  const out = {} as { [K in N[number]]: string };
  for (const name of names) {
    out[name as N[number]] = `${prefix}${name}`;
  }
  return out;
}
