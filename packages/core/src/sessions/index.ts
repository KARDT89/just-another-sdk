/**
 * Session storage — conversations that outlive a single run.
 *
 * ```ts
 * import { redisSession } from 'just-another-sdk/sessions'
 * ```
 *
 * Everything exported here is runtime-neutral: the adapters take a client you
 * already have, so nothing in this entry point imports a Node builtin. The two
 * that do live one level down, and are imported only when you want them:
 *
 * ```ts
 * import { fileSession }   from 'just-another-sdk/sessions/file'
 * import { sqliteSession } from 'just-another-sdk/sessions/sqlite'
 * ```
 *
 * You may not need any of them. Passing a `sessionId` with no configured store
 * uses a bounded in-memory one, which is enough for a prototype or a test.
 */

export { assertValidSessionId } from './store.js'
export type { SessionStore } from './store.js'

export { memorySession } from './memory.js'
export type { MemorySessionOptions } from './memory.js'

export { redisSession } from './redis.js'
export type { IoRedisLike, NodeRedisLike, RedisClient, RedisSessionOptions } from './redis.js'

export { postgresSession } from './postgres.js'
export type {
  PgClientLike,
  PostgresClient,
  PostgresJsLike,
  PostgresSessionOptions,
  SqlQuery,
} from './postgres.js'

export { estimateTokens, trimHistory } from './trim.js'
export type { ContextPolicy } from './trim.js'

export { applySummary, isSummaryMessage, summaryMessage, summaryWatermark } from './summarize.js'
export type { SummarizeOptions } from './summarize.js'
