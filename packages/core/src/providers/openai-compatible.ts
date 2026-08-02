import {
  AgentError,
  AuthenticationError,
  ConfigurationError,
  NetworkError,
  ProviderError,
  RateLimitError,
  TimeoutError,
} from '../errors/errors.js'
import { redactHeaders } from '../util/redact.js'
import { safeStringify } from '../util/stringify.js'
import { parseSseStream } from './sse.js'
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
 * One provider implementation for the entire OpenAI-compatible ecosystem:
 * OpenRouter, OpenAI, Groq, Together, Fireworks, DeepSeek, xAI, Ollama, vLLM,
 * LM Studio — anything exposing `POST /chat/completions`.
 *
 * It is built on `fetch` alone. No vendor SDK, no dependency, no version
 * coupling: the whole reason `just-another-sdk` installs with an empty
 * dependency tree and runs unchanged on Node, Bun, Deno, and edge runtimes.
 *
 * Everything vendor-shaped lives in this file. The agent loop above it deals
 * only in `ModelRequest`/`ModelResponse`, so adding a non-OpenAI-shaped vendor
 * (Anthropic's Messages API, Gemini's `generateContent`) means writing a sibling
 * file — never touching the runtime.
 */

export interface OpenAICompatibleConfig {
  /** Appears in traces, e.g. `'openrouter'`. */
  readonly providerId: string
  /** Model identifier passed through verbatim to the vendor. */
  readonly modelId: string
  /** Base URL *without* a trailing slash, e.g. `https://api.openai.com/v1`. */
  readonly baseUrl: string
  /** Resolved API key. Sent as `Authorization: Bearer`. */
  readonly apiKey: string
  /** Extra headers merged into every request. */
  readonly headers?: Readonly<Record<string, string>>
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  /** Merged into every request body — for vendor-only fields. */
  readonly defaultBody?: Readonly<Record<string, unknown>>
}

export function createOpenAICompatibleProvider(config: OpenAICompatibleConfig): ModelProvider {
  if (!config.apiKey) {
    throw new ConfigurationError(`No API key was provided for "${config.providerId}".`)
  }

  const doFetch = config.fetch ?? globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new ConfigurationError('No global `fetch` is available in this runtime.', {
      hint: 'Use Node 20.19+, or pass a `fetch` implementation to the provider.',
    })
  }

  return {
    providerId: config.providerId,
    modelId: config.modelId,

    async generate(request: ModelRequest, options: ModelCallOptions = {}): Promise<ModelResponse> {
      const url = `${config.baseUrl}/chat/completions`
      const body = buildRequestBody(config.modelId, request, config.defaultBody)

      const headers = buildHeaders(config, options)

      const { signal, dispose } = linkSignals(options.signal, options.timeoutMs)

      let response: Response
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          // Spread conditionally: `signal: undefined` is not the same as absent
          // under exactOptionalPropertyTypes, and RequestInit wants null-or-set.
          ...(signal ? { signal } : {}),
        })
      } catch (cause) {
        throw toTransportError(cause, config.providerId, options)
      } finally {
        dispose()
      }

      if (!response.ok) {
        throw await toHttpError(response, config.providerId, headers)
      }

      let payload: ChatCompletionResponse
      try {
        payload = (await response.json()) as ChatCompletionResponse
      } catch (cause) {
        throw new ProviderError(
          `${config.providerId} returned a response that is not valid JSON.`,
          { cause, status: response.status },
        )
      }

      return parseResponse(payload, config)
    },

    async *stream(
      request: ModelRequest,
      options: ModelCallOptions = {},
    ): AsyncGenerator<ModelStreamChunk> {
      const url = `${config.baseUrl}/chat/completions`
      const body = buildRequestBody(config.modelId, request, config.defaultBody, { stream: true })

      const headers = buildHeaders(config, options)

      // The same deadline `generate()` uses, with one semantic difference worth
      // knowing: it now bounds the *whole* stream, not time-to-first-byte.
      const { signal, dispose } = linkSignals(options.signal, options.timeoutMs)

      try {
        let response: Response
        try {
          response = await doFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            ...(signal ? { signal } : {}),
          })
        } catch (cause) {
          throw toTransportError(cause, config.providerId, options)
        }

        if (!response.ok) {
          throw await toHttpError(response, config.providerId, headers)
        }

        if (!response.body) {
          throw new ProviderError(
            `${config.providerId} returned no response body for a streaming request.`,
            {
              status: response.status,
              hint: 'The provider may not support `stream: true` on this endpoint.',
            },
          )
        }

        yield* decodeChatCompletionStream(response.body, config, options)
      } finally {
        dispose()
      }
    },
  }
}

function buildHeaders(
  config: OpenAICompatibleConfig,
  options: ModelCallOptions,
): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${config.apiKey}`,
    ...config.headers,
    ...options.headers,
  }
}

/* ------------------------------------------------------------------------- */
/* Request translation: our format → OpenAI wire format                      */
/* ------------------------------------------------------------------------- */

function buildRequestBody(
  modelId: string,
  request: ModelRequest,
  defaultBody: Readonly<Record<string, unknown>> | undefined,
  options: { readonly stream: boolean } = { stream: false },
): Record<string, unknown> {
  const messages: WireMessage[] = []

  // The system prompt is hoisted out of the conversation and always sent first.
  if (request.system && request.system.trim().length > 0) {
    messages.push({ role: 'system', content: request.system })
  }

  for (const message of request.messages) {
    messages.push(...toWireMessages(message))
  }

  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    // Emitted *before* the user's overrides on purpose. A handful of
    // OpenAI-compatible servers (older vLLM, some Ollama builds) reject
    // `stream_options` with a 400, and `providerOptions: { stream_options: null }`
    // is the escape hatch.
    ...(options.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    ...defaultBody,
    ...request.providerOptions,
  }

  if (request.maxOutputTokens !== undefined) body['max_tokens'] = request.maxOutputTokens
  if (request.temperature !== undefined) body['temperature'] = request.temperature
  if (request.stopSequences?.length) body['stop'] = [...request.stopSequences]
  if (request.metadata) body['metadata'] = request.metadata

  if (request.tools?.length) {
    body['tools'] = request.tools.map(toWireTool)
    const choice = toWireToolChoice(request.toolChoice)
    if (choice !== undefined) body['tool_choice'] = choice
  }

  if (request.responseFormat?.type === 'json') {
    body['response_format'] = request.responseFormat.schema
      ? {
          type: 'json_schema',
          json_schema: {
            name: request.responseFormat.name ?? 'response',
            schema: request.responseFormat.schema,
            strict: true,
          },
        }
      : { type: 'json_object' }
  }

  return body
}

function toWireMessages(message: ModelMessage): WireMessage[] {
  switch (message.role) {
    case 'system':
      return [{ role: 'system', content: message.content }]

    case 'user':
      return [
        {
          role: 'user',
          content:
            typeof message.content === 'string'
              ? message.content
              : message.content.map((part) => part.text).join(''),
        },
      ]

    case 'assistant': {
      const text = message.content
        .filter((part): part is TextPart => part.type === 'text')
        .map((part) => part.text)
        .join('')

      const toolCalls = message.content
        .filter((part): part is ToolCallPart => part.type === 'tool-call')
        .map((part) => ({
          id: part.toolCallId,
          type: 'function' as const,
          function: {
            name: part.toolName,
            arguments: JSON.stringify(part.input ?? {}),
          },
        }))

      return [
        {
          role: 'assistant',
          // `null` rather than `''`: some vendors reject an empty string on a
          // message that carries tool calls.
          content: text.length > 0 ? text : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
      ]
    }

    case 'tool':
      // Each result becomes its own `role: 'tool'` message, correlated by id.
      // The output must reach the model as a string, and `safeStringify` keeps it
      // informative — a plain `String(obj)` would send '[object Object]'.
      return message.content.map((part) => ({
        role: 'tool' as const,
        tool_call_id: part.toolCallId,
        content: safeStringify(part.output),
      }))
  }
}

function toWireTool(tool: ToolDefinition): WireTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function toWireToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined || choice === 'auto') return undefined
  if (choice === 'none') return 'none'
  if (choice === 'required') return 'required'
  return { type: 'function', function: { name: choice.name } }
}

/* ------------------------------------------------------------------------- */
/* Response translation: OpenAI wire format → our format                     */
/* ------------------------------------------------------------------------- */

function parseResponse(
  payload: ChatCompletionResponse,
  config: OpenAICompatibleConfig,
): ModelResponse {
  // Some gateways return HTTP 200 with an error body instead of a 4xx/5xx.
  if (payload.error) {
    throw new ProviderError(
      `${config.providerId}: ${payload.error.message ?? 'unknown provider error'}`,
      { details: { code: payload.error.code, type: payload.error.type } },
    )
  }

  const choice = payload.choices?.[0]
  if (!choice) {
    throw new ProviderError(`${config.providerId} returned no choices.`, {
      hint: 'This usually means the model id is wrong or the request was filtered.',
      details: { modelId: config.modelId },
    })
  }

  const content: (TextPart | ToolCallPart)[] = []

  const text = choice.message?.content
  if (typeof text === 'string' && text.length > 0) {
    content.push({ type: 'text', text })
  }

  for (const call of choice.message?.tool_calls ?? []) {
    content.push({
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.function.name,
      input: parseToolArguments(call.function.arguments),
    })
  }

  return {
    content,
    finishReason: mapFinishReason(choice.finish_reason, content),
    usage: mapUsage(payload.usage),
    modelId: payload.model ?? config.modelId,
    raw: payload,
  }
}

/**
 * Turns a chat-completions SSE body into `ModelStreamChunk`s, then one final
 * `finish` chunk carrying a fully-formed `ModelResponse`.
 *
 * The response is assembled through the exact same helpers `parseResponse` uses,
 * so a streamed turn and a non-streamed turn are indistinguishable downstream —
 * including the tolerant `__unparsedArguments` path for a truncated tool call.
 */
async function* decodeChatCompletionStream(
  body: ReadableStream<Uint8Array>,
  config: OpenAICompatibleConfig,
  options: ModelCallOptions,
): AsyncGenerator<ModelStreamChunk> {
  let text = ''
  // Keyed by the wire's `index`, which is the only thing correlating a
  // fragment to its call — `id` and `name` arrive once and never repeat.
  const toolCalls = new Map<number, { id: string; name: string; args: string }>()
  let finishReason: string | null | undefined
  let usage: WireUsage | undefined
  let servingModel: string | undefined
  let parsedFrames = 0

  try {
    for await (const event of parseSseStream(body)) {
      // The terminator is not JSON and must never be parsed as such.
      if (event.data === '[DONE]') break

      let payload: ChatCompletionChunk
      try {
        payload = JSON.parse(event.data) as ChatCompletionChunk
      } catch {
        // Tolerate one bad frame — a truncated keep-alive, a gateway artefact.
        // A stream where *nothing* parsed is a different problem, caught below.
        continue
      }
      parsedFrames += 1

      // Some gateways report failure mid-stream instead of with a status code.
      // Thrown in the same shape `parseResponse` uses for a 200-with-error-body,
      // so `run()` and `stream()` fail identically.
      if (payload.error) {
        throw new ProviderError(
          `${config.providerId}: ${payload.error.message ?? 'unknown provider error'}`,
          { details: { code: payload.error.code, type: payload.error.type } },
        )
      }

      if (payload.model) servingModel = payload.model
      // With `include_usage`, totals arrive in a final chunk whose `choices` is [].
      if (payload.usage) usage = payload.usage

      const choice = payload.choices?.[0]
      if (!choice) continue

      if (choice.finish_reason) finishReason = choice.finish_reason

      const delta = choice.delta
      if (!delta) continue

      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content
        yield { type: 'text-delta', text: delta.content }
      }

      for (const fragment of delta.tool_calls ?? []) {
        const index = fragment.index ?? 0
        const slot = toolCalls.get(index) ?? {
          // Synthesized only for a vendor that never sends an id. It stays
          // stable for the whole stream, so the `tool_call_id` echoed back to
          // the model matches what we reported.
          id: fragment.id ?? `call_${index}`,
          name: '',
          args: '',
        }

        if (fragment.id) slot.id = fragment.id
        if (fragment.function?.name) slot.name = fragment.function.name
        if (fragment.function?.arguments) slot.args += fragment.function.arguments
        toolCalls.set(index, slot)

        yield {
          type: 'tool-call-delta',
          toolCallId: slot.id,
          ...(slot.name ? { toolName: slot.name } : {}),
          inputDelta: fragment.function?.arguments ?? '',
        }
      }
    }
  } catch (cause) {
    // Covers a mid-stream socket reset, a run-level abort, and the per-call
    // deadline — all already classified correctly by the shared mapper.
    throw toTransportError(cause, config.providerId, options)
  }

  if (parsedFrames === 0) {
    throw new ProviderError(`${config.providerId} returned a malformed event stream.`, {
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
      input: parseToolArguments(call.args),
    })
  }

  yield {
    type: 'finish',
    response: {
      content,
      finishReason: mapFinishReason(finishReason, content),
      usage: mapUsage(usage),
      modelId: servingModel ?? config.modelId,
      // A stream has no single payload, and buffering every frame to synthesize
      // one would defeat the point. A summary is the honest thing to expose.
      raw: { streamed: true, frames: parsedFrames },
    },
  }
}

/**
 * Tool arguments arrive as a JSON *string*. A model can emit malformed JSON, and
 * that must not crash the run — an unparsable payload is handed to the tool layer
 * as-is, where schema validation rejects it and the model gets a chance to fix
 * its own mistake.
 */
function parseToolArguments(raw: string | undefined): unknown {
  if (!raw || raw.trim().length === 0) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { __unparsedArguments: raw }
  }
}

function mapFinishReason(
  reason: string | null | undefined,
  content: readonly (TextPart | ToolCallPart)[],
): FinishReason {
  // Trust the content over the flag: several gateways report `stop` while still
  // returning tool calls, and acting on the flag would end the loop early.
  if (content.some((part) => part.type === 'tool-call')) return 'tool_calls'

  switch (reason) {
    case 'stop':
    case 'end_turn':
      return 'stop'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    case 'length':
    case 'max_tokens':
      return 'length'
    case 'content_filter':
      return 'content_filter'
    default:
      return reason ? 'other' : 'stop'
  }
}

function mapUsage(usage: WireUsage | undefined): Usage {
  const inputTokens = usage?.prompt_tokens ?? 0
  const outputTokens = usage?.completion_tokens ?? 0
  const cached = usage?.prompt_tokens_details?.cached_tokens
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens

  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.total_tokens ?? inputTokens + outputTokens,
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
  }
}

/* ------------------------------------------------------------------------- */
/* Error translation                                                         */
/* ------------------------------------------------------------------------- */

async function toHttpError(
  response: Response,
  providerId: string,
  requestHeaders: Record<string, string>,
): Promise<Error> {
  const bodyText = await response.text().catch(() => '')
  const message = extractErrorMessage(bodyText) ?? (response.statusText || 'request failed')

  // Redacted so a debug log of `details` can never surface the API key.
  const details = {
    status: response.status,
    providerId,
    requestHeaders: redactHeaders(requestHeaders),
  }

  if (response.status === 401 || response.status === 403) {
    return new AuthenticationError(`${providerId} rejected the API key: ${message}`, {
      hint: 'Check the key is correct, active, and has access to this model.',
      details,
    })
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
    return new RateLimitError(`${providerId} rate-limited the request: ${message}`, {
      ...(retryAfter !== undefined
        ? { retryAfterMs: retryAfter, hint: `Retry after ${Math.ceil(retryAfter / 1000)}s.` }
        : {}),
      details,
    })
  }

  if (response.status === 404) {
    return new ProviderError(`${providerId} could not find the requested model: ${message}`, {
      status: 404,
      hint: 'Verify the model id — provider model ids are exact strings, not aliases.',
      details,
    })
  }

  return new ProviderError(`${providerId} returned ${response.status}: ${message}`, {
    status: response.status,
    details,
  })
}

function extractErrorMessage(bodyText: string): string | undefined {
  if (!bodyText) return undefined
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string }; message?: string }
    return parsed.error?.message ?? parsed.message ?? bodyText.slice(0, 300)
  } catch {
    return bodyText.slice(0, 300)
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds * 1000
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

function toTransportError(cause: unknown, providerId: string, options: ModelCallOptions): Error {
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

function isAbortLike(value: unknown): boolean {
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
function linkSignals(
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

/* ------------------------------------------------------------------------- */
/* Wire types — the subset of the OpenAI schema we read or write             */
/* ------------------------------------------------------------------------- */

type WireMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface WireTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

interface ChatCompletionResponse {
  model?: string
  usage?: WireUsage
  error?: { message?: string; code?: string; type?: string }
  choices?: {
    finish_reason?: string | null
    message?: {
      content?: string | null
      tool_calls?: WireToolCall[]
    }
  }[]
}

/**
 * One SSE frame of a streamed completion.
 *
 * Everything is optional because every field genuinely is: a chunk may carry
 * only a token, only a tool-call fragment, only `usage` (the final
 * `include_usage` frame, whose `choices` is empty), or only a finish reason.
 */
interface ChatCompletionChunk {
  model?: string
  usage?: WireUsage
  error?: { message?: string; code?: string; type?: string }
  choices?: {
    finish_reason?: string | null
    delta?: {
      content?: string | null
      tool_calls?: WireToolCallDelta[]
    }
  }[]
}

/** A tool call arriving in pieces. Only `index` is present on every fragment. */
interface WireToolCallDelta {
  index?: number
  id?: string
  type?: 'function'
  function?: { name?: string; arguments?: string }
}
