import { Registry } from 'prom-client';
import { describe, expect, it } from 'vitest';
import { bindPrometheus } from './prometheus.js';
import { makePool } from './test-utils.js';

type Json = Array<{ name: string; values: Array<{ value: number; labels: Record<string, unknown> }> }>;

function valueOf(json: Json, name: string): number | undefined {
  return json.find((m) => m.name === name)?.values[0]?.value;
}

describe('bindPrometheus', () => {
  it('registers the expected instruments on the registry', async () => {
    const registry = new Registry();
    const { pool } = makePool(4);
    bindPrometheus(pool, { registry, max: 4 });

    const text = await registry.metrics();
    for (const name of [
      'refpool_live',
      'refpool_idle',
      'refpool_in_use',
      'refpool_keys',
      'refpool_waiters',
      'refpool_max',
      'refpool_saturation_ratio',
      'refpool_breaker_state',
      'refpool_created_total',
      'refpool_disposed_total',
      'refpool_evicted_total',
      'refpool_hits_total',
      'refpool_misses_total',
      'refpool_acquires_total',
      'refpool_releases_total',
      'refpool_breaker_transitions_total',
    ]) {
      expect(registry.getSingleMetric(name), name).toBeDefined();
      expect(text).toContain(`# HELP ${name}`);
    }
  });

  it('honours a custom prefix', async () => {
    const registry = new Registry();
    const { pool } = makePool(4);
    bindPrometheus(pool, { registry, prefix: 'pool_', max: 4 });
    expect(registry.getSingleMetric('pool_live')).toBeDefined();
    expect(registry.getSingleMetric('refpool_live')).toBeUndefined();
  });

  it('maps pool events and stats onto metric values', async () => {
    const registry = new Registry();
    const { pool } = makePool(4);
    const binding = bindPrometheus(pool, { registry, max: 4 });

    const h1 = await pool.acquire('a');
    const h2 = await pool.acquire('a');
    h1.release();

    const json = (await registry.getMetricsAsJSON()) as unknown as Json;
    expect(valueOf(json, 'refpool_created_total')).toBe(1);
    expect(valueOf(json, 'refpool_misses_total')).toBe(1);
    expect(valueOf(json, 'refpool_hits_total')).toBe(1);
    expect(valueOf(json, 'refpool_acquires_total')).toBe(2);
    expect(valueOf(json, 'refpool_releases_total')).toBe(1);
    expect(valueOf(json, 'refpool_live')).toBe(1);
    expect(valueOf(json, 'refpool_in_use')).toBe(1);
    expect(valueOf(json, 'refpool_idle')).toBe(0);
    expect(valueOf(json, 'refpool_max')).toBe(4);
    expect(valueOf(json, 'refpool_saturation_ratio')).toBe(0.25);
    expect(valueOf(json, 'refpool_breaker_state')).toBe(0);

    h2.release();
    await pool.drain();

    const json2 = (await registry.getMetricsAsJSON()) as unknown as Json;
    expect(valueOf(json2, 'refpool_disposed_total')).toBe(1);
    expect(valueOf(json2, 'refpool_live')).toBe(0);
    expect(valueOf(json2, 'refpool_idle')).toBe(0);

    binding.unbind();
  });

  it('exposes a serve handle and unbinds cleanly', async () => {
    const registry = new Registry();
    const { pool } = makePool(4);
    const binding = bindPrometheus(pool, { registry, max: 4 });

    expect(binding.contentType).toBe(registry.contentType);
    expect(typeof (await binding.metrics())).toBe('string');

    binding.unbind();
    expect(registry.getSingleMetric('refpool_live')).toBeUndefined();
    expect(registry.getSingleMetric('refpool_created_total')).toBeUndefined();
  });
});
