import { AGENT_DEFAULTS, type AgentConfig, type RunOptions } from '../agent/types.js'
import { AbortError, AgentError, RateLimitError } from '../errors/errors.js'

/**
 * When and how hard to retry a failed model call.
 *
 * Retries are per *model call*, not per run: an attempt that fails is replayed
 * with the identical request, so there is no state to unwind. Tool failures are
 * deliberately outside this — they are fed back to the model as results, which
 * is a better recovery mechanism than blind repetition.
 */
export interface RetryPolicy {
  /** Extra attempts after the first. Default 2 (so 3 calls at most). */
  readonly maxRetries?: number
  /** Base of the exponential curve, ms. Default 250. */
  readonly retryDelayMs?: number
  /** Ceiling on a single wait, ms. Default 10_000. */
  readonly maxRetryDelayMs?: number
  /**
   * Replaces the default predicate (`error.retryable`) entirely. `attempt` is
   * 1-based. Cancellation is never retried regardless of what this returns.
   */
  readonly retryOn?: (error: AgentError, attempt: number) => boolean
}

/** A {@link RetryPolicy} with every default filled in. */
export interface ResolvedRetryPolicy {
  readonly maxRetries: number
  readonly retryDelayMs: number
  readonly maxRetryDelayMs: number
  readonly retryOn: ((error: AgentError, attempt: number) => boolean) | undefined
}

export function resolveRetryPolicy(
  config: AgentConfig,
  options: RunOptions = {},
): ResolvedRetryPolicy {
  return {
    maxRetries: Math.max(0, options.maxRetries ?? config.maxRetries ?? AGENT_DEFAULTS.maxRetries),
    retryDelayMs: config.retryDelayMs ?? AGENT_DEFAULTS.retryDelayMs,
    maxRetryDelayMs: config.maxRetryDelayMs ?? AGENT_DEFAULTS.maxRetryDelayMs,
    retryOn: config.retryOn,
  }
}

/**
 * Whether this error is worth another attempt.
 *
 * Cancellation short-circuits before `retryOn` is consulted: a caller who
 * aborted must never be made to wait through a backoff, and no custom predicate
 * should be able to override that.
 */
export function shouldRetry(
  error: AgentError,
  attempt: number,
  policy: ResolvedRetryPolicy,
): boolean {
  if (error.code === 'aborted') return false
  if (policy.retryOn) return policy.retryOn(error, attempt)
  return error.retryable
}

/**
 * How long to wait before attempt `attempt + 1`, or `null` to stop trying.
 *
 * Exponential backoff with **full jitter** (`random() * cap`): the variant that
 * minimises contention when many clients fail at once, because it spreads
 * retries across the whole window instead of clustering them at its end.
 *
 * `random` is injectable so tests can assert the curve exactly.
 */
export function backoffDelay(
  attempt: number,
  policy: ResolvedRetryPolicy,
  retryAfterMs: number | undefined,
  random: () => number = Math.random,
): number | null {
  if (retryAfterMs !== undefined) {
    // A provider asking for longer than we are willing to block is answered by
    // failing now. Blocking somebody's `await` for five minutes because a
    // gateway said so is worse than an actionable error — and the error still
    // carries `retryAfterMs`, so they can schedule it themselves.
    if (retryAfterMs > policy.maxRetryDelayMs) return null

    // `Retry-After` is a floor, not a value. Sleeping exactly what the server
    // asked for guarantees every rate-limited client retries in the same
    // millisecond; jittering *below* it guarantees a second 429.
    return Math.min(retryAfterMs + random() * policy.retryDelayMs, policy.maxRetryDelayMs)
  }

  const cap = Math.min(policy.retryDelayMs * 2 ** (attempt - 1), policy.maxRetryDelayMs)
  return random() * cap
}

/** The provider's own guidance, when it gave any. */
export function retryAfterOf(error: AgentError): number | undefined {
  return error instanceof RateLimitError ? error.retryAfterMs : undefined
}

/**
 * Sleeps, unless the signal fires first.
 *
 * A plain `setTimeout` would make cancellation during a backoff take effect only
 * after the wait elapsed — the caller aborts and nothing happens for ten
 * seconds. Both the timer and the listener are cleaned up on either path, so
 * thousands of calls against one long-lived signal leak neither.
 */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal))

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortReason(signal))
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Rethrows as an `AgentError` if the signal has already fired. */
export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw abortReason(signal)
}

function abortReason(signal: AbortSignal): AgentError {
  return signal.reason instanceof AgentError ? signal.reason : new AbortError()
}
