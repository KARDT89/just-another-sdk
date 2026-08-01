import type { AgentEvent, AgentEventType, EventOfType } from '../events/events.js'

/**
 * Records the events of a run so a test can assert on what the agent *did*, not
 * just what it returned. Ordering assertions are the cheapest way to catch a
 * regression in the loop.
 */
export interface EventCollector {
  /** Pass to `run({ onEvent })`. */
  readonly listener: (event: AgentEvent) => void
  /** Every event, in emission order. */
  readonly events: readonly AgentEvent[]
  /** Just the `type` of each event — ideal for a single ordering assertion. */
  types(): readonly AgentEventType[]
  /** All events of one type, narrowed. */
  ofType<T extends AgentEventType>(type: T): readonly EventOfType<T>[]
  /** The first event of one type, narrowed. */
  first<T extends AgentEventType>(type: T): EventOfType<T> | undefined
  /** The last event of one type, narrowed. */
  last<T extends AgentEventType>(type: T): EventOfType<T> | undefined
  count(type: AgentEventType): number
  clear(): void
}

/**
 * ```ts
 * const collected = collectEvents()
 * await agent.run('hi', { onEvent: collected.listener })
 *
 * expect(collected.types()).toEqual([
 *   'run.start', 'model.request', 'model.response', 'run.finish',
 * ])
 * ```
 */
export function collectEvents(): EventCollector {
  const events: AgentEvent[] = []

  return {
    listener: (event: AgentEvent) => {
      events.push(event)
    },
    events,
    types: () => events.map((event) => event.type),
    ofType: <T extends AgentEventType>(type: T) =>
      events.filter((event): event is EventOfType<T> => event.type === type),
    first: <T extends AgentEventType>(type: T) =>
      events.find((event): event is EventOfType<T> => event.type === type),
    last: <T extends AgentEventType>(type: T) =>
      [...events].reverse().find((event): event is EventOfType<T> => event.type === type),
    count: (type: AgentEventType) => events.filter((event) => event.type === type).length,
    clear: () => {
      events.length = 0
    },
  }
}
