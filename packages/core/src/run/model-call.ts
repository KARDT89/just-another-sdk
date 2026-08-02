import { toAgentError } from '../errors/errors.js'
import type { AgentError } from '../errors/errors.js'
import { textOf } from '../providers/provider.js'
import type { ModelProvider, ModelRequest, ModelResponse } from '../providers/provider.js'
import type { TextPart, ToolCallPart } from '../types/messages.js'
import {
  abortableSleep,
  backoffDelay,
  retryAfterOf,
  shouldRetry,
  throwIfAborted,
  type ResolvedRetryPolicy,
} from './retry.js'

/**
 * Everything between "the loop wants a model response" and "here is one".
 *
 * Three concerns live here so the loop never has to know about any of them:
 * choosing `stream()` over `generate()`, retrying a failed attempt, and moving
 * down the fallback chain. The loop calls this once per turn and gets back a
 * response plus a record of what it took to obtain it.
 */

/** Reported when an attempt failed and another will be made. */
export interface RetryAttempt {
  readonly provider: ModelProvider
  /** 1-based index of the attempt that just failed. */
  readonly attempt: number
  /** Total attempts that will be made against this provider. */
  readonly maxAttempts: number
  readonly error: AgentError
  readonly delayMs: number
  /** Text already streamed for the failed attempt, now void. Usually empty. */
  readonly discardedText: string
}

/** Reported when the chain moves on to the next provider. */
export interface FallbackSwitch {
  readonly from: ModelProvider
  readonly to: ModelProvider
  /** 0-based position of the new provider in `[model, ...fallbacks]`. */
  readonly index: number
  /** The error that exhausted the previous provider. */
  readonly error: AgentError
  readonly discardedText: string
}

export interface ModelCallParams {
  /** `[config.model, ...config.fallbacks]`. Always at least one entry. */
  readonly providers: readonly ModelProvider[]
  readonly request: ModelRequest
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly retry: ResolvedRetryPolicy
  /** Prefer `stream()` where the provider implements it. */
  readonly streaming: boolean
  readonly onTextDelta: (delta: string) => void
  readonly onRetry: (info: RetryAttempt) => void
  readonly onFallback: (info: FallbackSwitch) => void
}

export interface ModelCallOutcome {
  readonly response: ModelResponse
  /** The provider that actually served the turn. */
  readonly provider: ModelProvider
  /** Total attempts across the whole chain. Always at least 1. */
  readonly attempts: number
  /** True when the response came from `stream()` rather than `generate()`. */
  readonly streamed: boolean
}

export async function callModel(params: ModelCallParams): Promise<ModelCallOutcome> {
  const { providers, retry, signal } = params

  let lastError: AgentError | undefined
  let discardedText = ''
  let attempts = 0

  for (const [index, provider] of providers.entries()) {
    if (index > 0 && lastError) {
      const previous = providers[index - 1]
      if (previous) {
        params.onFallback({ from: previous, to: provider, index, error: lastError, discardedText })
      }
    }

    for (let attempt = 1; ; attempt += 1) {
      throwIfAborted(signal)
      attempts += 1

      // Reset per attempt: what the *failed* attempt streamed is what a renderer
      // has to un-paint, and only this attempt's output counts.
      let emitted = ''

      try {
        const streamable = params.streaming && typeof provider.stream === 'function'

        const response = streamable
          ? await consumeStream(provider, params, (delta) => {
              emitted += delta
              params.onTextDelta(delta)
            })
          : await provider.generate(params.request, {
              signal,
              timeoutMs: params.timeoutMs,
            })

        // A provider with no `stream()` still feeds the text stream — one delta
        // carrying the whole answer. That makes `textStream()` useful against
        // every provider rather than merely non-crashing against some.
        if (params.streaming && emitted === '') {
          const whole = textOf(response)
          if (whole.length > 0) params.onTextDelta(whole)
        }

        return { response, provider, attempts, streamed: streamable && emitted.length > 0 }
      } catch (cause) {
        lastError = toAgentError(cause)
        discardedText = emitted

        // Cancellation is never retried and never falls back: the caller asked
        // for the run to stop, and papering over that would be a bug.
        //
        // The signal is checked as well as the error code because a provider may
        // reject with its own transport-shaped error when aborted mid-flight.
        // The run was still cancelled, and must be reported as such rather than
        // as whatever the provider happened to throw on its way down.
        if (signal.aborted) throwIfAborted(signal)
        if (lastError.code === 'aborted') throw lastError

        if (attempt <= retry.maxRetries && shouldRetry(lastError, attempt, retry)) {
          const delayMs = backoffDelay(attempt, retry, retryAfterOf(lastError))

          if (delayMs !== null) {
            params.onRetry({
              provider,
              attempt,
              maxAttempts: retry.maxRetries + 1,
              error: lastError,
              delayMs,
              discardedText: emitted,
            })
            await abortableSleep(delayMs, signal)
            continue
          }
        }

        // Exhausted, non-retryable, or a `Retry-After` we will not honour. Any
        // of those is a reason to let the next provider try — including a bad
        // key or an unknown model, which is exactly when a second vendor helps.
        break
      }
    }
  }

  // The chain is spent. Rethrow the last provider's error unwrapped: the retry
  // and fallback events are the record of what was tried, and callers switching
  // on `.code` should still see the real failure.
  throw lastError ?? toAgentError(new Error('No model provider was configured.'))
}

/**
 * Drives `provider.stream()` to completion.
 *
 * Tool-call fragments are accumulated here and never surfaced: by the time the
 * loop learns a tool was called, its arguments are complete and parseable, so
 * no consumer is ever handed half a JSON object.
 */
async function consumeStream(
  provider: ModelProvider,
  params: ModelCallParams,
  onDelta: (delta: string) => void,
): Promise<ModelResponse> {
  const stream = provider.stream?.(params.request, {
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  })

  /* c8 ignore next -- guarded by the `typeof provider.stream` check at the call site */
  if (!stream) throw new Error('The provider does not implement stream().')

  let text = ''
  // Kept only so a provider that omits the `finish` chunk can still be salvaged
  // below. Fragments are never forwarded anywhere.
  const partialCalls = new Map<string, { name: string; args: string }>()

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text
        onDelta(chunk.text)
        break

      case 'tool-call-delta': {
        const slot = partialCalls.get(chunk.toolCallId) ?? { name: '', args: '' }
        if (chunk.toolName) slot.name = chunk.toolName
        slot.args += chunk.inputDelta
        partialCalls.set(chunk.toolCallId, slot)
        break
      }

      case 'finish':
        return chunk.response
    }
  }

  // The stream ended without a `finish` chunk. A third-party provider getting
  // this wrong should degrade to a usable response, not take the run down.
  const content: (TextPart | ToolCallPart)[] = []
  if (text.length > 0) content.push({ type: 'text', text })

  for (const [toolCallId, call] of partialCalls) {
    content.push({
      type: 'tool-call',
      toolCallId,
      toolName: call.name,
      input: safeParse(call.args),
    })
  }

  return {
    content,
    finishReason: partialCalls.size > 0 ? 'tool_calls' : 'stop',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    modelId: provider.modelId,
  }
}

/** Mirrors the transport's tolerance: bad JSON reaches schema validation, not a crash. */
function safeParse(raw: string): unknown {
  if (raw.trim().length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { __unparsedArguments: raw }
  }
}
