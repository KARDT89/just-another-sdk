import {
  AuthenticationError,
  ConfigurationError,
  ProviderError,
  RateLimitError,
} from '../errors/errors.js'
import { readEnv } from '../util/env.js'
import { redactHeaders } from '../util/redact.js'
import { safeStringify } from '../util/stringify.js'
import { parseSseStream } from './sse.js'
import {
  extractErrorMessage,
  linkSignals,
  parseRetryAfter,
  parseToolArguments,
  resolveFetch,
  toTransportError,
} from './transport.js'
import type {
  FinishReason,
  ModelCallOptions,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
  ToolChoice,
  ToolDefinition,
} from './provider.js'
import type { ModelMessage, TextPart, ToolCallPart, Usage } from '../types/messages.js'

/**
 * Claude, natively, over the Anthropic Messages API.
 *
 * Not a wrapper around `@anthropic-ai/sdk`. This is `fetch` and the shared SSE
 * framer, which is the only way `just-another-sdk` keeps an empty dependency
 * tree and runs unchanged on Node, Bun, Deno, and the edge.
 *
 * The Messages API disagrees with the OpenAI shape in four ways that matter, and
 * each is handled below rather than papered over:
 *
 *   1. The system prompt is a top-level field, not a message.
 *   2. `max_tokens` is **required**, so one is supplied when the caller omits it.
 *   3. Tool calls and their results are content *blocks*, not a sibling array —
 *      which fits this SDK's message format better than OpenAI's does, because
 *      one `ToolMessage` carries every result for a turn and becomes exactly one
 *      Anthropic `user` message.
 *   4. Streaming is named-event SSE, and usage arrives split across two of them.
 */

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'
const DEFAULT_VERSION = '2023-06-01'

/**
 * Anthropic rejects a request without `max_tokens`, but `ModelRequest` treats it
 * as optional because every other vendor does. 4096 is the value picked when
 * nobody said: high enough that a normal answer is never truncated, low enough
 * that a runaway generation is bounded.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096

export interface AnthropicOptions {
  /** Defaults to `process.env.ANTHROPIC_API_KEY`. */
  readonly apiKey?: string
  /** Defaults to `https://api.anthropic.com/v1`. */
  readonly baseUrl?: string
  /** Sent as `anthropic-version`. Defaults to `2023-06-01`. */
  readonly version?: string
  /** Used when a request does not set `maxOutputTokens`. Defaults to 4096. */
  readonly maxOutputTokens?: number
  /**
   * Translate `responseFormat` into Anthropic's native `output_config.format`.
   *
   * Off by default, and deliberately so: the field is model-gated, and an older
   * Claude rejects it with a 400. The zero-config path must never fail, and it
   * does not need to — `run/output.ts` already instructs, validates, and repairs
   * structured output without any provider support. Turn this on when you know
   * the model accepts it and you want the schema enforced at the source.
   */
  readonly structuredOutputs?: boolean
  /**
   * Comma-joined into `anthropic-beta`, e.g. `['fine-grained-tool-streaming-2025-05-14']`.
   */
  readonly betas?: readonly string[]
  /**
   * Merged into every request body, overriding what the SDK would otherwise
   * send. The escape hatch for anything not modelled here.
   *
   * `{ thinking: { type: 'adaptive' } }` turns on extended thinking;
   * `{ output_config: { effort: 'high' } }` sets the effort level; and
   * `{ temperature: undefined }` *removes* the field, which matters because
   * Claude Opus 5, Opus 4.8, Opus 4.7, and Fable 5 reject `temperature` with a
   * 400 — `JSON.stringify` drops an undefined value, so the key never ships.
   */
  readonly defaultBody?: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof globalThis.fetch
}

/**
 * A Claude model, via the Messages API.
 *
 * ```ts
 * const agent = new Agent({
 *   name: 'assistant',
 *   model: anthropic('claude-opus-5'),
 * })
 * ```
 */
export function anthropic(modelId: string, options: AnthropicOptions = {}): ModelProvider {
  const apiKey = options.apiKey ?? readEnv('ANTHROPIC_API_KEY')

  if (!apiKey) {
    throw new ConfigurationError('No Anthropic API key found.', {
      hint:
        'Set the ANTHROPIC_API_KEY environment variable, or pass ' +
        "anthropic('model-id', { apiKey }).",
    })
  }

  const config: ResolvedConfig = {
    providerId: 'anthropic',
    modelId,
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    apiKey,
    version: options.version ?? DEFAULT_VERSION,
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    structuredOutputs: options.structuredOutputs ?? false,
    ...(options.defaultBody ? { defaultBody: options.defaultBody } : {}),
    headers: {
      ...options.headers,
      ...(options.betas?.length ? { 'anthropic-beta': options.betas.join(',') } : {}),
    },
  }

  const doFetch = resolveFetch(options.fetch)

  return {
    providerId: config.providerId,
    modelId: config.modelId,

    async generate(request: ModelRequest, callOptions: ModelCallOptions = {}) {
      const headers = buildHeaders(config, callOptions)
      const { signal, dispose } = linkSignals(callOptions.signal, callOptions.timeoutMs)

      let response: Response
      try {
        response = await doFetch(`${config.baseUrl}/messages`, {
          method: 'POST',
          headers,
          body: JSON.stringify(buildRequestBody(config, request)),
          ...(signal ? { signal } : {}),
        })
      } catch (cause) {
        throw toTransportError(cause, config.providerId, callOptions)
      } finally {
        dispose()
      }

      if (!response.ok) throw await toHttpError(response, config, headers)

      let payload: WireMessageResponse
      try {
        payload = (await response.json()) as WireMessageResponse
      } catch (cause) {
        throw new ProviderError('anthropic returned a response that is not valid JSON.', {
          cause,
          status: response.status,
        })
      }

      return parseResponse(payload, config)
    },

    async *stream(
      request: ModelRequest,
      callOptions: ModelCallOptions = {},
    ): AsyncGenerator<ModelStreamChunk> {
      const headers = buildHeaders(config, callOptions)
      // Same deadline `generate()` uses, with one semantic difference: it now
      // bounds the whole stream rather than time-to-first-byte.
      const { signal, dispose } = linkSignals(callOptions.signal, callOptions.timeoutMs)

      try {
        let response: Response
        try {
          response = await doFetch(`${config.baseUrl}/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...buildRequestBody(config, request), stream: true }),
            ...(signal ? { signal } : {}),
          })
        } catch (cause) {
          throw toTransportError(cause, config.providerId, callOptions)
        }

        if (!response.ok) throw await toHttpError(response, config, headers)

        if (!response.body) {
          throw new ProviderError('anthropic returned no response body for a streaming request.', {
            status: response.status,
          })
        }

        yield* decodeMessageStream(response.body, config, callOptions)
      } finally {
        dispose()
      }
    },
  }
}

interface ResolvedConfig {
  readonly providerId: string
  readonly modelId: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly version: string
  readonly maxOutputTokens: number
  readonly structuredOutputs: boolean
  readonly defaultBody?: Readonly<Record<string, unknown>>
  readonly headers: Readonly<Record<string, string>>
}

function buildHeaders(config: ResolvedConfig, options: ModelCallOptions): Record<string, string> {
  return {
    'content-type': 'application/json',
    // Anthropic authenticates with its own header, not `Authorization: Bearer`.
    'x-api-key': config.apiKey,
    'anthropic-version': config.version,
    ...config.headers,
    ...options.headers,
  }
}

/* ------------------------------------------------------------------------- */
/* Request translation: our format → the Messages wire format                */
/* ------------------------------------------------------------------------- */

function buildRequestBody(config: ResolvedConfig, request: ModelRequest): Record<string, unknown> {
  const { system, messages } = hoistSystem(request)

  const body: Record<string, unknown> = {
    model: config.modelId,
    // Required by the API. `??` rather than `||` so an explicit 0 is preserved
    // and rejected by Anthropic with its own clear message.
    max_tokens: request.maxOutputTokens ?? config.maxOutputTokens,
    messages,
  }

  if (system.length > 0) body['system'] = system
  if (request.stopSequences?.length) body['stop_sequences'] = [...request.stopSequences]

  // Sampling is passed through — a provider must not second-guess the request —
  // but note that `temperature` is *rejected with a 400* by Claude Opus 5,
  // Opus 4.8, Opus 4.7, and Fable 5. The default path is safe because the loop
  // only sends it when the developer configured it, and
  // `defaultBody: { temperature: undefined }` removes it again, because the
  // escape hatch is spread last and `JSON.stringify` drops undefined.
  if (request.temperature !== undefined) body['temperature'] = request.temperature

  // Anthropic's `metadata` accepts exactly one key. Forwarding the SDK's open
  // string map verbatim would 400 on any other field, so only the user id is
  // carried across and the rest is dropped.
  const userId = request.metadata?.['userId'] ?? request.metadata?.['user_id']
  if (userId) body['metadata'] = { user_id: userId }

  if (request.tools?.length) {
    body['tools'] = request.tools.map(toWireTool)
    // Anthropic rejects a `tool_choice` with no tools, hence the nesting.
    const choice = toWireToolChoice(request.toolChoice)
    if (choice !== undefined) body['tool_choice'] = choice
  }

  // Structured output is opt-in. `output_config.format` is real and native, but
  // model-gated — see `AnthropicOptions.structuredOutputs`. When it is off the
  // field is *ignored*, never an error: the provider contract requires that, and
  // `run/output.ts` instructs, validates, and repairs regardless.
  if (config.structuredOutputs && request.responseFormat?.type === 'json') {
    body['output_config'] = {
      format: request.responseFormat.schema
        ? { type: 'json_schema', schema: request.responseFormat.schema }
        : { type: 'json_object' },
    }
  }

  // Spread last so they stay genuine escape hatches: `thinking`,
  // `output_config` with an `effort` level, `cache_control`, `service_tier` —
  // anything the SDK does not model, plus the ability to unset what it does.
  return { ...body, ...config.defaultBody, ...request.providerOptions }
}

/**
 * Splits the request into Anthropic's top-level `system` string and its message
 * list.
 *
 * `ModelRequest.system` is already hoisted by the runner, but a persisted
 * session can replay a `SystemMessage` inside `messages`, and Anthropic has no
 * system role there. Folding it into the top-level field keeps the transcript
 * honest; turning it into a fake user turn would not.
 */
function hoistSystem(request: ModelRequest): { system: string; messages: WireMessage[] } {
  const parts: string[] = []
  if (request.system && request.system.trim().length > 0) parts.push(request.system)

  const conversation: ModelMessage[] = []
  for (const message of request.messages) {
    if (message.role === 'system') {
      if (message.content.trim().length > 0) parts.push(message.content)
    } else {
      conversation.push(message)
    }
  }

  return { system: parts.join('\n\n'), messages: toWireMessages(conversation) }
}

/**
 * Turns the neutral message list into Anthropic content blocks.
 *
 * Consecutive same-role messages are merged. The Messages API is strict about
 * alternation, and a session that replayed two user turns in a row — easy to do
 * with a persisted history — would otherwise come back as a 400 the caller
 * cannot act on.
 */
function toWireMessages(messages: readonly ModelMessage[]): WireMessage[] {
  const wire: WireMessage[] = []

  for (const message of messages) {
    const next = toWireMessage(message)
    // A message that carries nothing at all is rejected by the API, and there is
    // nothing to send anyway.
    if (!next || next.content.length === 0) continue

    const previous = wire[wire.length - 1]
    if (previous && previous.role === next.role) {
      previous.content.push(...next.content)
      continue
    }

    wire.push(next)
  }

  return wire
}

function toWireMessage(message: ModelMessage): WireMessage | undefined {
  switch (message.role) {
    // Already lifted into the top-level `system` field by `hoistSystem`.
    case 'system':
      return undefined

    case 'user':
      return {
        role: 'user',
        content:
          typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : message.content.map((part) => ({ type: 'text' as const, text: part.text })),
      }

    case 'assistant': {
      const content: WireContentBlock[] = []
      for (const part of message.content) {
        if (part.type === 'text') {
          // Anthropic rejects an empty text block outright.
          if (part.text.length > 0) content.push({ type: 'text', text: part.text })
        } else {
          content.push({
            type: 'tool_use',
            id: part.toolCallId,
            name: part.toolName,
            input: part.input ?? {},
          })
        }
      }
      return { role: 'assistant', content }
    }

    case 'tool':
      // Every result for the turn becomes one `user` message holding N
      // `tool_result` blocks — which is exactly how Anthropic wants them, and
      // why this provider needs no fan-out the way the OpenAI one does.
      return {
        role: 'user',
        content: message.content.map((part) => ({
          type: 'tool_result' as const,
          tool_use_id: part.toolCallId,
          // Must reach the model as a string; `safeStringify` keeps an object
          // informative where `String(obj)` would send '[object Object]'.
          content: safeStringify(part.output),
          ...(part.isError ? { is_error: true } : {}),
        })),
      }
  }
}

function toWireTool(tool: ToolDefinition): WireTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }
}

function toWireToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined || choice === 'auto') return undefined
  if (choice === 'none') return { type: 'none' }
  // Anthropic's "you must call something" is `any`, not `required`.
  if (choice === 'required') return { type: 'any' }
  return { type: 'tool', name: choice.name }
}

/* ------------------------------------------------------------------------- */
/* Response translation: the Messages wire format → our format               */
/* ------------------------------------------------------------------------- */

function parseResponse(payload: WireMessageResponse, config: ResolvedConfig): ModelResponse {
  // A 200 carrying an error body. Rare, but a gateway in front of Anthropic can
  // produce one, and parsing it as a message would surface as "no content".
  if (payload.type === 'error' || payload.error) {
    throw new ProviderError(`anthropic: ${payload.error?.message ?? 'unknown provider error'}`, {
      details: { type: payload.error?.type },
    })
  }

  const content: (TextPart | ToolCallPart)[] = []

  for (const block of payload.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_use' && block.id && block.name) {
      // Non-streamed tool input is already an object — no JSON string to parse.
      content.push({
        type: 'tool-call',
        toolCallId: block.id,
        toolName: block.name,
        input: block.input ?? {},
      })
    }
    // `thinking` and `redacted_thinking` blocks are not representable in the
    // neutral content union and are skipped. Extended thinking still works —
    // the model reasons, and the answer arrives — but the signed blocks are not
    // replayed on the next turn, so enable it via `providerOptions` knowing
    // reasoning does not persist across turns here.
  }

  return {
    content,
    finishReason: mapFinishReason(payload.stop_reason, content),
    usage: mapUsage(payload.usage),
    modelId: payload.model ?? config.modelId,
    raw: payload,
  }
}

/**
 * Decodes the Messages SSE protocol.
 *
 * Anthropic streams named events and splits a single logical response across
 * six of them: `message_start` carries the input token count, the
 * `content_block_*` family carries the content, and `message_delta` carries the
 * stop reason and the output token count. The accumulator below reassembles a
 * `ModelResponse` identical in shape to the non-streamed one, so a streamed turn
 * and a buffered turn are indistinguishable to everything downstream.
 */
async function* decodeMessageStream(
  body: ReadableStream<Uint8Array>,
  config: ResolvedConfig,
  options: ModelCallOptions,
): AsyncGenerator<ModelStreamChunk> {
  let text = ''
  // Keyed by the wire's block index — the only thing correlating a fragment to
  // its block, since `id` and `name` arrive once in `content_block_start`.
  const toolCalls = new Map<number, { id: string; name: string; json: string }>()
  let stopReason: string | null | undefined
  let servingModel: string | undefined
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let parsedFrames = 0

  try {
    for await (const event of parseSseStream(body)) {
      let payload: WireStreamEvent
      try {
        payload = JSON.parse(event.data) as WireStreamEvent
      } catch {
        // Tolerate one bad frame — a truncated keep-alive, a proxy artefact. A
        // stream where *nothing* parsed is a different problem, caught below.
        continue
      }
      parsedFrames += 1

      // Switching on the payload's own `type` rather than the SSE `event:` name:
      // they always agree, and proxies have been known to drop the name.
      switch (payload.type) {
        case 'message_start': {
          const message = payload.message
          if (message?.model) servingModel = message.model
          if (message?.usage) {
            inputTokens = message.usage.input_tokens ?? 0
            cacheReadTokens = message.usage.cache_read_input_tokens ?? 0
            cacheWriteTokens = message.usage.cache_creation_input_tokens ?? 0
            outputTokens = message.usage.output_tokens ?? 0
          }
          break
        }

        case 'content_block_start': {
          const block = payload.content_block
          if (block?.type === 'tool_use' && block.id && block.name) {
            const index = payload.index ?? 0
            toolCalls.set(index, { id: block.id, name: block.name, json: '' })
            // Announced with an empty delta so a consumer can render "calling
            // get_weather…" before a single argument byte has arrived.
            yield {
              type: 'tool-call-delta',
              toolCallId: block.id,
              toolName: block.name,
              inputDelta: '',
            }
          } else if (block?.type === 'text' && block.text) {
            text += block.text
            yield { type: 'text-delta', text: block.text }
          }
          break
        }

        case 'content_block_delta': {
          const delta = payload.delta
          if (delta?.type === 'text_delta' && delta.text) {
            text += delta.text
            yield { type: 'text-delta', text: delta.text }
          } else if (delta?.type === 'input_json_delta') {
            const index = payload.index ?? 0
            const slot = toolCalls.get(index)
            // Arguments stream as JSON *string* fragments here, unlike the
            // buffered path where they arrive already parsed.
            const fragment = delta.partial_json ?? ''
            if (slot) {
              slot.json += fragment
              yield {
                type: 'tool-call-delta',
                toolCallId: slot.id,
                toolName: slot.name,
                inputDelta: fragment,
              }
            }
          }
          break
        }

        case 'message_delta': {
          if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason
          // Cumulative, not incremental — assign rather than add.
          if (payload.usage?.output_tokens !== undefined) {
            outputTokens = payload.usage.output_tokens
          }
          break
        }

        case 'error':
          throw toStreamError(payload.error)

        // `content_block_stop`, `message_stop`, and `ping` carry nothing the
        // accumulator needs; the finish chunk is emitted once the body ends.
        default:
          break
      }
    }
  } catch (cause) {
    // Covers a mid-stream socket reset, a run-level abort, and the per-call
    // deadline — all already classified by the shared mapper.
    throw toTransportError(cause, config.providerId, options)
  }

  if (parsedFrames === 0) {
    throw new ProviderError('anthropic returned a malformed event stream.', {
      hint: 'The endpoint may not support streaming, or returned a non-SSE body.',
      details: { modelId: config.modelId },
    })
  }

  const content: (TextPart | ToolCallPart)[] = []
  if (text.length > 0) content.push({ type: 'text', text })

  for (const [, call] of [...toolCalls.entries()].sort(([a], [b]) => a - b)) {
    content.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.name,
      input: parseToolArguments(call.json),
    })
  }

  // Always emitted: `consumeStream` in the runner tolerates a missing finish
  // chunk but then reports zero usage for the turn.
  yield {
    type: 'finish',
    response: {
      content,
      finishReason: mapFinishReason(stopReason, content),
      usage: toUsage(inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens),
      modelId: servingModel ?? config.modelId,
      // A stream has no single payload, and buffering every frame to synthesize
      // one would defeat the point. A summary is the honest thing to expose.
      raw: { streamed: true, frames: parsedFrames },
    },
  }
}

function mapFinishReason(
  reason: string | null | undefined,
  content: readonly (TextPart | ToolCallPart)[],
): FinishReason {
  // Trust the content over the flag, the same rule the OpenAI provider follows.
  if (content.some((part) => part.type === 'tool-call')) return 'tool_calls'

  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'tool_use':
      return 'tool_calls'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length'
    case 'refusal':
      return 'content_filter'
    // `pause_turn` (a long-running server tool) falls through to 'other'.
    default:
      return reason ? 'other' : 'stop'
  }
}

/**
 * Anthropic's `input_tokens` *excludes* both cache figures and it reports no
 * total, so this cannot reuse the OpenAI mapper. Cache reads and writes are
 * folded into `inputTokens` — which is what OpenAI's `prompt_tokens` already
 * means — and the read count is also surfaced on its own.
 */
function mapUsage(usage: WireUsage | undefined): Usage {
  return toUsage(
    usage?.input_tokens ?? 0,
    usage?.output_tokens ?? 0,
    usage?.cache_read_input_tokens ?? 0,
    usage?.cache_creation_input_tokens ?? 0,
  )
}

function toUsage(
  baseInput: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number,
): Usage {
  const inputTokens = baseInput + cacheRead + cacheWrite
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cacheRead ? { cachedInputTokens: cacheRead } : {}),
  }
}

/* ------------------------------------------------------------------------- */
/* Error translation                                                         */
/* ------------------------------------------------------------------------- */

async function toHttpError(
  response: Response,
  config: ResolvedConfig,
  requestHeaders: Record<string, string>,
): Promise<Error> {
  const bodyText = await response.text().catch(() => '')
  const message = extractErrorMessage(bodyText) ?? (response.statusText || 'request failed')
  const type = extractErrorType(bodyText)

  // Redacted so a debug log of `details` can never surface the API key.
  const details = {
    status: response.status,
    providerId: config.providerId,
    ...(type ? { type } : {}),
    requestHeaders: redactHeaders(requestHeaders),
  }

  if (response.status === 401 || response.status === 403) {
    return new AuthenticationError(`anthropic rejected the API key: ${message}`, {
      hint: 'Check the key is correct, active, and has access to this model.',
      details,
    })
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
    return new RateLimitError(`anthropic rate-limited the request: ${message}`, {
      ...(retryAfter !== undefined
        ? { retryAfterMs: retryAfter, hint: `Retry after ${Math.ceil(retryAfter / 1000)}s.` }
        : {}),
      details,
    })
  }

  if (response.status === 404) {
    return new ProviderError(`anthropic could not find the requested model: ${message}`, {
      status: 404,
      hint: 'Verify the model id — Anthropic model ids are exact strings, not aliases.',
      details,
    })
  }

  // 529 `overloaded_error` is Anthropic's "come back shortly". `ProviderError`
  // already treats every 5xx as retryable, which is what lets the retry policy
  // and the `fallbacks` chain do their job here.
  if (response.status === 529) {
    return new ProviderError(`anthropic is overloaded: ${message}`, {
      status: 529,
      hint: 'Transient. Retries are automatic; add `fallbacks` to fail over to another model.',
      details,
    })
  }

  return new ProviderError(`anthropic returned ${response.status}: ${message}`, {
    status: response.status,
    details,
  })
}

/**
 * An `error` event mid-stream, after a 200.
 *
 * `overloaded_error` and `api_error` are transient, and the run should retry or
 * fall back rather than surface a hard failure — so they are given a 5xx status,
 * which is what `ProviderError` reads to decide retryability.
 */
function toStreamError(error: WireError | undefined): Error {
  const message = error?.message ?? 'the stream ended with an error'

  if (error?.type === 'rate_limit_error') {
    return new RateLimitError(`anthropic rate-limited the request: ${message}`)
  }

  // `ProviderError` derives retryability from `status`, and a 5xx is retryable.
  // Passing it is what lets the retry policy and the `fallbacks` chain react to
  // an overload — omitting it would silently make the failure terminal.
  const transient = error?.type === 'overloaded_error' || error?.type === 'api_error'

  return new ProviderError(`anthropic: ${message}`, {
    ...(transient ? { status: 529 } : {}),
    details: { type: error?.type },
  })
}

function extractErrorType(bodyText: string): string | undefined {
  if (!bodyText) return undefined
  try {
    const parsed = JSON.parse(bodyText) as { error?: { type?: string } }
    return parsed.error?.type
  } catch {
    return undefined
  }
}

/* ------------------------------------------------------------------------- */
/* Wire types — the subset of the Messages schema we read or write           */
/* ------------------------------------------------------------------------- */

interface WireMessage {
  role: 'user' | 'assistant'
  content: WireContentBlock[]
}

type WireContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

interface WireTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

interface WireUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

interface WireError {
  type?: string
  message?: string
}

interface WireResponseBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}

interface WireMessageResponse {
  type?: string
  model?: string
  content?: WireResponseBlock[]
  stop_reason?: string | null
  usage?: WireUsage
  error?: WireError
}

/**
 * One frame of a streamed message.
 *
 * Every field is optional because every field genuinely is: a frame carries only
 * what its own event type defines, and the six types share almost nothing.
 */
interface WireStreamEvent {
  type?: string
  index?: number
  message?: { model?: string; usage?: WireUsage }
  content_block?: { type?: string; text?: string; id?: string; name?: string }
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    stop_reason?: string | null
  }
  usage?: WireUsage
  error?: WireError
}
