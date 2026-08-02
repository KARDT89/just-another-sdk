import type { ModelMessage } from '../types/messages.js'

/**
 * Where a conversation lives between runs.
 *
 * Three methods, deliberately. A custom adapter — Mongo, DynamoDB, a REST API,
 * your own table — is a small class with `load`, `append`, and `clear`, and
 * nothing in the runtime needs to know which one it got.
 *
 * ```ts
 * class MyStore implements SessionStore {
 *   async load(id: string, options?: LoadOptions) {
 *     const rows = await db.messages.findMany({
 *       where: { id },
 *       orderBy: { seq: 'asc' },
 *       ...(options?.limit ? { take: -options.limit } : {}),
 *     })
 *     return rows.map((row) => row.message as ModelMessage)
 *   }
 *   async append(id: string, messages: readonly ModelMessage[]) {
 *     await db.messages.createMany({ data: messages.map((message) => ({ id, message })) })
 *   }
 *   async clear(id: string) {
 *     await db.messages.deleteMany({ where: { id } })
 *   }
 * }
 * ```
 *
 * ### Why `append` and not `save(allMessages)`
 *
 * Rewriting the whole transcript after every turn is O(n²) writes over a
 * conversation, and it turns two concurrent runs on one session into a lost
 * update: both read the same history, both write their own version, one wins.
 *
 * Appending has neither problem, and it is the *native* operation for every
 * backend worth supporting — a JSONL append, a SQL `INSERT`, a Redis `RPUSH`.
 * There is no read-modify-write anywhere in the contract, so concurrent runs
 * interleave their turns rather than destroying each other's.
 */
export interface SessionStore {
  /**
   * The transcript, oldest first. An unknown session id is not an error: return
   * an empty array.
   */
  load(sessionId: string, options?: LoadOptions): Promise<ModelMessage[]>

  /** Adds messages to the end of the transcript, preserving order. */
  append(sessionId: string, messages: readonly ModelMessage[]): Promise<void>

  /** Forgets the conversation entirely. Clearing an unknown id is a no-op. */
  clear(sessionId: string): Promise<void>

  /**
   * Removes and returns the most recent message, or `undefined` if there is
   * none. This is "undo": drop the assistant's reply and the user's message, and
   * re-run with an edited prompt.
   *
   * Optional, so that implementing this interface is still three methods. Every
   * adapter shipped with the SDK provides it; a store that does not gets a
   * `ConfigurationError` naming it rather than a missing-method crash.
   */
  pop?(sessionId: string): Promise<ModelMessage | undefined>
}

/** Second argument to {@link SessionStore.load}. */
export interface LoadOptions {
  /**
   * Read at most this many messages, counting back from the newest.
   *
   * **A hint, not a guarantee.** A store is free to ignore it — the run applies
   * its {@link ContextPolicy} to whatever comes back, so ignoring `limit` is
   * slower but never wrong. Implement it where your backend can (`LIMIT`,
   * `LRANGE`) and a long conversation stops costing a full read every turn.
   */
  readonly limit?: number
}

const MAX_SESSION_ID_LENGTH = 512

/**
 * Guards a session id before it reaches a filesystem path, a Redis key, or a SQL
 * parameter.
 *
 * A session id is almost always a user id taken straight off a request, so it is
 * untrusted input. Every shipped adapter calls this first.
 */
export function assertValidSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('A session id must be a non-empty string.')
  }

  if (sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new TypeError(
      `A session id must be at most ${MAX_SESSION_ID_LENGTH} characters, got ${sessionId.length}.`,
    )
  }

  // Written as a code-point scan rather than a regex so the source file carries
  // no literal control characters of its own.
  for (let i = 0; i < sessionId.length; i += 1) {
    const code = sessionId.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      throw new TypeError('A session id must not contain control characters.')
    }
  }
}
