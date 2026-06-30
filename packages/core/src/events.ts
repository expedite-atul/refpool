import type { PoolEvent, PoolEventType } from './types.js';

type EventByType<K extends PoolEventType> = Extract<PoolEvent, { type: K }>;
type Listener<E> = (event: E) => void;

/**
 * A dependency-free, fully type-inferred event emitter keyed by `PoolEvent['type']`.
 * Listeners registered for a given type receive the precisely-narrowed payload.
 */
export class TypedEventEmitter {
  private readonly listeners = new Map<PoolEventType, Set<Listener<PoolEvent>>>();

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
    for (const listener of [...set]) listener(event);
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
