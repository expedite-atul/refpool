import { describe, expect, it } from 'vitest';
import { RefCountedLruPool } from './pool.js';

describe('per-key mutex', () => {
  it('creates the resource exactly once under concurrent acquires of one key', async () => {
    let calls = 0;
    const pool = new RefCountedLruPool<number>({
      max: 10,
      factory: async (_key) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return calls;
      },
    });

    const handles = await Promise.all(
      Array.from({ length: 50 }, () => pool.acquire('same')),
    );

    expect(calls).toBe(1);
    expect(new Set(handles.map((h) => h.resource)).size).toBe(1);
    expect(pool.getStats().inUse).toBe(1);

    for (const handle of handles) handle.release();
  });

  it('creates independent resources for distinct keys in parallel', async () => {
    let calls = 0;
    const pool = new RefCountedLruPool<string>({
      max: 10,
      factory: async (key) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return key;
      },
    });

    const handles = await Promise.all(
      Array.from({ length: 5 }, (_value, i) => pool.acquire(`k${i}`)),
    );

    expect(calls).toBe(5);
    expect(pool.getStats().keys).toBe(5);
    for (const handle of handles) handle.release();
  });
});
