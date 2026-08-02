/**
 * Resumable streams — a run that outlives the request that started it.
 *
 * ```ts
 * import { redisStreamStore } from 'just-another-sdk/streams'
 * ```
 *
 * Runtime-neutral: the Redis adapter takes a client you already have, so nothing
 * here imports a Node builtin. You may not need any of it — `agent.resumable()`
 * with no configured store uses a bounded in-memory one, which is right for a
 * single process.
 */

export { memoryStreamStore } from './memory.js'
export type { MemoryStreamStoreOptions } from './memory.js'

export { redisStreamStore } from './redis.js'
export type {
  IoRedisStreamLike,
  NodeRedisStreamLike,
  RedisStreamClient,
  RedisStreamStoreOptions,
} from './redis.js'

export { resumeStream, startResumable } from './resumable.js'
export type { FollowOptions, ResumableOptions, ResumableRun } from './resumable.js'

export { STREAM_ID_PREFIX } from './store.js'
export type { StreamOutcome, StreamStatus, StreamStore } from './store.js'
