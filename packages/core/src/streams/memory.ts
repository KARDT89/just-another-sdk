import type { AgentEvent } from '../events/events.js'
import type { StreamOutcome, StreamStatus, StreamStore } from './store.js'

export interface MemoryStreamStoreOptions {
  /**
   * How many streams to keep before evicting the least recently written.
   * Default 1000.
   */
  readonly maxStreams?: number
}

const DEFAULT_MAX_STREAMS = 1000

interface Recorded {
  events: AgentEvent[]
  done: boolean
  outcome?: StreamOutcome
}

/**
 * Resumable streams in memory. The default, and correct for a single process.
 *
 * **Not correct behind a load balancer.** A reconnecting request that lands on a
 * different instance finds nothing, and the client sees an empty stream rather
 * than an error. Use {@link redisStreamStore} the moment there is more than one
 * process.
 *
 * Bounded by stream count, LRU. Streams are minutes-lived, so a cap plus
 * eviction is enough — there is no TTL because nothing here survives a restart
 * anyway.
 */
export function memoryStreamStore(options: MemoryStreamStoreOptions = {}): StreamStore {
  const maxStreams = options.maxStreams ?? DEFAULT_MAX_STREAMS
  const streams = new Map<string, Recorded>()

  const touch = (streamId: string): Recorded => {
    const existing = streams.get(streamId)
    if (existing) {
      streams.delete(streamId)
      streams.set(streamId, existing)
      return existing
    }

    const created: Recorded = { events: [], done: false }
    streams.set(streamId, created)

    while (streams.size > maxStreams) {
      const oldest = streams.keys().next()
      if (oldest.done) break
      streams.delete(oldest.value)
    }

    return created
  }

  /* eslint-disable @typescript-eslint/require-await --
   * Synchronous underneath, but `async` so a bad call fails the same way here as
   * it does in the Redis adapter. */
  return {
    async append(streamId: string, events: readonly AgentEvent[]): Promise<void> {
      if (events.length === 0) return
      touch(streamId).events.push(...events)
    },

    async read(streamId: string, fromIndex: number): Promise<AgentEvent[]> {
      const stored = streams.get(streamId)
      if (!stored) return []
      return stored.events.slice(Math.max(0, fromIndex))
    },

    async finish(streamId: string, outcome: StreamOutcome): Promise<void> {
      const stored = touch(streamId)
      stored.done = true
      stored.outcome = outcome
    },

    async status(streamId: string): Promise<StreamStatus> {
      const stored = streams.get(streamId)
      if (!stored) return { count: 0, done: false }
      return {
        count: stored.events.length,
        done: stored.done,
        ...(stored.outcome ? { outcome: stored.outcome } : {}),
      }
    },
  }
  /* eslint-enable @typescript-eslint/require-await */
}

/**
 * The store used when a resumable run is started but the agent configures none —
 * one per agent, created on first use.
 *
 * Keyed on the config object by identity, as {@link defaultSessionStore} is, so
 * two agents never see each other's streams and the store is collected with the
 * agent.
 *
 * @internal
 */
export function defaultStreamStore(owner: object): StreamStore {
  const existing = defaultStores.get(owner)
  if (existing) return existing

  const created = memoryStreamStore()
  defaultStores.set(owner, created)
  return created
}

const defaultStores = new WeakMap<object, StreamStore>()
