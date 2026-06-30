import { describe, expect, it, vi } from 'vitest';
import { TypedEventEmitter } from './events.js';

describe('TypedEventEmitter', () => {
  it('delivers correctly-typed payloads to listeners', () => {
    const emitter = new TypedEventEmitter();
    const seen: number[] = [];

    emitter.on('acquire', (event) => {
      // event is narrowed to AcquireEvent; refCount is a number
      seen.push(event.refCount);
    });

    emitter.emit({ type: 'acquire', key: 'a', refCount: 3, timestamp: 1 });
    emitter.emit({ type: 'release', key: 'a', refCount: 2, timestamp: 2 });

    expect(seen).toEqual([3]);
  });

  it('supports off() and the returned unsubscribe handle', () => {
    const emitter = new TypedEventEmitter();
    const a = vi.fn();
    const b = vi.fn();

    const unsubscribe = emitter.on('create', a);
    emitter.on('create', b);

    emitter.emit({ type: 'create', key: 'k', timestamp: 1 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    unsubscribe();
    emitter.off('create', b);
    emitter.emit({ type: 'create', key: 'k', timestamp: 2 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
