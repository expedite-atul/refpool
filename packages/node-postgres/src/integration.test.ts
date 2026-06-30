import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createPgPool, withResource } from './index.js';

// Opt-in: requires a Docker daemon. Skipped by default so CI stays fast/DB-free.
// testcontainers (and its native Docker deps) are imported dynamically inside the
// suite so that test collection never loads them when this suite is skipped.
const RUN = process.env.INTEGRATION === '1';
const APP_PREFIX = 'refpool-tenant-';

const describeIntegration = RUN ? describe : describe.skip;

describeIntegration('pg pool integration (testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let base: PoolConfig;
  let monitor: Pool;

  beforeAll(async () => {
    const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    base = {
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: container.getUsername(),
      password: container.getPassword(),
    };
    monitor = new Pool({ ...base, application_name: 'refpool-monitor', max: 1 });
  });

  afterAll(async () => {
    await monitor?.end();
    await container?.stop();
  });

  const countTenantBackends = async (): Promise<number> => {
    const res = await monitor.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name LIKE $1`,
      [`${APP_PREFIX}%`],
    );
    return Number(res.rows[0]?.count ?? 0);
  };

  it('keeps live backend connections <= pool.max while hammering many tenants', async () => {
    const MAX = 3;
    const TENANTS = Array.from({ length: 12 }, (_, i) => `t${i}`);
    expect(MAX).toBeLessThan(TENANTS.length);

    const pool = createPgPool({
      max: MAX,
      config: (key) => ({
        ...base,
        // One backend connection per tenant pool so refpool.max bounds backends.
        max: 1,
        application_name: `${APP_PREFIX}${key}`,
      }),
    });

    let observedMax = 0;
    let stop = false;
    const sampler = (async () => {
      while (!stop) {
        observedMax = Math.max(observedMax, await countTenantBackends());
        await new Promise((r) => setTimeout(r, 15));
      }
    })();

    // Bound concurrency to MAX so at most MAX tenants are held at once.
    const worker = async (offset: number): Promise<void> => {
      for (let i = 0; i < 40; i++) {
        const key = TENANTS[(offset + i) % TENANTS.length]!;
        await withResource(pool, key, async (pg) => {
          const r = await pg.query<{ ok: number }>('SELECT 1 AS ok');
          expect(r.rows[0]?.ok).toBe(1);
        });
      }
    };

    await Promise.all(Array.from({ length: MAX }, (_, w) => worker(w)));
    stop = true;
    await sampler;

    const stats = pool.getStats();
    expect(stats.live).toBeLessThanOrEqual(MAX);
    // More distinct tenants than max were exercised -> eviction + recreation.
    expect(stats.created).toBeGreaterThan(MAX);
    expect(observedMax).toBeLessThanOrEqual(MAX);

    await pool.drain();
    expect(pool.getStats().live).toBe(0);

    // Backends from tenant pools should be released after drain.
    await new Promise((r) => setTimeout(r, 250));
    expect(await countTenantBackends()).toBe(0);
  });
});
