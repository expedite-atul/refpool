import { Module } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { RefPoolModule, TenantConnectionMiddleware } from '@refpool/nestjs';
import { Pool } from 'pg';
import { poolConfigForTenant } from './tenant-config.js';
import { TenantController } from './tenant.controller.js';

@Module({
  imports: [
    // Wire the refpool dynamic module with a createPgPool-style factory: each
    // distinct tenant key lazily gets its own node-postgres `Pool`, the whole
    // set is bounded + reference-counted, and idle tenants are reclaimed.
    RefPoolModule.forRootAsync<Pool>({
      isGlobal: true,
      useFactory: () => ({
        max: Number(process.env.REFPOOL_MAX ?? 10),
        idleTtlMs: Number(process.env.REFPOOL_IDLE_TTL_MS ?? 30_000),
        mutexGcMs: 60_000,
        statsIntervalMs: Number(process.env.REFPOOL_STATS_INTERVAL_MS ?? 0) || undefined,
        factory: async (tenantId: string) => new Pool(poolConfigForTenant(tenantId)),
        dispose: async (pool: Pool) => {
          await pool.end();
        },
        middleware: {
          header: 'x-tenant-id',
          onMissing: 'error',
          requestProperty: 'tenantResource',
        },
      }),
    }),
  ],
  controllers: [TenantController],
})
export class AppModule implements NestModule {
  // Acquire a per-tenant pool for every request to /tenant/* keyed by the
  // x-tenant-id header; the holder is released when the response completes.
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantConnectionMiddleware).forRoutes(TenantController);
  }
}
