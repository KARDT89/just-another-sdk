import type { ModelMessage } from '../types/messages.js'
import { assertValidSessionId, type LoadOptions, type SessionStore } from './store.js'

export interface MemorySessionOptions {
  /**
   * How many distinct sessions to keep before evicting the least recently used.
   * Default 1000.
   */
  readonly maxSessions?: number

  /**
   * How many messages to keep per session before dropping the oldest.
   * Default 200.
   */
  readonly maxMessagesPerSession?: number
}

const DEFAULT_MAX_SESSIONS = 1000
const DEFAULT_MAX_MESSAGES = 200

/**
 * Conversations in a `Map`. The default when you pass a `sessionId` without
 * configuring a store.
 *
 * ```ts
 * const agent = new Agent({ name: 'chat', model, session: memorySession() })
 * ```
 *
 * **Bounded on purpose.** An unbounded map keyed by user id is a memory leak
 * with a slow fuse, and the leak only shows up in production. Both limits are
 * adjustable, and both evict silently — cross the message cap and a `session.load`
 * event reports the shortfall.
 *
 * Process-local, so it does not survive a restart and is not shared between
 * instances. Use {@link fileSession}, {@link sqliteSession}, {@link redisSession},
 * or {@link postgresSession} when either matters.
 */
export function memorySession(options: MemorySessionOptions = {}): SessionStore {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS
  const maxMessages = options.maxMessagesPerSession ?? DEFAULT_MAX_MESSAGES

  // `Map` iterates in insertion order, which is all an LRU needs: delete on
  // touch, re-insert, and the oldest key is always the first one.
  const sessions = new Map<string, ModelMessage[]>()

  const touch = (sessionId: string): ModelMessage[] => {
    const existing = sessions.get(sessionId)
    if (existing) {
      sessions.delete(sessionId)
      sessions.set(sessionId, existing)
      return existing
    }

    const created: ModelMessage[] = []
    sessions.set(sessionId, created)

    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next()
      if (oldest.done) break
      sessions.delete(oldest.value)
    }

    return created
  }

  /* eslint-disable @typescript-eslint/require-await --
   * Every operation here is synchronous, but the methods stay `async` on
   * purpose: dropping it would make this the one adapter that *throws* on a bad
   * session id while the rest reject. A contract that fails two different ways
   * depending on the backend is worse than an await-less async function. */
  return {
    async load(sessionId: string, options?: LoadOptions): Promise<ModelMessage[]> {
      assertValidSessionId(sessionId)
      const stored = sessions.get(sessionId)
      if (!stored) return []
      touch(sessionId)
      const limit = options?.limit
      return limit !== undefined && limit < stored.length ? stored.slice(-limit) : [...stored]
    },

    async append(sessionId: string, messages: readonly ModelMessage[]): Promise<void> {
      assertValidSessionId(sessionId)
      if (messages.length === 0) return
      const stored = touch(sessionId)
      stored.push(...messages)
      if (stored.length > maxMessages) stored.splice(0, stored.length - maxMessages)
    },

    async clear(sessionId: string): Promise<void> {
      assertValidSessionId(sessionId)
      sessions.delete(sessionId)
    },

    async pop(sessionId: string): Promise<ModelMessage | undefined> {
      assertValidSessionId(sessionId)
      const stored = sessions.get(sessionId)
      if (!stored || stored.length === 0) return undefined
      touch(sessionId)
      return stored.pop()
    },
  }
  /* eslint-enable @typescript-eslint/require-await */
}

/**
 * The store used when a run supplies a `sessionId` but the agent configures no
 * store — one per agent, created on first use.
 *
 * Keyed on the config object by identity, which is exactly the granularity we
 * want: an `Agent` holds one config for its lifetime, so its sessions are its
 * own, and two agents never see each other's conversations. A `WeakMap` means
 * the store is collected with the agent.
 *
 * @internal
 */
export function defaultSessionStore(owner: object): SessionStore {
  const existing = defaultStores.get(owner)
  if (existing) return existing

  const created = memorySession()
  defaultStores.set(owner, created)
  return created
}

const defaultStores = new WeakMap<object, SessionStore>()
