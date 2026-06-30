import { Controller, Get, Inject } from '@nestjs/common';
import type { PoolStats } from '@refpool/core';
import { RefPoolService } from './ref-pool.service.js';

@Controller('health')
export class ConnectionHealthController {
  constructor(@Inject(RefPoolService) private readonly service: RefPoolService) {}

  @Get('connections')
  connections(): PoolStats {
    return this.service.getStats();
  }
}
