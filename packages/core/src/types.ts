export type BreakerState = 'closed' | 'open' | 'half-open';

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Guards resource creation. Implementations decide whether a creation attempt
 * may proceed and observe its success/failure to drive their state machine.
 */
export interface CircuitBreaker {
  readonly state: BreakerState;
  exec<T>(fn: () => Promise<T>): Promise<T>;
  /** Subscribe to state transitions. Returns an unsubscribe function. */
  onStateChange?(listener: (state: BreakerState) => void): () => void;
}

/** Describes which keys to pre-create (and how many holders per key) on `warm()`. */
export interface PrewarmStrategy<T = unknown> {
  keys: string[] | (() => string[] | Promise<string[]>);
  perKey?: number;
  /** Phantom marker so the strategy can be parameterized by the pooled type. */
  readonly __resource?: T;
}

interface PoolEventBase {
  key?: string;
  timestamp: number;
}

export interface AcquireEvent extends PoolEventBase {
  type: 'acquire';
  key: string;
  refCount: number;
}
export interface ReleaseEvent extends PoolEventBase {
  type: 'release';
  key: string;
  refCount: number;
}
export interface CreateEvent extends PoolEventBase {
  type: 'create';
  key: string;
}
export interface DisposeEvent extends PoolEventBase {
  type: 'dispose';
  key: string;
}
export interface EvictEvent extends PoolEventBase {
  type: 'evict';
  key: string;
  reason: 'lru' | 'ttl' | 'drain';
}
export interface IdleSweepEvent extends PoolEventBase {
  type: 'idle-sweep';
  swept: number;
}
export interface BreakerOpenEvent extends PoolEventBase {
  type: 'breaker-open';
}
export interface BreakerCloseEvent extends PoolEventBase {
  type: 'breaker-close';
}
export interface BreakerHalfOpenEvent extends PoolEventBase {
  type: 'breaker-half-open';
}
export interface DrainStartEvent extends PoolEventBase {
  type: 'drain-start';
}
export interface DrainCompleteEvent extends PoolEventBase {
  type: 'drain-complete';
}
export interface OrphanResurrectEvent extends PoolEventBase {
  type: 'orphan-resurrect';
  key: string;
}
export interface StatsEvent extends PoolEventBase {
  type: 'stats';
  stats: PoolStats;
}

export type PoolEvent =
  | AcquireEvent
  | ReleaseEvent
  | CreateEvent
  | DisposeEvent
  | EvictEvent
  | IdleSweepEvent
  | BreakerOpenEvent
  | BreakerCloseEvent
  | BreakerHalfOpenEvent
  | DrainStartEvent
  | DrainCompleteEvent
  | OrphanResurrectEvent
  | StatsEvent;

export type PoolEventType = PoolEvent['type'];

export interface PoolStats {
  /** Distinct keys currently held in the live pool. */
  keys: number;
  /** Total undisposed resources (live pool + orphaned-but-still-held). */
  live: number;
  /** Live resources at refcount 0 (reclaimable). */
  idle: number;
  /** Live resources with at least one holder (plus orphans, which are always held). */
  inUse: number;
  /** Acquire calls currently blocked on resource creation. */
  waiters: number;
  created: number;
  disposed: number;
  evicted: number;
  hits: number;
  misses: number;
  /** Cumulative count of breaker transitions into each state. */
  breaker: Record<BreakerState, number>;
}

export interface PoolOptions<T> {
  /** Creates the resource for a key. Invoked at most once per live key. */
  factory: (key: string) => Promise<T>;
  /** Tears the resource down. Invoked at most once per resource. */
  dispose?: (resource: T, key: string) => Promise<void> | void;
  /** Upper bound on live keyed resources. Idle resources are evicted to honor it. */
  max: number;
  /** Reclaim idle resources untouched for at least this long. */
  idleTtlMs?: number;
  /** Drop unused per-key mutex cells older than this to bound memory. */
  mutexGcMs?: number;
  logger?: Logger;
  /** Shared breaker, or a factory invoked once per key for per-key breakers. */
  breaker?: CircuitBreaker | (() => CircuitBreaker);
  prewarm?: PrewarmStrategy<T>;
  /** Emit a `stats` event and a `[POOL_STATS]` log line on this cadence. */
  statsIntervalMs?: number;
  /** Validate an idle resource before reuse; falsy result triggers recreation. */
  validate?: (resource: T) => boolean | Promise<boolean>;
}

export interface AcquireHandle<T> {
  resource: T;
  /** Release this holder's reference. Idempotent. */
  release: () => void;
}
