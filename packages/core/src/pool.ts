import { TypedEventEmitter } from './events.js';
import { noopBreaker } from './breakers.js';
import {
  noopLogger,
  type AcquireHandle,
  type BreakerState,
  type CircuitBreaker,
  type Logger,
  type PoolEvent,
  type PoolEventType,
  type PoolOptions,
  type PoolStats,
  type PrewarmStrategy,
} from './types.js';

interface Entry<T> {
  key: string;
  resource: T;
  refCount: number;
  lastReleasedAt: number;
  /** Monotonic release order, used for deterministic LRU selection. */
  lastReleasedSeq: number;
  /** Captured by a drain; disposed the moment refcount returns to 0. */
  condemned: boolean;
  disposed: boolean;
  disposing?: Promise<void>;
  disposeWaiters: Array<() => void>;
}

interface MutexCell {
  tail: Promise<unknown>;
  pending: number;
  lastUsed: number;
}

type Counters = {
  created: number;
  disposed: number;
  evicted: number;
  hits: number;
  misses: number;
  breaker: Record<BreakerState, number>;
};

type Timer = ReturnType<typeof setInterval>;

/**
 * A keyed, reference-counted, bounded LRU resource pool.
 *
 * Acquire returns a handle whose `release()` drops exactly that holder's
 * reference; this is the canonical API (it stays correct across eviction and
 * orphan handoff). `release(key)` is a convenience that drops one reference
 * from the live (or orphaned) resource for a key.
 */
export class RefCountedLruPool<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly orphans = new Map<string, Entry<T>>();
  private readonly mutexes = new Map<string, MutexCell>();
  private readonly pending = new Map<string, number>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly emitter = new TypedEventEmitter();

  private readonly logger: Logger;
  private readonly max: number;
  private readonly idleTtlMs?: number;
  private readonly mutexGcMs?: number;
  private readonly statsIntervalMs?: number;

  private sharedBreaker?: CircuitBreaker;
  private breakerFactory?: () => CircuitBreaker;

  private sweepTimer?: Timer;
  private mutexTimer?: Timer;
  private statsTimer?: Timer;
  private started = false;
  private waiting = 0;
  private seq = 0;

  private readonly counters: Counters = {
    created: 0,
    disposed: 0,
    evicted: 0,
    hits: 0,
    misses: 0,
    breaker: { closed: 0, open: 0, 'half-open': 0 },
  };

  constructor(private readonly options: PoolOptions<T>) {
    this.logger = options.logger ?? noopLogger;
    this.max = options.max;
    this.idleTtlMs = options.idleTtlMs;
    this.mutexGcMs = options.mutexGcMs;
    this.statsIntervalMs = options.statsIntervalMs;

    const breaker = options.breaker;
    if (typeof breaker === 'function') {
      this.breakerFactory = breaker;
    } else {
      this.sharedBreaker = breaker ?? noopBreaker;
      this.wireBreaker(this.sharedBreaker, undefined);
    }
  }

  on<K extends PoolEventType>(
    type: K,
    listener: (event: Extract<PoolEvent, { type: K }>) => void,
  ): () => void {
    return this.emitter.on(type, listener);
  }

  off<K extends PoolEventType>(
    type: K,
    listener: (event: Extract<PoolEvent, { type: K }>) => void,
  ): void {
    this.emitter.off(type, listener);
  }

  async acquire(key: string): Promise<AcquireHandle<T>> {
    this.incPending(key);
    try {
      const fast = this.entries.get(key);
      if (fast && !fast.disposed && fast.refCount > 0) {
        this.counters.hits += 1;
        return this.checkout(fast);
      }

      this.waiting += 1;
      let entry: Entry<T>;
      try {
        entry = await this.runExclusive(key, () => this.obtain(key));
      } finally {
        this.waiting -= 1;
      }
      return this.checkout(entry);
    } finally {
      this.decPending(key);
    }
  }

  release(key: string): void {
    const entry = this.entries.get(key) ?? this.orphans.get(key);
    if (entry) this.releaseEntry(entry);
  }

  getStats(): PoolStats {
    let idle = 0;
    let inUse = 0;
    for (const entry of this.entries.values()) {
      if (entry.refCount > 0) inUse += 1;
      else idle += 1;
    }
    inUse += this.orphans.size;
    return {
      keys: this.entries.size,
      live: this.entries.size + this.orphans.size,
      idle,
      inUse,
      waiters: this.waiting,
      created: this.counters.created,
      disposed: this.counters.disposed,
      evicted: this.counters.evicted,
      hits: this.counters.hits,
      misses: this.counters.misses,
      breaker: { ...this.counters.breaker },
    };
  }

  async warm(strategy: PrewarmStrategy<T> | undefined = this.options.prewarm): Promise<void> {
    if (!strategy) return;
    const keys = typeof strategy.keys === 'function' ? await strategy.keys() : strategy.keys;
    const perKey = Math.max(1, strategy.perKey ?? 1);
    await Promise.all(
      keys.map(async (key) => {
        const handles = await Promise.all(
          Array.from({ length: perKey }, () => this.acquire(key)),
        );
        for (const handle of handles) handle.release();
      }),
    );
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.idleTtlMs && this.idleTtlMs > 0) {
      this.sweepTimer = this.makeInterval(() => this.sweep(), this.idleTtlMs);
    }
    if (this.mutexGcMs && this.mutexGcMs > 0) {
      this.mutexTimer = this.makeInterval(() => this.gcMutexes(), this.mutexGcMs);
    }
    if (this.statsIntervalMs && this.statsIntervalMs > 0) {
      this.statsTimer = this.makeInterval(() => this.emitStats(), this.statsIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.stopTimers();
    await this.drain();
  }

  async drain(): Promise<void> {
    this.stopTimers();
    this.emit({ type: 'drain-start', timestamp: this.now() });
    const waits: Array<Promise<void>> = [];

    for (const entry of [...this.entries.values()]) {
      this.entries.delete(entry.key);
      if (entry.refCount === 0) {
        waits.push(this.dispose(entry));
      } else {
        entry.condemned = true;
        this.orphans.set(entry.key, entry);
        this.counters.evicted += 1;
        this.emit({ type: 'evict', key: entry.key, reason: 'drain', timestamp: this.now() });
        waits.push(this.awaitDisposal(entry));
      }
    }

    for (const entry of [...this.orphans.values()]) {
      entry.condemned = true;
      waits.push(this.awaitDisposal(entry));
    }

    await Promise.all(waits);
    this.emit({ type: 'drain-complete', timestamp: this.now() });
  }

  private checkout(entry: Entry<T>): AcquireHandle<T> {
    entry.refCount += 1;
    this.emit({ type: 'acquire', key: entry.key, refCount: entry.refCount, timestamp: this.now() });
    let released = false;
    return {
      resource: entry.resource,
      release: () => {
        if (released) return;
        released = true;
        this.releaseEntry(entry);
      },
    };
  }

  private releaseEntry(entry: Entry<T>): void {
    if (entry.disposed) return;
    if (entry.refCount > 0) entry.refCount -= 1;
    this.emit({ type: 'release', key: entry.key, refCount: entry.refCount, timestamp: this.now() });
    if (entry.refCount !== 0) return;

    entry.lastReleasedAt = this.now();
    entry.lastReleasedSeq = (this.seq += 1);
    if (entry.condemned || this.orphans.get(entry.key) === entry) {
      this.removeEntry(entry);
      void this.dispose(entry);
    } else {
      this.enforceMax();
    }
  }

  private async obtain(key: string): Promise<Entry<T>> {
    const live = this.entries.get(key);
    if (live && !live.disposed) {
      if (live.refCount === 0 && this.options.validate) {
        const ok = await this.options.validate(live.resource);
        if (!ok) {
          this.removeEntry(live);
          await this.dispose(live);
        } else {
          this.counters.hits += 1;
          return live;
        }
      } else {
        this.counters.hits += 1;
        return live;
      }
    }

    const orphan = this.orphans.get(key);
    if (orphan && !orphan.disposed) {
      this.orphans.delete(key);
      this.entries.set(key, orphan);
      this.counters.hits += 1;
      this.emit({ type: 'orphan-resurrect', key, timestamp: this.now() });
      return orphan;
    }

    this.counters.misses += 1;
    const breaker = this.resolveBreaker(key);
    const resource = await breaker.exec(() => this.options.factory(key));
    const entry: Entry<T> = {
      key,
      resource,
      refCount: 0,
      lastReleasedAt: this.now(),
      lastReleasedSeq: 0,
      condemned: false,
      disposed: false,
      disposeWaiters: [],
    };
    this.entries.set(key, entry);
    this.counters.created += 1;
    this.emit({ type: 'create', key, timestamp: this.now() });
    this.enforceMax();
    return entry;
  }

  private enforceMax(): void {
    if (this.max <= 0) return;
    while (this.entries.size > this.max) {
      const victim = this.pickLruIdle();
      if (!victim) break;
      this.entries.delete(victim.key);
      this.counters.evicted += 1;
      this.emit({ type: 'evict', key: victim.key, reason: 'lru', timestamp: this.now() });
      void this.dispose(victim);
    }
  }

  private pickLruIdle(): Entry<T> | undefined {
    let victim: Entry<T> | undefined;
    for (const entry of this.entries.values()) {
      if (entry.refCount !== 0 || entry.condemned || entry.disposed) continue;
      if (this.isPending(entry.key)) continue;
      if (!victim || entry.lastReleasedSeq < victim.lastReleasedSeq) victim = entry;
    }
    return victim;
  }

  private sweep(): void {
    if (!this.idleTtlMs) return;
    const cutoff = this.now() - this.idleTtlMs;
    let swept = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.refCount !== 0 || entry.condemned || entry.disposed) continue;
      if (this.isPending(entry.key)) continue;
      if (entry.lastReleasedAt > cutoff) continue;
      this.entries.delete(entry.key);
      this.counters.evicted += 1;
      this.emit({ type: 'evict', key: entry.key, reason: 'ttl', timestamp: this.now() });
      void this.dispose(entry);
      swept += 1;
    }
    if (swept > 0) this.emit({ type: 'idle-sweep', swept, timestamp: this.now() });
  }

  private dispose(entry: Entry<T>): Promise<void> {
    if (entry.disposed) return Promise.resolve();
    if (entry.disposing) return entry.disposing;
    entry.disposing = (async () => {
      try {
        await this.options.dispose?.(entry.resource, entry.key);
      } catch (error) {
        this.logger.error('refpool: dispose failed', {
          key: entry.key,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        entry.disposed = true;
        this.counters.disposed += 1;
        this.emit({ type: 'dispose', key: entry.key, timestamp: this.now() });
        const waiters = entry.disposeWaiters;
        entry.disposeWaiters = [];
        for (const resolve of waiters) resolve();
      }
    })();
    return entry.disposing;
  }

  private awaitDisposal(entry: Entry<T>): Promise<void> {
    if (entry.disposed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      entry.disposeWaiters.push(resolve);
    });
  }

  private removeEntry(entry: Entry<T>): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (this.orphans.get(entry.key) === entry) this.orphans.delete(entry.key);
  }

  private resolveBreaker(key: string): CircuitBreaker {
    if (this.breakerFactory) {
      let breaker = this.breakers.get(key);
      if (!breaker) {
        breaker = this.breakerFactory();
        this.breakers.set(key, breaker);
        this.wireBreaker(breaker, key);
      }
      return breaker;
    }
    return this.sharedBreaker ?? noopBreaker;
  }

  private wireBreaker(breaker: CircuitBreaker, key: string | undefined): void {
    breaker.onStateChange?.((state) => {
      this.counters.breaker[state] += 1;
      const timestamp = this.now();
      if (state === 'open') this.emit({ type: 'breaker-open', key, timestamp });
      else if (state === 'closed') this.emit({ type: 'breaker-close', key, timestamp });
      else this.emit({ type: 'breaker-half-open', key, timestamp });
    });
  }

  private runExclusive<R>(key: string, fn: () => Promise<R>): Promise<R> {
    let cell = this.mutexes.get(key);
    if (!cell) {
      cell = { tail: Promise.resolve(), pending: 0, lastUsed: this.now() };
      this.mutexes.set(key, cell);
    }
    cell.pending += 1;
    cell.lastUsed = this.now();
    const result = cell.tail.then(fn, fn);
    cell.tail = result.then(
      () => undefined,
      () => undefined,
    );
    const settled = (): void => {
      cell.pending -= 1;
      cell.lastUsed = this.now();
    };
    void result.then(settled, settled);
    return result;
  }

  private gcMutexes(): void {
    if (!this.mutexGcMs) return;
    const cutoff = this.now() - this.mutexGcMs;
    for (const [key, cell] of [...this.mutexes]) {
      if (cell.pending === 0 && cell.lastUsed <= cutoff) this.mutexes.delete(key);
    }
  }

  private emitStats(): void {
    const stats = this.getStats();
    this.emit({ type: 'stats', timestamp: this.now(), stats });
    this.logger.info(`[POOL_STATS] ${JSON.stringify(stats)}`);
  }

  private makeInterval(fn: () => void, ms: number): Timer {
    const timer = setInterval(fn, ms);
    (timer as { unref?: () => void }).unref?.();
    return timer;
  }

  private stopTimers(): void {
    this.started = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.mutexTimer) clearInterval(this.mutexTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.sweepTimer = undefined;
    this.mutexTimer = undefined;
    this.statsTimer = undefined;
  }

  private incPending(key: string): void {
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
  }

  private decPending(key: string): void {
    const next = (this.pending.get(key) ?? 0) - 1;
    if (next <= 0) this.pending.delete(key);
    else this.pending.set(key, next);
  }

  private isPending(key: string): boolean {
    return (this.pending.get(key) ?? 0) > 0;
  }

  private emit(event: PoolEvent): void {
    this.emitter.emit(event);
  }

  private now(): number {
    return Date.now();
  }
}
