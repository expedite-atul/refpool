import type { Meter, ObservableResult } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { bindOpenTelemetry } from './opentelemetry.js';
import { makePool } from './test-utils.js';

type Callback = (result: ObservableResult) => void;

interface Observable {
  name: string;
  callbacks: Set<Callback>;
}

class MockMeter {
  readonly createdNames = new Set<string>();
  readonly counters = new Map<string, number>();
  readonly observed = new Map<string, number>();
  private readonly observables: Observable[] = [];

  createCounter(name: string): { add(value: number): void } {
    this.createdNames.add(name);
    return {
      add: (value: number) => {
        this.counters.set(name, (this.counters.get(name) ?? 0) + value);
      },
    };
  }

  createObservableGauge(name: string): {
    addCallback(cb: Callback): void;
    removeCallback(cb: Callback): void;
  } {
    return this.makeObservable(name);
  }

  createObservableCounter(name: string): {
    addCallback(cb: Callback): void;
    removeCallback(cb: Callback): void;
  } {
    return this.makeObservable(name);
  }

  collect(): void {
    for (const obs of this.observables) {
      for (const cb of obs.callbacks) {
        cb({ observe: (value: number) => this.observed.set(obs.name, value) } as ObservableResult);
      }
    }
  }

  private makeObservable(name: string): {
    addCallback(cb: Callback): void;
    removeCallback(cb: Callback): void;
  } {
    this.createdNames.add(name);
    const obs: Observable = { name, callbacks: new Set() };
    this.observables.push(obs);
    return {
      addCallback: (cb: Callback) => obs.callbacks.add(cb),
      removeCallback: (cb: Callback) => obs.callbacks.delete(cb),
    };
  }
}

describe('bindOpenTelemetry', () => {
  it('creates the expected instruments on the meter', () => {
    const meter = new MockMeter();
    const { pool } = makePool(4);
    bindOpenTelemetry(pool, { meter: meter as unknown as Meter, max: 4 });

    for (const name of [
      'refpool_live',
      'refpool_idle',
      'refpool_in_use',
      'refpool_keys',
      'refpool_waiters',
      'refpool_max',
      'refpool_saturation_ratio',
      'refpool_breaker_state',
      'refpool_hits_total',
      'refpool_misses_total',
      'refpool_created_total',
      'refpool_disposed_total',
      'refpool_evicted_total',
      'refpool_acquires_total',
      'refpool_releases_total',
      'refpool_breaker_transitions_total',
    ]) {
      expect(meter.createdNames.has(name), name).toBe(true);
    }
  });

  it('maps pool events and stats onto instrument observations', async () => {
    const meter = new MockMeter();
    const { pool } = makePool(4);
    bindOpenTelemetry(pool, { meter: meter as unknown as Meter, max: 4 });

    const h1 = await pool.acquire('a');
    const h2 = await pool.acquire('a');
    h1.release();

    meter.collect();
    expect(meter.observed.get('refpool_live')).toBe(1);
    expect(meter.observed.get('refpool_in_use')).toBe(1);
    expect(meter.observed.get('refpool_idle')).toBe(0);
    expect(meter.observed.get('refpool_max')).toBe(4);
    expect(meter.observed.get('refpool_saturation_ratio')).toBe(0.25);
    expect(meter.observed.get('refpool_breaker_state')).toBe(0);
    expect(meter.observed.get('refpool_hits_total')).toBe(1);
    expect(meter.observed.get('refpool_misses_total')).toBe(1);

    expect(meter.counters.get('refpool_created_total')).toBe(1);
    expect(meter.counters.get('refpool_acquires_total')).toBe(2);
    expect(meter.counters.get('refpool_releases_total')).toBe(1);

    h2.release();
    await pool.drain();
    meter.collect();
    expect(meter.counters.get('refpool_disposed_total')).toBe(1);
    expect(meter.observed.get('refpool_live')).toBe(0);
    expect(meter.observed.get('refpool_idle')).toBe(0);
  });

  it('stops recording after unbind', async () => {
    const meter = new MockMeter();
    const { pool } = makePool(4);
    const binding = bindOpenTelemetry(pool, { meter: meter as unknown as Meter, max: 4 });

    const h1 = await pool.acquire('a');
    expect(meter.counters.get('refpool_acquires_total')).toBe(1);

    binding.unbind();
    h1.release();
    const h2 = await pool.acquire('b');
    h2.release();

    expect(meter.counters.get('refpool_acquires_total')).toBe(1);
    meter.observed.clear();
    meter.collect();
    expect(meter.observed.size).toBe(0);
  });
});
