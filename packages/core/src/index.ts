export { RefCountedLruPool } from './pool.js';
export { TypedEventEmitter } from './events.js';
export {
  InMemoryCircuitBreaker,
  CircuitOpenError,
  noopBreaker,
  type InMemoryCircuitBreakerOptions,
} from './breakers.js';
export { noopLogger } from './types.js';
export { PoolClosedError, AcquireTimeoutError, PoolExhaustedError } from './errors.js';
export type {
  AcquireHandle,
  AcquireEvent,
  BreakerCloseEvent,
  BreakerHalfOpenEvent,
  BreakerOpenEvent,
  BreakerState,
  CircuitBreaker,
  CreateEvent,
  DisposeEvent,
  DrainCompleteEvent,
  DrainStartEvent,
  EvictEvent,
  IdleSweepEvent,
  Logger,
  OrphanResurrectEvent,
  PoolEvent,
  PoolEventType,
  PoolOptions,
  PoolStats,
  PrewarmStrategy,
  ReleaseEvent,
  StatsEvent,
} from './types.js';
