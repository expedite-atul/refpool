import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { RefPoolModule } from './ref-pool.module.js';
import { RefPoolService } from './ref-pool.service.js';
import { REFPOOL_OPTIONS } from './tokens.js';
import type { RefPoolModuleOptions } from './interfaces.js';

interface FakeConn {
  id: string;
}

function makeOptions(overrides: Partial<RefPoolModuleOptions<FakeConn>> = {}): RefPoolModuleOptions<FakeConn> {
  return {
    factory: async (key: string) => ({ id: key }),
    max: 8,
    ...overrides,
  };
}

describe('RefPoolModule.forRoot', () => {
  it('compiles and resolves RefPoolService + options token', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RefPoolModule.forRoot(makeOptions())],
    }).compile();

    const service = moduleRef.get(RefPoolService);
    expect(service).toBeInstanceOf(RefPoolService);
    expect(service.getStats().keys).toBe(0);
    expect(moduleRef.get(REFPOOL_OPTIONS)).toBeDefined();

    await moduleRef.close();
  });

  it('starts and warms on init, then stops on shutdown', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RefPoolModule.forRoot(makeOptions({ prewarm: { keys: ['tenant-a'] } }))],
    }).compile();

    const service = moduleRef.get(RefPoolService);
    const startSpy = vi.spyOn(service.pool, 'start');
    const warmSpy = vi.spyOn(service.pool, 'warm');
    const stopSpy = vi.spyOn(service.pool, 'stop');

    await moduleRef.init();
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(warmSpy).toHaveBeenCalledTimes(1);

    await moduleRef.close();
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });

  it('does not warm when no prewarm and warmOnInit unset', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RefPoolModule.forRoot(makeOptions())],
    }).compile();

    const service = moduleRef.get(RefPoolService);
    const warmSpy = vi.spyOn(service.pool, 'warm');

    await moduleRef.init();
    expect(warmSpy).not.toHaveBeenCalled();

    await moduleRef.close();
  });

  it('withResource acquires and releases around the callback', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [RefPoolModule.forRoot(makeOptions())],
    }).compile();
    const service = moduleRef.get<RefPoolService<FakeConn>>(RefPoolService);

    const result = await service.withResource('tenant-x', (conn) => conn.id);
    expect(result).toBe('tenant-x');
    expect(service.getStats().idle).toBe(1);

    await moduleRef.close();
  });
});

describe('RefPoolModule.forRootAsync', () => {
  it('resolves options via useFactory', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        RefPoolModule.forRootAsync<FakeConn>({
          useFactory: () => makeOptions({ max: 3 }),
        }),
      ],
    }).compile();

    const service = moduleRef.get(RefPoolService);
    expect(service).toBeInstanceOf(RefPoolService);

    await moduleRef.close();
  });
});
