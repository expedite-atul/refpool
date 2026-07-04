import type { PoolEvent, PoolEventType } from './types.js';

type EventByType<K extends PoolEventType> = Extract<PoolEvent, { type: K }>;
type Listener<E> = (event: E) => void;

/** Notified when a listener throws, so the emitter never propagates listener errors. */
type ErrorSink = (error: unknown, type: PoolEventType) => void;

/**
 * A dependency-free, fully type-inferred event emitter keyed by `PoolEvent['type']`.
 * Listeners registered for a given type receive the precisely-narrowed payload.
 *
 * Listener exceptions are isolated: one throwing listener never stops the others
 * and is never propagated to the emitting call site (which is often an internal
 * lifecycle step such as `dispose()`). Throws are routed to the optional error
 * sink instead.
 */
export class TypedEventEmitter {
  private readonly listeners = new Map<PoolEventType, Set<Listener<PoolEvent>>>();

  constructor(private readonly onError?: ErrorSink) {}

  on<K extends PoolEventType>(type: K, listener: Listener<EventByType<K>>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<PoolEvent>);
    return () => {
      this.off(type, listener);
    };
  }

  off<K extends PoolEventType>(type: K, listener: Listener<EventByType<K>>): void {
    this.listeners.get(type)?.delete(listener as Listener<PoolEvent>);
  }

  emit(event: PoolEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (error) {
        this.onError?.(error, event.type);
      }
    }
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
