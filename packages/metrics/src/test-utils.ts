import { RefCountedLruPool } from '@refpool/core';

export interface StubResource {
  key: string;
}

export interface StubPool {
  pool: RefCountedLruPool<StubResource>;
  created: string[];
  disposed: string[];
}

/** A real core pool wired to a synchronous, side-effect-recording stub factory. */
export function makePool(max = 4): StubPool {
  const created: string[] = [];
  const disposed: string[] = [];
  const pool = new RefCountedLruPool<StubResource>({
    max,
    factory: async (key) => {
      created.push(key);
      return { key };
    },
    dispose: (_resource, key) => {
      disposed.push(key);
    },
  });
  return { pool, created, disposed };
}
