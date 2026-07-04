/**
 * Thrown when `acquire()` is called on a pool that has been shut down via
 * `stop()`/`drain()`. No new keys are created once the pool is closed.
 */
export class PoolClosedError extends Error {
  constructor(message = 'refpool: pool is closed (stop/drain in progress)') {
    super(message);
    this.name = 'PoolClosedError';
  }
}

/**
 * Thrown when an `acquire()` waiting for capacity is not served within
 * `acquireTimeoutMs`. The waiter is removed from the queue before rejecting.
 */
export class AcquireTimeoutError extends Error {
  constructor(message = 'refpool: timed out waiting for pool capacity') {
    super(message);
    this.name = 'AcquireTimeoutError';
  }
}

/**
 * Thrown when the capacity-waiter queue is already at `maxWaiters` and a new
 * `acquire()` would have to wait. Rejects immediately rather than enqueueing.
 */
export class PoolExhaustedError extends Error {
  constructor(message = 'refpool: pool is saturated and the waiter queue is full') {
    super(message);
    this.name = 'PoolExhaustedError';
  }
}
