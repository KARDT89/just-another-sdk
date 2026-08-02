import { ConfigurationError } from '../errors/errors.js'
import type { AgentEvent } from '../events/events.js'
import type { StreamOutcome, StreamStatus, StreamStore } from './store.js'

/**
 * The commands this store needs, in both casings. Declared structurally so
 * `redis` and `ioredis` stay non-dependencies, exactly as in `sessions/redis.ts`.
 */
export interface NodeRedisStreamLike {
  rPush(key: string, elements: string[]): Promise<unknown>
  lRange(key: string, start: number, stop: number): Promise<string[]>
  lLen(key: string): Promise<number>
  set(key: string, value: string): Promise<unknown>
  get(key: string): Promise<string | null>
  expire?(key: string, seconds: number): Promise<unknown>
}

export interface IoRedisStreamLike {
  rpush(key: string, ...elements: string[]): Promise<unknown>
  lrange(key: string, start: number, stop: number): Promise<string[]>
  llen(key: string): Promise<number>
  set(key: string, value: string): Promise<unknown>
  get(key: string): Promise<string | null>
  expire?(key: string, seconds: number): Promise<unknown>
}

export type RedisStreamClient = NodeRedisStreamLike | IoRedisStreamLike

export interface RedisStreamStoreOptions {
  readonly client: RedisStreamClient
  /** Key prefix. Default `agent:stream:`. */
  readonly prefix?: string
  /** How long a finished stream stays resumable. Default 3600 (one hour). */
  readonly ttlSeconds?: number
}

const DEFAULT_PREFIX = 'agent:stream:'
const DEFAULT_TTL_SECONDS = 3600

/**
 * Resumable streams in Redis, so a reconnect can land on any instance.
 *
 * ```ts
 * import { createClient } from 'redis'
 * import { redisStreamStore } from 'just-another-sdk/streams'
 *
 * const redis = createClient({ url: process.env.REDIS_URL })
 * await redis.connect()
 *
 * const agent = new Agent({ name: 'chat', model, streams: redisStreamStore(redis) })
 * ```
 *
 * One list of events plus one key holding the outcome, both expiring together.
 * A TTL is not optional here the way it is for sessions: these are transient by
 * definition, and a store without one accumulates every run forever.
 */
export function redisStreamStore(
  clientOrOptions: RedisStreamClient | RedisStreamStoreOptions,
): StreamStore {
  const options = isOptions(clientOrOptions) ? clientOrOptions : { client: clientOrOptions }
  const prefix = options.prefix ?? DEFAULT_PREFIX
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const commands = detect(options.client)

  const eventsKey = (streamId: string): string => `${prefix}${streamId}`
  const doneKey = (streamId: string): string => `${prefix}${streamId}:done`

  return {
    async append(streamId: string, events: readonly AgentEvent[]): Promise<void> {
      if (events.length === 0) return
      const key = eventsKey(streamId)
      await commands.rPush(
        key,
        events.map((event) => JSON.stringify(event)),
      )
      // Refreshed as the run produces output, so a long run cannot expire
      // halfway through being written.
      await commands.expire(key, ttlSeconds)
    },

    async read(streamId: string, fromIndex: number): Promise<AgentEvent[]> {
      const raw = await commands.lRange(eventsKey(streamId), Math.max(0, fromIndex), -1)
      return raw.map((entry) => JSON.parse(entry) as AgentEvent)
    },

    async finish(streamId: string, outcome: StreamOutcome): Promise<void> {
      const key = doneKey(streamId)
      await commands.set(key, outcome)
      await commands.expire(key, ttlSeconds)
      await commands.expire(eventsKey(streamId), ttlSeconds)
    },

    async status(streamId: string): Promise<StreamStatus> {
      const [count, outcome] = await Promise.all([
        commands.lLen(eventsKey(streamId)),
        commands.get(doneKey(streamId)),
      ])

      return {
        count,
        done: outcome !== null,
        ...(outcome === 'finish' || outcome === 'error' ? { outcome } : {}),
      }
    },
  }
}

interface StreamCommands {
  rPush(key: string, elements: string[]): Promise<unknown>
  lRange(key: string, start: number, stop: number): Promise<string[]>
  lLen(key: string): Promise<number>
  set(key: string, value: string): Promise<unknown>
  get(key: string): Promise<string | null>
  expire(key: string, seconds: number): Promise<unknown>
}

function detect(client: RedisStreamClient): StreamCommands {
  const candidate = client as Partial<NodeRedisStreamLike> & Partial<IoRedisStreamLike>

  if (typeof candidate.rPush === 'function' && typeof candidate.lLen === 'function') {
    const nodeRedis = client as NodeRedisStreamLike
    return {
      rPush: (key, elements) => nodeRedis.rPush(key, elements),
      lRange: (key, start, stop) => nodeRedis.lRange(key, start, stop),
      lLen: (key) => nodeRedis.lLen(key),
      set: (key, value) => nodeRedis.set(key, value),
      get: (key) => nodeRedis.get(key),
      expire: async (key, seconds) => nodeRedis.expire?.(key, seconds),
    }
  }

  if (typeof candidate.rpush === 'function' && typeof candidate.llen === 'function') {
    const ioredis = client as IoRedisStreamLike
    return {
      rPush: (key, elements) => ioredis.rpush(key, ...elements),
      lRange: (key, start, stop) => ioredis.lrange(key, start, stop),
      lLen: (key) => ioredis.llen(key),
      set: (key, value) => ioredis.set(key, value),
      get: (key) => ioredis.get(key),
      expire: async (key, seconds) => ioredis.expire?.(key, seconds),
    }
  }

  throw new ConfigurationError('redisStreamStore() did not recognise that client.', {
    hint:
      'Pass a connected node-redis client (rPush/lRange/lLen/set/get) or an ioredis ' +
      'client (rpush/lrange/llen/set/get).',
  })
}

function isOptions(
  value: RedisStreamClient | RedisStreamStoreOptions,
): value is RedisStreamStoreOptions {
  return 'client' in value && typeof value.client === 'object'
}
