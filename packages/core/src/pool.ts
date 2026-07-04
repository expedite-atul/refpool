import { TypedEventEmitter } from './events.js';
import { noopBreaker } from './breakers.js';
import { AcquireTimeoutError, PoolClosedError, PoolExhaustedError } from './errors.js';
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
  /** Captured by a drain; disposed the moment refcount returns to 0. */
  condemned: boolean;
  disposed: boolean;
  disposing?: Promise<void>;
  disposeWaiters: Array<() => void>;
  /**
   * Intrusive doubly-linked "idle list" membership. Invariant:
   * `inIdle === true` ⟺ the entry is in `entries` and `refCount === 0`.
   * `prev`/`next` are only meaningful while `inIdle` is true. The list runs
   * head → tail in ascending release-recency, so the head is the LRU victim.
   */
  inIdle: boolean;
  prev?: Entry<T>;
  next?: Entry<T>;
}

interface MutexCell {
  tail: Promise<unknown>;
  pending: number;
  lastUsed: number;
}

/** A parked `acquire()` waiting for a capacity slot to open up. */
interface CapacityWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
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
 *
 * The acquire / evict / stats hot paths are O(1) in the number of live keys:
 * eviction pops the head of an intrusive idle list, the TTL sweep walks only
 * the expired prefix of that list, and `getStats()` reads maintained counters.
 */
export class RefCountedLruPool<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly orphans = new Map<string, Entry<T>>();
  private readonly mutexes = new Map<string, MutexCell>();
  private readonly pending = new Map<string, number>();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly breakerUnsubs = new Map<string, () => void>();
  private readonly emitter = new TypedEventEmitter((error, type) =>
    this.logger.error('refpool: event listener threw', {
      type,
      error: error instanceof Error ? error.message : String(error),
    }),
  );

  private readonly logger: Logger;
  private readonly max: number;
  private readonly acquireTimeoutMs: number;
  private readonly maxWaiters?: number;
  private readonly idleTtlMs?: number;
  private readonly mutexGcMs?: number;
  private readonly statsIntervalMs?: number;

  private sharedBreaker?: CircuitBreaker;
  private breakerFactory?: () => CircuitBreaker;

  private sweepTimer?: Timer;
  private mutexTimer?: Timer;
  private statsTimer?: Timer;
  private started = false;
  private closed = false;

  // Capacity accounting: `reserved` counts creates that passed the capacity gate
  // but haven't inserted their entry yet, so `entries.size + reserved` never
  // exceeds `max`. Waiters park here until a slot frees (release/dispose/sweep).
  private reserved = 0;
  private readonly capacityWaiters: CapacityWaiter[] = [];

  // Intrusive idle-list endpoints + count (O(1) LRU / stats).
  private idleHead?: Entry<T>;
  private idleTail?: Entry<T>;
  private idleCount = 0;

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
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 30_000;
    this.maxWaiters = options.maxWaiters;
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
      // Fast path: an already-live shared entry never needs a slot or the mutex.
      const fast = this.entries.get(key);
      if (fast && !fast.disposed && fast.refCount > 0) {
        this.counters.hits += 1;
        return this.checkout(fast);
      }

      const entry = await this.runExclusive(key, () => this.obtain(key));
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
    // O(1): `idleCount` is maintained on every refcount transition, so idle and
    // inUse never require a scan of the live map.
    const idle = this.idleCount;
    const inUse = this.entries.size - idle + this.orphans.size;
    return {
      keys: this.entries.size,
      live: this.entries.size + this.orphans.size,
      idle,
      inUse,
      waiters: this.capacityWaiters.length,
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
    // Bound the fan-out so a large key set can't schedule thousands of acquires
    // at once (which would also stampede backpressure); one failing key is
    // isolated and never leaves half-acquired handles unreleased.
    const concurrency = Math.max(1, strategy.concurrency ?? 8);
    const queue = [...keys];
    const worker = async (): Promise<void> => {
      for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
        await this.warmKey(key, perKey);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }

  private async warmKey(key: string, perKey: number): Promise<void> {
    const handles: Array<AcquireHandle<T>> = [];
    try {
      for (let i = 0; i < perKey; i += 1) handles.push(await this.acquire(key));
    } catch (error) {
      this.logger.error('refpool: warm failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Release whatever we managed to acquire, even on a mid-way failure.
      for (const handle of handles) handle.release();
    }
  }

  start(): void {
    // Re-open a pool that was previously stopped/drained.
    this.closed = false;
    if (this.started) return;
    this.started = true;
    if (this.idleTtlMs && this.idleTtlMs > 0) {
      this.sweepTimer = this.makeInterval(() => this.sweep(), this.idleTtlMs);
    }
    if (this.mutexGcMs && this.mutexGcMs > 0) {
      this.mutexTimer = this.makeInterval(() => this.gcKeyState(), this.mutexGcMs);
    }
    if (this.statsIntervalMs && this.statsIntervalMs > 0) {
      this.statsTimer = this.makeInterval(() => this.emitStats(), this.statsIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.setClosed();
    this.stopTimers();
    await this.drain();
  }

  async drain(): Promise<void> {
    // Close first: reject parked waiters and stop new keys from being created
    // (so an acquire racing the drain can't leak a resource past shutdown).
    this.setClosed();
    this.stopTimers();
    this.emit({ type: 'drain-start', timestamp: this.now() });
    const waits: Array<Promise<void>> = [];

    for (const entry of [...this.entries.values()]) {
      this.entries.delete(entry.key);
      if (entry.refCount === 0) {
        this.idleRemove(entry);
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

    // Every idle entry has been removed above; reset the list defensively.
    this.idleHead = undefined;
    this.idleTail = undefined;
    this.idleCount = 0;

    await Promise.all(waits);
    this.emit({ type: 'drain-complete', timestamp: this.now() });
  }

  private checkout(entry: Entry<T>): AcquireHandle<T> {
    if (entry.refCount === 0) this.idleRemove(entry);
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

  /**
   * Drop one reference. Cross-holder hazard: `release(key)` (unlike a handle's
   * `release()`) can't tell whose reference it drops, so calling it more times
   * than you hold handles would corrupt the count — always prefer the handle's
   * `release()`. This guard makes an already-idle (`refCount === 0`) release a
   * true no-op: no spurious event, no `lastReleasedAt` re-stamp, no LRU reorder,
   * and the count can never fall below zero.
   */
  private releaseEntry(entry: Entry<T>): void {
    if (entry.disposed) return;
    if (entry.refCount === 0) return;
    entry.refCount -= 1;
    this.emit({ type: 'release', key: entry.key, refCount: entry.refCount, timestamp: this.now() });
    if (entry.refCount !== 0) return;

    // Real 1→0 edge only.
    entry.lastReleasedAt = this.now();
    if (entry.condemned || this.orphans.get(entry.key) === entry) {
      this.removeEntry(entry);
      void this.dispose(entry);
    } else {
      this.idleAppend(entry);
      // Now evictable: a waiter blocked for capacity can reclaim this slot.
      this.wakeCapacityWaiter();
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
      // A key is only ever orphaned by `drain()`, which owns its disposal.
      // Resurrection lets an in-flight caller keep using the resource, but the
      // condemnation is intentionally preserved: once the last holder releases,
      // the resource is disposed so the awaiting drain can complete.
      this.orphans.delete(key);
      this.entries.set(key, orphan);
      this.counters.hits += 1;
      this.emit({ type: 'orphan-resurrect', key, timestamp: this.now() });
      return orphan;
    }

    // A miss for a new key: refuse once closed (no leaks past shutdown) and
    // reserve a capacity slot (blocking for one if saturated) before creating.
    if (this.closed) throw new PoolClosedError();
    this.counters.misses += 1;
    await this.acquireSlot(key);

    let resource: T;
    try {
      const breaker = this.resolveBreaker(key);
      resource = await breaker.exec(() => this.options.factory(key));
    } catch (error) {
      this.releaseReservation();
      throw error;
    }

    // The pool may have been drained while the factory was in flight; dispose
    // the fresh resource rather than inserting (and leaking) it.
    if (this.closed) {
      this.releaseReservation();
      await this.disposeOrphaned(resource, key);
      throw new PoolClosedError();
    }

    const entry: Entry<T> = {
      key,
      resource,
      refCount: 0,
      lastReleasedAt: this.now(),
      condemned: false,
      disposed: false,
      disposeWaiters: [],
      inIdle: false,
    };
    this.entries.set(key, entry);
    // Reservation is now backed by a real entry; slot count is unchanged.
    this.reserved -= 1;
    this.idleAppend(entry);
    this.counters.created += 1;
    this.emit({ type: 'create', key, timestamp: this.now() });
    return entry;
  }

  /**
   * Reserve one capacity slot for a new key. Fast when under `max`; otherwise
   * evicts the LRU idle victim to make room, and if none is evictable (every
   * live resource is in use) parks until a release/dispose/sweep frees a slot —
   * bounded by `maxWaiters` (queue length) and `acquireTimeoutMs` (wait time).
   * `max <= 0` disables the bound entirely. Runs under the per-key mutex, so a
   * parked waiter only blocks its own key; other keys' releases still proceed.
   */
  private async acquireSlot(key: string): Promise<void> {
    if (this.max <= 0) return;
    for (;;) {
      if (this.closed) throw new PoolClosedError();
      if (this.entries.size + this.reserved < this.max) {
        this.reserved += 1;
        return;
      }
      const victim = this.takeLruIdle();
      if (victim) {
        this.counters.evicted += 1;
        this.emit({ type: 'evict', key: victim.key, reason: 'lru', timestamp: this.now() });
        void this.dispose(victim);
        this.reserved += 1;
        return;
      }
      await this.waitForCapacity();
    }
  }

  /** Release a reservation that never became an entry, freeing the slot. */
  private releaseReservation(): void {
    this.reserved -= 1;
    this.wakeCapacityWaiter();
  }

  private async disposeOrphaned(resource: T, key: string): Promise<void> {
    try {
      await this.options.dispose?.(resource, key);
    } catch (error) {
      this.logger.error('refpool: dispose failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Park until a capacity slot frees. Enforces `maxWaiters` and `acquireTimeoutMs`. */
  private waitForCapacity(): Promise<void> {
    if (this.closed) return Promise.reject(new PoolClosedError());
    if (this.maxWaiters !== undefined && this.capacityWaiters.length >= this.maxWaiters) {
      return Promise.reject(new PoolExhaustedError());
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: CapacityWaiter = { resolve, reject, settled: false };
      if (Number.isFinite(this.acquireTimeoutMs) && this.acquireTimeoutMs >= 0) {
        waiter.timer = setTimeout(() => {
          this.settleWaiter(waiter, () => reject(new AcquireTimeoutError()));
        }, this.acquireTimeoutMs);
        (waiter.timer as { unref?: () => void }).unref?.();
      }
      this.capacityWaiters.push(waiter);
    });
  }

  /** Wake the oldest waiter (FIFO) so it can retry the slot reservation. */
  private wakeCapacityWaiter(): void {
    const waiter = this.capacityWaiters[0];
    if (!waiter) return;
    this.capacityWaiters.shift();
    this.settleWaiter(waiter, waiter.resolve);
  }

  private settleWaiter(waiter: CapacityWaiter, finish: () => void): void {
    if (waiter.settled) return;
    waiter.settled = true;
    if (waiter.timer) clearTimeout(waiter.timer);
    const index = this.capacityWaiters.indexOf(waiter);
    if (index !== -1) this.capacityWaiters.splice(index, 1);
    finish();
  }

  /**
   * Detach and return the least-recently-released evictable idle entry, skipping
   * any idle key with an in-flight acquire (never yank a resource a waiter is
   * about to reuse). Amortised O(1): pending idle entries are transient and rare.
   */
  private takeLruIdle(): Entry<T> | undefined {
    let node = this.idleHead;
    while (node) {
      const next = node.next;
      if (!this.isPending(node.key)) {
        this.idleRemove(node);
        this.entries.delete(node.key);
        return node;
      }
      node = next;
    }
    return undefined;
  }

  private sweep(): void {
    if (!this.idleTtlMs) return;
    const cutoff = this.now() - this.idleTtlMs;
    let swept = 0;
    // The idle list is release-ordered, so the first entry newer than the cutoff
    // ends the walk — only the expired prefix is ever visited (O(expired)).
    let node = this.idleHead;
    while (node) {
      const next = node.next;
      if (node.lastReleasedAt > cutoff) break;
      if (!this.isPending(node.key)) {
        this.idleRemove(node);
        this.entries.delete(node.key);
        this.counters.evicted += 1;
        this.emit({ type: 'evict', key: node.key, reason: 'ttl', timestamp: this.now() });
        void this.dispose(node);
        // Freed a slot — let a parked acquire create in the vacated capacity.
        this.wakeCapacityWaiter();
        swept += 1;
      }
      node = next;
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
        // A disposed key with no remaining presence no longer needs its per-key
        // breaker; drop it eagerly (correctness doesn't wait for `mutexGcMs`).
        this.dropBreaker(entry.key);
        // Resolve disposal waiters BEFORE emitting so a listener can never
        // wedge a `drain()` awaiting this resource (emit also isolates throws).
        const waiters = entry.disposeWaiters;
        entry.disposeWaiters = [];
        for (const resolve of waiters) resolve();
        this.emit({ type: 'dispose', key: entry.key, timestamp: this.now() });
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
    this.idleRemove(entry);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    if (this.orphans.get(entry.key) === entry) this.orphans.delete(entry.key);
  }

  // --- intrusive idle list ---------------------------------------------------

  /** Append as the most-recently-released (tail). No-op if already listed. */
  private idleAppend(entry: Entry<T>): void {
    if (entry.inIdle) return;
    entry.inIdle = true;
    entry.prev = this.idleTail;
    entry.next = undefined;
    if (this.idleTail) this.idleTail.next = entry;
    else this.idleHead = entry;
    this.idleTail = entry;
    this.idleCount += 1;
  }

  /** Unlink from the idle list. No-op if not listed. */
  private idleRemove(entry: Entry<T>): void {
    if (!entry.inIdle) return;
    entry.inIdle = false;
    const { prev, next } = entry;
    if (prev) prev.next = next;
    else this.idleHead = next;
    if (next) next.prev = prev;
    else this.idleTail = prev;
    entry.prev = undefined;
    entry.next = undefined;
    this.idleCount -= 1;
  }

  // ---------------------------------------------------------------------------

  private resolveBreaker(key: string): CircuitBreaker {
    if (this.breakerFactory) {
      let breaker = this.breakers.get(key);
      if (!breaker) {
        breaker = this.breakerFactory();
        this.breakers.set(key, breaker);
        const unsub = this.wireBreaker(breaker, key);
        if (unsub) this.breakerUnsubs.set(key, unsub);
      }
      return breaker;
    }
    return this.sharedBreaker ?? noopBreaker;
  }

  private wireBreaker(breaker: CircuitBreaker, key: string | undefined): (() => void) | undefined {
    return breaker.onStateChange?.((state) => {
      this.counters.breaker[state] += 1;
      const timestamp = this.now();
      if (state === 'open') this.emit({ type: 'breaker-open', key, timestamp });
      else if (state === 'closed') this.emit({ type: 'breaker-close', key, timestamp });
      else this.emit({ type: 'breaker-half-open', key, timestamp });
    });
  }

  /**
   * Drop a per-key breaker once its key has no live/orphan/pending presence, but
   * only while it's `closed` — an actively-protecting (open / half-open) breaker
   * is preserved so an incident isn't forgotten mid-flight.
   */
  private dropBreaker(key: string): void {
    if (!this.breakerFactory) return;
    const breaker = this.breakers.get(key);
    if (!breaker || breaker.state !== 'closed') return;
    if (this.entries.has(key) || this.orphans.has(key) || this.isPending(key)) return;
    this.breakers.delete(key);
    this.breakerUnsubs.get(key)?.();
    this.breakerUnsubs.delete(key);
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
      // Drop the cell the moment nothing is queued on it; serialization only
      // matters while `pending > 0`, so this can't lose ordering, and it keeps
      // the mutex map bounded without depending on the optional `mutexGcMs` GC.
      if (cell.pending === 0 && this.mutexes.get(key) === cell) this.mutexes.delete(key);
    };
    void result.then(settled, settled);
    return result;
  }

  /**
   * Periodic key-state GC (armed by `mutexGcMs`): drop idle per-key mutex cells,
   * and prune per-key breakers for keys with no live/orphan/pending presence —
   * but only while the breaker is `closed`, so an actively-protecting (open /
   * half-open) breaker is never discarded mid-incident.
   */
  private gcKeyState(): void {
    const now = this.now();
    if (this.mutexGcMs) {
      const cutoff = now - this.mutexGcMs;
      for (const [key, cell] of [...this.mutexes]) {
        if (cell.pending === 0 && cell.lastUsed <= cutoff) this.mutexes.delete(key);
      }
    }
    if (this.breakerFactory && this.breakers.size > 0) {
      for (const key of [...this.breakers.keys()]) this.dropBreaker(key);
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

  /** Mark the pool closed and reject every parked capacity waiter. */
  private setClosed(): void {
    this.closed = true;
    while (this.capacityWaiters.length > 0) {
      const waiter = this.capacityWaiters[0];
      if (!waiter) break;
      this.capacityWaiters.shift();
      this.settleWaiter(waiter, () => waiter.reject(new PoolClosedError()));
    }
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
