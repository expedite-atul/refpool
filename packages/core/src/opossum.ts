import type { BreakerState, CircuitBreaker } from './types.js';

/** Subset of opossum's constructor options most relevant to pooling. */
export interface OpossumBreakerOptions {
  timeout?: number | false;
  errorThresholdPercentage?: number;
  resetTimeout?: number;
  rollingCountTimeout?: number;
  rollingCountBuckets?: number;
  volumeThreshold?: number;
  name?: string;
  [option: string]: unknown;
}

interface OpossumInstance {
  readonly opened: boolean;
  readonly halfOpen: boolean;
  fire(...args: unknown[]): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

type OpossumCtor = new (
  action: (...args: unknown[]) => Promise<unknown>,
  options?: OpossumBreakerOptions,
) => OpossumInstance;

/**
 * Adapts the optional `opossum` peer dependency to the `CircuitBreaker`
 * interface. `opossum` is imported lazily on first `exec`, so importing this
 * module never hard-requires it at evaluation time.
 */
export function createOpossumBreaker(options: OpossumBreakerOptions = {}): CircuitBreaker {
  let instance: OpossumInstance | undefined;
  let instancePromise: Promise<OpossumInstance> | undefined;
  const listeners = new Set<(state: BreakerState) => void>();

  const stateOf = (i: OpossumInstance | undefined): BreakerState => {
    if (!i) return 'closed';
    if (i.opened) return 'open';
    if (i.halfOpen) return 'half-open';
    return 'closed';
  };

  const notify = (state: BreakerState): void => {
    for (const listener of [...listeners]) listener(state);
  };

  const ensure = async (): Promise<OpossumInstance> => {
    if (instance) return instance;
    if (!instancePromise) {
      instancePromise = import('opossum').then((mod) => {
        const namespace = mod as unknown as { default?: OpossumCtor };
        const Ctor = namespace.default ?? (mod as unknown as OpossumCtor);
        const created = new Ctor((fn) => (fn as () => Promise<unknown>)(), options);
        created.on('open', () => notify('open'));
        created.on('close', () => notify('closed'));
        created.on('halfOpen', () => notify('half-open'));
        instance = created;
        return created;
      });
    }
    return instancePromise;
  };

  return {
    get state(): BreakerState {
      return stateOf(instance);
    },
    async exec<T>(fn: () => Promise<T>): Promise<T> {
      const breaker = await ensure();
      return (await breaker.fire(fn)) as T;
    },
    onStateChange(listener: (state: BreakerState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
