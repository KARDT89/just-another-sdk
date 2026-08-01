import { createEventId } from '../util/id.js'
import type { AgentEvent, EventListener } from './events.js'

/**
 * The run's event bus.
 *
 * Two properties matter and are both deliberate:
 *
 *   • **A listener can never break a run.** Handlers are invoked inside a
 *     try/catch and their exceptions are swallowed. Instrumentation is not
 *     allowed to change program behaviour.
 *
 *   • **Emitting is synchronous.** The loop never awaits a listener, so adding
 *     logging or tracing cannot slow down or reorder the agent's work.
 *
 * `id` and `timestamp` are stamped here so call sites stay terse and every event
 * is guaranteed to carry them.
 */
export class EventEmitter {
  private readonly listeners: EventListener[] = []

  constructor(listener?: EventListener) {
    if (listener) this.listeners.push(listener)
  }

  /** Registers a listener. Returns a function that removes it. */
  on(listener: EventListener): () => void {
    this.listeners.push(listener)
    return () => {
      const index = this.listeners.indexOf(listener)
      if (index !== -1) this.listeners.splice(index, 1)
    }
  }

  get listenerCount(): number {
    return this.listeners.length
  }

  /**
   * Emits an event, stamping `id` and `timestamp`.
   *
   * Returns the completed event so callers can also record it (the runner keeps
   * the sequence for the final `RunResult`).
   */
  emit(event: DraftEvent): AgentEvent {
    const complete = {
      ...event,
      id: createEventId(),
      timestamp: Date.now(),
    } as AgentEvent

    for (const listener of this.listeners) {
      try {
        listener(complete)
      } catch {
        // A broken listener is the listener's problem, not the run's.
      }
    }

    return complete
  }
}

/** An event minus the fields the emitter stamps on. */
export type DraftEvent = DistributiveOmit<AgentEvent, 'id' | 'timestamp'>

/**
 * `Omit` applied to each union member separately. Plain `Omit<Union, K>` would
 * collapse the union into a single object type and lose the `type` discriminant.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
