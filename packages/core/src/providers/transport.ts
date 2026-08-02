/**
 * The parts of talking to an HTTP model API that have nothing to do with any
 * particular vendor's schema.
 *
 * Deadlines, cancellation, retry-after parsing, and turning a thrown `fetch`
 * rejection into the right `AgentError` are identical whether the body underneath
 * is OpenAI's `chat/completions`, Anthropic's `messages`, or Gemini's
 * `generateContent`. Only the *classification* of a status code is vendor-shaped
 * — Anthropic overloads with 529, Gemini reports a bad key as 400 — so that stays
 * in each provider file, and everything below is shared.
 *
 * Extracted from `openai-compatible.ts`, where all of this lived while there was
 * only one transport to serve.
 */

import { AgentError, ConfigurationError, NetworkError, TimeoutError } from '../errors/errors.js'
import type { ModelCallOptions } from './provider.js'

/**
 * Pulls a human-readable message out of an error body.
 *
 * Handles the two shapes every vendor uses — `{ error: { message } }` and
 * `{ message }` — and falls back to the raw text, truncated, so an HTML error
 * page from a misconfigured gateway still says something useful.
 */
export function extractErrorMessage(bodyText: string): string | undefined {
  if (!bodyText) return undefined
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string }; message?: string }
    return parsed.error?.message ?? parsed.message ?? bodyText.slice(0, 300)
  } catch {
    return bodyText.slice(0, 300)
  }
}

/** `Retry-After` in milliseconds. Accepts both delay-seconds and an HTTP date. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds * 1000
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

/**
 * Classifies a thrown `fetch` rejection.
 *
 * Correctness here is load-bearing: `run/retry.ts` and the `fallbacks` chain both
 * decide what to do next purely from `AgentError.retryable`, so a network reset
 * mislabelled as a cancellation silently stops retrying.
 */
export function toTransportError(
  cause: unknown,
  providerId: string,
  options: ModelCallOptions,
): Error {
  // `fetch` rejects with the abort *reason* itself when one was supplied, so a
  // run-level timeout or an explicit cancellation arrives here already correctly
  // typed. It must be passed through untouched: its `name` is `TimeoutError`, not
  // `AbortError`, so the shape check below would misclassify it as a network
  // failure and tell the caller to check their connectivity.
  if (cause instanceof AgentError) return cause

  const aborted = isAbortLike(cause)

  if (aborted && options.signal?.aborted) {
    // The caller cancelled: propagate their reason rather than inventing one.
    return options.signal.reason instanceof Error
      ? options.signal.reason
      : new TimeoutError('The request was aborted.')
  }

  if (aborted) {
    return new TimeoutError(`${providerId} did not respond within ${options.timeoutMs ?? 0}ms.`, {
      hint: 'Raise `modelTimeoutMs` on the agent, or use a faster model.',
    })
  }

  return new NetworkError(
    `Could not reach ${providerId}: ${cause instanceof Error ? cause.message : String(cause)}`,
    { cause, hint: 'Check network connectivity and the provider base URL.' },
  )
}

export function isAbortLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    (value as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * Combines the caller's signal with a per-call timeout.
 *
 * `AbortSignal.any` is used where available (Node 20+) and hand-rolled
 * otherwise, and `dispose()` always removes listeners so a long-lived caller
 * signal does not accumulate them across thousands of calls.
 */
export function linkSignals(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; dispose: () => void } {
  if (!callerSignal && !timeoutMs) return { signal: undefined, dispose: () => {} }
  if (!timeoutMs) return { signal: callerSignal, dispose: () => {} }

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!callerSignal) return { signal: timeoutSignal, dispose: () => {} }

  if (typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any([callerSignal, timeoutSignal]), dispose: () => {} }
  }

  const controller = new AbortController()
  const abort = (reason: unknown) => controller.abort(reason)
  const onCaller = () => abort(callerSignal.reason)
  const onTimeout = () => abort(timeoutSignal.reason)

  callerSignal.addEventListener('abort', onCaller, { once: true })
  timeoutSignal.addEventListener('abort', onTimeout, { once: true })

  return {
    signal: controller.signal,
    dispose: () => {
      callerSignal.removeEventListener('abort', onCaller)
      timeoutSignal.removeEventListener('abort', onTimeout)
    },
  }
}

/**
 * Tool arguments arrive as a JSON *string* on every streaming protocol. A model
 * can emit malformed JSON, and that must not crash the run — an unparsable
 * payload is handed to the tool layer as-is, where schema validation rejects it
 * and the model gets a chance to fix its own mistake.
 */
export function parseToolArguments(raw: string | undefined): unknown {
  if (!raw || raw.trim().length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { __unparsedArguments: raw }
  }
}

/**
 * Resolves the `fetch` a provider will use, failing early with a clear message.
 *
 * Checked at construction rather than at call time so a runtime without `fetch`
 * is reported while the developer is still looking at the line that built the
 * provider, not three turns into a run.
 */
export function resolveFetch(
  injected: typeof globalThis.fetch | undefined,
): typeof globalThis.fetch {
  const doFetch = injected ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new ConfigurationError('No global `fetch` is available in this runtime.', {
      hint: 'Use Node 20.19+, or pass a `fetch` implementation to the provider.',
    })
  }
  return doFetch
}
