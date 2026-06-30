import { Inject, Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import type { AcquireHandle } from '@refpool/core';
import { RefPoolService } from './ref-pool.service.js';
import { REFPOOL_MIDDLEWARE_OPTIONS } from './tokens.js';
import type { TenantMiddlewareOptions } from './interfaces.js';

const DEFAULT_HEADER = 'x-tenant-id';
const DEFAULT_PROPERTY = 'tenantResource';

interface MinimalRequest {
  headers?: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

interface MinimalResponse {
  on(event: string, listener: () => void): unknown;
}

type NextFn = (error?: unknown) => void;

@Injectable()
export class TenantConnectionMiddleware implements NestMiddleware {
  constructor(
    @Inject(RefPoolService) private readonly service: RefPoolService,
    @Inject(REFPOOL_MIDDLEWARE_OPTIONS) private readonly options: TenantMiddlewareOptions,
  ) {}

  async use(req: MinimalRequest, res: MinimalResponse, next: NextFn): Promise<void> {
    const header = (this.options.header ?? DEFAULT_HEADER).toLowerCase();
    const property = this.options.requestProperty ?? DEFAULT_PROPERTY;
    const onMissing = this.options.onMissing ?? 'next';

    const raw = req.headers?.[header];
    const tenantId = Array.isArray(raw) ? raw[0] : raw;

    if (!tenantId) {
      if (onMissing === 'error') {
        next(new Error(`Missing required tenant header "${header}"`));
        return;
      }
      next();
      return;
    }

    let handle: AcquireHandle<unknown>;
    try {
      handle = await this.service.acquire(tenantId);
    } catch (error) {
      next(error);
      return;
    }

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      handle.release();
    };
    res.on('finish', release);
    res.on('close', release);

    req[property] = handle.resource;
    req[`${property}Key`] = tenantId;
    next();
  }
}
