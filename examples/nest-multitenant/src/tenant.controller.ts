import { Controller, Get, Headers, Inject, Req } from '@nestjs/common';
import { RefPoolService } from '@refpool/nestjs';
import { withResource as pgWithResource } from '@refpool/pg';
import type { PoolStats } from '@refpool/core';
import type { Pool } from 'pg';

/** Shape the middleware attaches onto the request object. */
interface TenantRequest {
  /** The acquired per-tenant `pg.Pool` (attached by TenantConnectionMiddleware). */
  tenantResource?: Pool;
  /** The tenant key used for the acquire (attached as `${requestProperty}Key`). */
  tenantResourceKey?: string;
}

@Controller('tenant')
export class TenantController {
  constructor(
    @Inject(RefPoolService) private readonly refpool: RefPoolService<Pool>,
  ) {}

  /**
   * Uses the resource the middleware already acquired for this request. The
   * holder is released automatically when the response finishes/closes — the
   * route body does not have to manage the lifecycle.
   */
  @Get('now')
  async now(@Req() req: TenantRequest): Promise<{ tenant?: string; now?: Date }> {
    const pool = req.tenantResource;
    if (!pool) {
      throw new Error('No tenant resource on request — was the x-tenant-id header sent?');
    }
    const result = await pool.query<{ now: Date }>('SELECT now() AS now');
    return { tenant: req.tenantResourceKey, now: result.rows[0]?.now };
  }

  /**
   * Alternative style: acquire/run/release explicitly via the @refpool/pg
   * helper, keyed off the header directly (independent of the middleware).
   */
  @Get('report')
  async report(
    @Headers('x-tenant-id') tenantId: string,
  ): Promise<{ tenant: string; tables: number }> {
    if (!tenantId) {
      throw new Error('Missing x-tenant-id header.');
    }
    return pgWithResource(this.refpool.pool, tenantId, async (pool) => {
      const result = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
      );
      return { tenant: tenantId, tables: Number(result.rows[0]?.count ?? 0) };
    });
  }

  /** Live pool stats (same data as GET /health/connections, scoped here too). */
  @Get('stats')
  stats(): PoolStats {
    return this.refpool.getStats();
  }
}
