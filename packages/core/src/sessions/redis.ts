import { ConfigurationError } from '../errors/errors.js'
import type { ModelMessage } from '../types/messages.js'
import { assertValidSessionId, type LoadOptions, type SessionStore } from './store.js'

/**
 * A `node-redis` v4+ client, structurally. Camel-cased command names.
 *
 * Declared here rather than imported so `redis` never becomes a dependency —
 * not even an optional peer.
 */
export interface NodeRedisLike {
  rPush(key: string, elements: string[]): Promise<unknown>
  lRange(key: string, start: number, stop: number): Promise<string[]>
  rPop(key: string): Promise<string | null>
  del(key: string): Promise<unknown>
  expire?(key: string, seconds: number): Promise<unknown>
}

/** An `ioredis` client, structurally. Lower-cased command names. */
export interface IoRedisLike {
  rpush(key: string, ...elements: string[]): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  rpop(key: string): Promise<string | null>
  del(key: string): Promise<unknown>
  expire?(key: string, seconds: number): Promise<unknown>
}

export type RedisClient = NodeRedisLike | IoRedisLike

export interface RedisSessionOptions {
  readonly client: RedisClient
  /** Key prefix. Default `agent:session:`. */
  readonly prefix?: string
  /** Expire a session this long after its last append. Default: never. */
  readonly ttlSeconds?: number
}

const DEFAULT_PREFIX = 'agent:session:'

/**
 * Conversations in a Redis list — one `RPUSH` per message, one `LRANGE` to read
 * the transcript back.
 *
 * Pass the client you already have. **`node-redis` and `ioredis` both work
 * unmodified**; the adapter detects which one it was given:
 *
 * ```ts
 * import { createClient } from 'redis'
 * import { redisSession } from 'just-another-sdk/sessions'
 *
 * const redis = createClient({ url: process.env.REDIS_URL })
 * await redis.connect()
 *
 * const agent = new Agent({ name: 'support', model, session: redisSession(redis) })
 * ```
 *
 * The right choice for serverless and multi-instance deployments: the store
 * holds no connection of its own and no local state, so every instance sees the
 * same conversation.
 */
export function redisSession(clientOrOptions: RedisClient | RedisSessionOptions): SessionStore {
  const options = isRedisSessionOptions(clientOrOptions)
    ? clientOrOptions
    : { client: clientOrOptions }

  const prefix = options.prefix ?? DEFAULT_PREFIX
  const ttlSeconds = options.ttlSeconds
  const commands = detectRedisCommands(options.client)

  const keyFor = (sessionId: string): string => {
    assertValidSessionId(sessionId)
    return `${prefix}${sessionId}`
  }

  return {
    async load(sessionId: string, options?: LoadOptions): Promise<ModelMessage[]> {
      const limit = options?.limit
      // A negative start counts back from the end, so `LRANGE key -N -1` is the
      // newest N in order — no offset arithmetic and no full read.
      const raw = await commands.lRange(keyFor(sessionId), limit === undefined ? 0 : -limit)
      return raw.map((entry) => JSON.parse(entry) as ModelMessage)
    },

    async append(sessionId: string, messages: readonly ModelMessage[]): Promise<void> {
      if (messages.length === 0) return
      const key = keyFor(sessionId)
      await commands.rPush(
        key,
        messages.map((message) => JSON.stringify(message)),
      )
      // Refreshed on every append, so the TTL measures idleness rather than the
      // age of the conversation.
      if (ttlSeconds !== undefined) await commands.expire(key, ttlSeconds)
    },

    async clear(sessionId: string): Promise<void> {
      await commands.del(keyFor(sessionId))
    },

    async pop(sessionId: string): Promise<ModelMessage | undefined> {
      const raw = await commands.rPop(keyFor(sessionId))
      return raw === null || raw === undefined ? undefined : (JSON.parse(raw) as ModelMessage)
    },
  }
}

interface RedisCommands {
  rPush(key: string, elements: string[]): Promise<unknown>
  /** `start` is a Redis index: 0 for the whole list, -N for the newest N. */
  lRange(key: string, start: number): Promise<string[]>
  rPop(key: string): Promise<string | null>
  del(key: string): Promise<unknown>
  expire(key: string, seconds: number): Promise<unknown>
}

function detectRedisCommands(client: RedisClient): RedisCommands {
  const candidate = client as Partial<NodeRedisLike> & Partial<IoRedisLike>

  if (typeof candidate.rPush === 'function' && typeof candidate.lRange === 'function') {
    const nodeRedis = client as NodeRedisLike
    return {
      rPush: (key, elements) => nodeRedis.rPush(key, elements),
      lRange: (key, start) => nodeRedis.lRange(key, start, -1),
      rPop: (key) => nodeRedis.rPop(key),
      del: (key) => nodeRedis.del(key),
      expire: async (key, seconds) => nodeRedis.expire?.(key, seconds),
    }
  }

  if (typeof candidate.rpush === 'function' && typeof candidate.lrange === 'function') {
    const ioredis = client as IoRedisLike
    return {
      rPush: (key, elements) => ioredis.rpush(key, ...elements),
      lRange: (key, start) => ioredis.lrange(key, start, -1),
      rPop: (key) => ioredis.rpop(key),
      del: (key) => ioredis.del(key),
      expire: async (key, seconds) => ioredis.expire?.(key, seconds),
    }
  }

  throw new ConfigurationError('redisSession() did not recognise that client.', {
    hint:
      'Pass a connected node-redis client (rPush/lRange/rPop/del) or an ioredis client ' +
      '(rpush/lrange/rpop/del). For anything else, implement the three-method SessionStore ' +
      'interface directly.',
  })
}

function isRedisSessionOptions(
  value: RedisClient | RedisSessionOptions,
): value is RedisSessionOptions {
  return 'client' in value && typeof value.client === 'object'
}
