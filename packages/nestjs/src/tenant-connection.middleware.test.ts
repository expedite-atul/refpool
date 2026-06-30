import { describe, expect, it, vi } from 'vitest';
import { TenantConnectionMiddleware } from './tenant-connection.middleware.js';
import type { RefPoolService } from './ref-pool.service.js';
import type { TenantMiddlewareOptions } from './interfaces.js';

type ReqLike = { headers: Record<string, string | string[] | undefined> } & Record<string, unknown>;

function setup(options: TenantMiddlewareOptions = {}) {
  const release = vi.fn();
  const handle = { resource: { id: 'conn' }, release };
  const acquire = vi.fn().mockResolvedValue(handle);
  const service = { acquire } as unknown as RefPoolService;
  const middleware = new TenantConnectionMiddleware(service, options);

  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    on(event: string, listener: () => void) {
      (listeners[event] ??= []).push(listener);
      return res;
    },
  };
  const fire = (event: string): void => {
    for (const listener of listeners[event] ?? []) listener();
  };

  return { middleware, acquire, release, res, fire };
}

describe('TenantConnectionMiddleware', () => {
  it('acquires for the tenant header and releases on finish', async () => {
    const { middleware, acquire, release, res, fire } = setup();
    const req: ReqLike = { headers: { 'x-tenant-id': 'tenant-1' } };
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(acquire).toHaveBeenCalledWith('tenant-1');
    expect(req.tenantResource).toEqual({ id: 'conn' });
    expect(req.tenantResourceKey).toBe('tenant-1');
    expect(next).toHaveBeenCalledWith();
    expect(release).not.toHaveBeenCalled();

    fire('finish');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('guards against double release across finish and close', async () => {
    const { middleware, release, res, fire } = setup();
    const req: ReqLike = { headers: { 'x-tenant-id': 'tenant-1' } };

    await middleware.use(req, res, vi.fn());

    fire('finish');
    fire('close');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('honors a custom header and request property', async () => {
    const { middleware, acquire, res } = setup({ header: 'X-Org', requestProperty: 'org' });
    const req: ReqLike = { headers: { 'x-org': 'acme' } };

    await middleware.use(req, res, vi.fn());

    expect(acquire).toHaveBeenCalledWith('acme');
    expect(req.org).toEqual({ id: 'conn' });
  });

  it('skips acquisition and calls next when header missing (default)', async () => {
    const { middleware, acquire, res } = setup();
    const req: ReqLike = { headers: {} };
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(acquire).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('errors when header missing and onMissing is "error"', async () => {
    const { middleware, acquire, res } = setup({ onMissing: 'error' });
    const req: ReqLike = { headers: {} };
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(acquire).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('forwards acquire failure to next', async () => {
    const release = vi.fn();
    const acquire = vi.fn().mockRejectedValue(new Error('boom'));
    const service = { acquire } as unknown as RefPoolService;
    const middleware = new TenantConnectionMiddleware(service, {});
    const res = { on: vi.fn() };
    const req: ReqLike = { headers: { 'x-tenant-id': 't' } };
    const next = vi.fn();

    await middleware.use(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(release).not.toHaveBeenCalled();
  });
});
