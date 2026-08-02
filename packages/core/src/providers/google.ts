import {
  AuthenticationError,
  ConfigurationError,
  ProviderError,
  RateLimitError,
} from '../errors/errors.js'
import { readFirstEnv } from '../util/env.js'
import { redactHeaders } from '../util/redact.js'
import { parseSseStream } from './sse.js'
import { toGeminiSchema } from './google-schema.js'
import {
  extractErrorMessage,
  linkSignals,
  parseRetryAfter,
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
 * Gemini, natively, over the Generative Language API.
 *
 * `fetch` only — no `@google/genai` — for the same reason as every other
 * provider here: an empty dependency tree is the product.
 *
 * Gemini diverges from the OpenAI shape more than Anthropic does:
 *
 *   1. Roles are `user` / **`model`**, and content is `parts`, not blocks.
 *   2. Tool schemas must be an OpenAPI 3.0 subset — see `google-schema.ts`,
 *      without which every tool this SDK produces would be rejected.
 *   3. Function calls carry **no id**, so one is synthesized positionally.
 *   4. Streaming frames each carry a *complete* response, and function calls
 *      arrive whole rather than as JSON fragments.
 */

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export interface GoogleOptions {
  /** Defaults to `GEMINI_API_KEY`, then `GOOGLE_API_KEY`. */
  readonly apiKey?: string
  /** Defaults to `https://generativelanguage.googleapis.com/v1beta`. */
  readonly baseUrl?: string
  /**
   * Merged into every request body, overriding what the SDK would otherwise
   * send — `{ safetySettings: [...] }`, `{ cachedContent: '...' }`, or a
   * `generationConfig` with a `thinkingConfig`.
   *
   * `generationConfig` is shallow-merged rather than replaced, so setting
   * `safetySettings` cannot silently wipe `maxOutputTokens`.
   */
  readonly defaultBody?: Readonly<Record<string, unknown>>
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof globalThis.fetch
}

/**
 * A Gemini model, via `generateContent`.
 *
 * ```ts
 * const agent = new Agent({
 *   name: 'assistant',
 *   model: google('gemini-2.5-pro'),
 * })
 * ```
 *
 * Also exported as `gemini`, because that is what people type.
 */
export function google(modelId: string, options: GoogleOptions = {}): ModelProvider {
  const apiKey = options.apiKey ?? readFirstEnv('GEMINI_API_KEY', 'GOOGLE_API_KEY')

  if (!apiKey) {
    throw new ConfigurationError('No Google API key found.', {
      hint:
        'Set the GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable, or pass ' +
        "google('model-id', { apiKey }).",
    })
  }

  const config: ResolvedConfig = {
    providerId: 'google',
    modelId,
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
    apiKey,
    // Accepts `gemini-2.5-pro`, `models/gemini-2.5-pro`, and `tunedModels/x`
    // without ever producing `models/models/…`.
    resource: modelId.includes('/') ? modelId : `models/${modelId}`,
    headers: { ...options.headers },
    ...(options.defaultBody ? { defaultBody: options.defaultBody } : {}),
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
        response = await doFetch(`${config.baseUrl}/${config.resource}:generateContent`, {
          method: 'POST',
          headers,
          body: JSON.stringify(buildRequestBody(request, config)),
          ...(signal ? { signal } : {}),
        })
      } catch (cause) {
        throw toTransportError(cause, config.providerId, callOptions)
      } finally {
        dispose()
      }

      if (!response.ok) throw await toHttpError(response, config, headers)

      let payload: WireResponse
      try {
        payload = (await response.json()) as WireResponse
      } catch (cause) {
        throw new ProviderError('google returned a response that is not valid JSON.', {
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
      const { signal, dispose } = linkSignals(callOptions.signal, callOptions.timeoutMs)

      try {
        let response: Response
        try {
          // `?alt=sse` is mandatory, not cosmetic: without it the endpoint
          // returns a streamed JSON *array* and the SSE framer sees no frames.
          response = await doFetch(
            `${config.baseUrl}/${config.resource}:streamGenerateContent?alt=sse`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify(buildRequestBody(request, config)),
              ...(signal ? { signal } : {}),
            },
          )
        } catch (cause) {
          throw toTransportError(cause, config.providerId, callOptions)
        }

        if (!response.ok) throw await toHttpError(response, config, headers)

        if (!response.body) {
          throw new ProviderError('google returned no response body for a streaming request.', {
            status: response.status,
          })
        }

        yield* decodeContentStream(response.body, config, callOptions)
      } finally {
        dispose()
      }
    },
  }
}

/** `gemini` is the name people reach for; `google` is the vendor. Both work. */
export { google as gemini }

interface ResolvedConfig {
  readonly providerId: string
  readonly modelId: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly resource: string
  readonly headers: Readonly<Record<string, string>>
  readonly defaultBody?: Readonly<Record<string, unknown>>
}

function buildHeaders(config: ResolvedConfig, options: ModelCallOptions): Record<string, string> {
  return {
    'content-type': 'application/json',
    // A header, never `?key=` — a credential in a URL leaks into error
    // messages, proxy access logs, and referrers. `redact.ts` already knows
    // this header name, so it can never reach `error.details` either.
    'x-goog-api-key': config.apiKey,
    ...config.headers,
    ...options.headers,
  }
}

/* ------------------------------------------------------------------------- */
/* Request translation: our format → the generateContent wire format         */
/* ------------------------------------------------------------------------- */

function buildRequestBody(request: ModelRequest, config: ResolvedConfig): Record<string, unknown> {
  const { systemText, contents } = toWireContents(request)

  const body: Record<string, unknown> = { contents }

  if (systemText.length > 0) {
    body['systemInstruction'] = { parts: [{ text: systemText }] }
  }

  const generationConfig: Record<string, unknown> = {}
  if (request.maxOutputTokens !== undefined) {
    generationConfig['maxOutputTokens'] = request.maxOutputTokens
  }
  if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature
  if (request.stopSequences?.length) generationConfig['stopSequences'] = [...request.stopSequences]

  if (request.tools?.length) {
    // One wrapper object holding every declaration — not one object per tool.
    body['tools'] = [{ functionDeclarations: request.tools.map(toWireTool) }]
    const toolConfig = toWireToolConfig(request.toolChoice)
    if (toolConfig !== undefined) body['toolConfig'] = toolConfig
  } else if (request.responseFormat?.type === 'json') {
    // Structured output is emitted only when there are *no* tools. Gemini does
    // not reliably support `responseSchema` alongside `functionDeclarations` —
    // depending on the model it 400s or silently stops calling functions — and
    // an agent with both tools and an `outputSchema` is an ordinary
    // configuration here. With tools present, `run/output.ts` falls back to its
    // prompt-instruction and repair layers, which is what they are for.
    generationConfig['responseMimeType'] = 'application/json'
    if (request.responseFormat.schema) {
      generationConfig['responseSchema'] = toGeminiSchema(request.responseFormat.schema)
    }
  }

  // `request.metadata` has no wire equivalent, and Gemini rejects unknown
  // top-level keys, so it is dropped rather than forwarded.

  const overrides = { ...config.defaultBody, ...request.providerOptions }

  // `generationConfig` is merged rather than replaced: an override that only
  // wanted to add `safetySettings` should not silently drop `maxOutputTokens`.
  const merged = { ...generationConfig, ...asRecord(overrides['generationConfig']) }

  return {
    ...body,
    ...overrides,
    ...(Object.keys(merged).length > 0 ? { generationConfig: merged } : {}),
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Builds `contents`, hoisting any system text out to `systemInstruction`.
 *
 * Adjacent same-role turns are merged: Gemini is happier with an alternating
 * transcript, and a replayed session can easily produce two user turns in a row.
 */
function toWireContents(request: ModelRequest): {
  systemText: string
  contents: WireContent[]
} {
  const systemParts: string[] = []
  if (request.system && request.system.trim().length > 0) systemParts.push(request.system)

  const contents: WireContent[] = []

  for (const message of request.messages) {
    if (message.role === 'system') {
      if (message.content.trim().length > 0) systemParts.push(message.content)
      continue
    }

    const next = toWireContent(message)
    if (next.parts.length === 0) continue

    const previous = contents[contents.length - 1]
    if (previous && previous.role === next.role) {
      previous.parts.push(...next.parts)
      continue
    }

    contents.push(next)
  }

  return { systemText: systemParts.join('\n\n'), contents }
}

function toWireContent(message: Exclude<ModelMessage, { role: 'system' }>): WireContent {
  switch (message.role) {
    case 'user':
      return {
        role: 'user',
        parts:
          typeof message.content === 'string'
            ? [{ text: message.content }]
            : message.content.map((part) => ({ text: part.text })),
      }

    case 'assistant': {
      const parts: WirePart[] = []
      for (const part of message.content) {
        if (part.type === 'text') {
          if (part.text.length > 0) parts.push({ text: part.text })
        } else {
          // `args` is an object here, not a JSON string.
          parts.push({ functionCall: { name: part.toolName, args: part.input ?? {} } })
        }
      }
      // Gemini's assistant role is `model`.
      return { role: 'model', parts }
    }

    case 'tool':
      // No `tool` role exists; results come back as a user turn of
      // `functionResponse` parts, correlated by tool *name* rather than by id.
      return {
        role: 'user',
        parts: message.content.map((part) => ({
          functionResponse: {
            name: part.toolName,
            // Must be a JSON object. Tool output is `unknown` — a string,
            // number, or array would be rejected — so it is always wrapped.
            response: {
              result: part.output,
              ...(part.isError ? { error: true } : {}),
            },
          },
        })),
      }
  }
}

function toWireTool(tool: ToolDefinition): WireFunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    // Sanitized, not passed through: see `google-schema.ts` for why this is
    // load-bearing rather than defensive.
    parameters: toGeminiSchema(tool.parameters),
  }
}

function toWireToolConfig(choice: ToolChoice | undefined): unknown {
  if (choice === undefined || choice === 'auto') return undefined
  if (choice === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (choice === 'required') return { functionCallingConfig: { mode: 'ANY' } }
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [choice.name] } }
}

/* ------------------------------------------------------------------------- */
/* Response translation: the generateContent wire format → our format        */
/* ------------------------------------------------------------------------- */

function parseResponse(payload: WireResponse, config: ResolvedConfig): ModelResponse {
  const candidate = payload.candidates?.[0]

  if (!candidate) {
    // A prompt blocked by a safety filter comes back with no candidates at all.
    // Reading `candidates[0].content` here would be a TypeError instead of a
    // message naming the reason.
    const blockReason = payload.promptFeedback?.blockReason
    throw new ProviderError(
      blockReason ? `google blocked the prompt: ${blockReason}` : 'google returned no candidates.',
      {
        hint: blockReason
          ? 'Adjust the prompt, or relax `safetySettings` via providerOptions.'
          : 'This usually means the model id is wrong or the request was filtered.',
        details: { modelId: config.modelId, ...(blockReason ? { blockReason } : {}) },
      },
    )
  }

  const content = toContentParts(candidate.content?.parts ?? [])

  return {
    content,
    finishReason: mapFinishReason(candidate.finishReason, content),
    usage: mapUsage(payload.usageMetadata),
    modelId: payload.modelVersion ?? config.modelId,
    raw: payload,
  }
}

/**
 * Maps wire parts to neutral content, in order.
 *
 * `thought` parts are skipped: Gemini 2.5 models think by default, and letting
 * reasoning into `result.text` would corrupt `extractJson` on a
 * structured-output run.
 */
function toContentParts(parts: readonly WirePart[]): (TextPart | ToolCallPart)[] {
  const content: (TextPart | ToolCallPart)[] = []
  let ordinal = 0

  for (const part of parts) {
    if (part.thought === true) continue

    if (typeof part.text === 'string' && part.text.length > 0) {
      content.push({ type: 'text', text: part.text })
    } else if (part.functionCall?.name) {
      content.push({
        type: 'tool-call',
        toolCallId: synthesizeToolCallId(part.functionCall, ordinal),
        toolName: part.functionCall.name,
        input: part.functionCall.args ?? {},
      })
      ordinal += 1
    }
  }

  return content
}

/**
 * Gemini's `functionCall` carries no id.
 *
 * The id is synthesized positionally rather than randomly, and deliberately: it
 * only has to be unique within a turn and stable between the streamed chunks
 * and the finish chunk, and a deterministic value makes both the round-trip and
 * the tests exact rather than pattern-matched. A vendor-supplied `id` is
 * preferred when one appears — newer surfaces have started sending them.
 *
 * Nothing decodes it: the result goes back to Gemini keyed by function *name*.
 */
function synthesizeToolCallId(call: WireFunctionCall, ordinal: number): string {
  return call.id ?? `${call.name}_${ordinal}`
}

/**
 * Decodes the `?alt=sse` stream.
 *
 * Unlike OpenAI and Anthropic, every Gemini frame carries a complete
 * `GenerateContentResponse` and function calls arrive **whole** — Gemini never
 * fragments argument JSON. So a call is emitted as a single `tool-call-delta`
 * holding its entire serialized input, which is honest: the runner concatenates
 * `inputDelta` per id, and one whole chunk concatenates to valid JSON.
 */
async function* decodeContentStream(
  body: ReadableStream<Uint8Array>,
  config: ResolvedConfig,
  options: ModelCallOptions,
): AsyncGenerator<ModelStreamChunk> {
  let text = ''
  const calls: ToolCallPart[] = []
  let finishReason: string | undefined
  let servingModel: string | undefined
  let usage: WireUsage | undefined
  let parsedFrames = 0

  try {
    for await (const event of parseSseStream(body)) {
      if (event.data === '[DONE]') break

      let payload: WireResponse
      try {
        payload = JSON.parse(event.data) as WireResponse
      } catch {
        // Tolerate a single unparsable frame; a stream where nothing parsed is
        // a different problem, caught below.
        continue
      }
      parsedFrames += 1

      if (payload.promptFeedback?.blockReason) {
        throw new ProviderError(
          `google blocked the prompt: ${payload.promptFeedback.blockReason}`,
          {
            details: { blockReason: payload.promptFeedback.blockReason },
          },
        )
      }

      if (payload.modelVersion) servingModel = payload.modelVersion
      // Repeated on every frame; the last one is authoritative.
      if (payload.usageMetadata) usage = payload.usageMetadata

      const candidate = payload.candidates?.[0]
      if (!candidate) continue
      if (candidate.finishReason) finishReason = candidate.finishReason

      for (const part of candidate.content?.parts ?? []) {
        if (part.thought === true) continue

        if (typeof part.text === 'string' && part.text.length > 0) {
          text += part.text
          yield { type: 'text-delta', text: part.text }
        } else if (part.functionCall?.name) {
          const toolCallId = synthesizeToolCallId(part.functionCall, calls.length)
          const input = part.functionCall.args ?? {}
          calls.push({
            type: 'tool-call',
            toolCallId,
            toolName: part.functionCall.name,
            input,
          })
          yield {
            type: 'tool-call-delta',
            toolCallId,
            toolName: part.functionCall.name,
            inputDelta: JSON.stringify(input),
          }
        }
      }
    }
  } catch (cause) {
    throw toTransportError(cause, config.providerId, options)
  }

  if (parsedFrames === 0) {
    throw new ProviderError('google returned a malformed event stream.', {
      hint: 'The endpoint may not support streaming, or returned a non-SSE body.',
      details: { modelId: config.modelId },
    })
  }

  const content: (TextPart | ToolCallPart)[] = []
  if (text.length > 0) content.push({ type: 'text', text })
  content.push(...calls)

  yield {
    type: 'finish',
    response: {
      content,
      finishReason: mapFinishReason(finishReason, content),
      usage: mapUsage(usage),
      modelId: servingModel ?? config.modelId,
      raw: { streamed: true, frames: parsedFrames },
    },
  }
}

function mapFinishReason(
  reason: string | undefined,
  content: readonly (TextPart | ToolCallPart)[],
): FinishReason {
  if (content.some((part) => part.type === 'tool-call')) return 'tool_calls'

  switch (reason) {
    case 'STOP':
      return 'stop'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'content_filter'
    default:
      return reason ? 'other' : 'stop'
  }
}

/**
 * Maps `usageMetadata`.
 *
 * `thoughtsTokenCount` is billed as output but **excluded** from
 * `candidatesTokenCount`, so it is folded in — mirroring OpenAI, where
 * `completion_tokens` already includes reasoning and `reasoningTokens` is the
 * reported subset. `promptTokenCount`, by contrast, already includes cached
 * tokens, so nothing is added there.
 */
function mapUsage(usage: WireUsage | undefined): Usage {
  const inputTokens = usage?.promptTokenCount ?? 0
  const reasoning = usage?.thoughtsTokenCount ?? 0
  const outputTokens = (usage?.candidatesTokenCount ?? 0) + reasoning
  const cached = usage?.cachedContentTokenCount

  return {
    inputTokens,
    outputTokens,
    totalTokens: usage?.totalTokenCount ?? inputTokens + outputTokens,
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(reasoning ? { reasoningTokens: reasoning } : {}),
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
  const status = extractErrorStatus(bodyText)

  const details = {
    status: response.status,
    providerId: config.providerId,
    ...(status ? { googleStatus: status } : {}),
    requestHeaders: redactHeaders(requestHeaders),
  }

  // Gemini reports a bad key as 400 INVALID_ARGUMENT, not 401. Left
  // unclassified it reads as a non-retryable "provider error" with no hint,
  // which is the single most confusing failure a new user can hit.
  const looksLikeBadKey = /api[\s_-]?key/i.test(bodyText) || bodyText.includes('API_KEY_INVALID')

  if (
    response.status === 401 ||
    response.status === 403 ||
    (response.status === 400 && looksLikeBadKey)
  ) {
    return new AuthenticationError(`google rejected the API key: ${message}`, {
      hint: 'Check the key is correct, active, and has access to this model.',
      details,
    })
  }

  if (response.status === 429) {
    // Gemini prefers a `RetryInfo` entry in `error.details` over the header.
    const retryAfter =
      parseRetryInfo(bodyText) ?? parseRetryAfter(response.headers.get('retry-after'))
    return new RateLimitError(`google rate-limited the request: ${message}`, {
      ...(retryAfter !== undefined
        ? { retryAfterMs: retryAfter, hint: `Retry after ${Math.ceil(retryAfter / 1000)}s.` }
        : {}),
      details,
    })
  }

  if (response.status === 404) {
    return new ProviderError(`google could not find the requested model: ${message}`, {
      status: 404,
      hint: 'Verify the model id and the API version in `baseUrl` — Gemini ids are exact strings.',
      details,
    })
  }

  if (response.status === 400) {
    return new ProviderError(`google rejected the request: ${message}`, {
      status: 400,
      ...(/schema|additionalProperties|Invalid JSON payload/i.test(bodyText)
        ? {
            hint:
              'Gemini accepts only an OpenAPI 3.0 subset of JSON Schema. If a tool schema ' +
              'triggered this, the sanitizer in providers/google-schema.ts has a gap.',
          }
        : {}),
      details,
    })
  }

  return new ProviderError(`google returned ${response.status}: ${message}`, {
    status: response.status,
    details,
  })
}

function extractErrorStatus(bodyText: string): string | undefined {
  if (!bodyText) return undefined
  try {
    const parsed = JSON.parse(bodyText) as { error?: { status?: string } }
    return parsed.error?.status
  } catch {
    return undefined
  }
}

/**
 * Reads `error.details[].retryDelay` (`"27s"`) into milliseconds.
 *
 * Worth parsing even though it can *stop* retries: `run/retry.ts` refuses a
 * backoff longer than `maxRetryDelayMs` and moves to the next provider in the
 * `fallbacks` chain. That is the right outcome — better than burning the whole
 * retry budget on sub-10s backoffs that immediately re-429.
 */
function parseRetryInfo(bodyText: string): number | undefined {
  if (!bodyText) return undefined
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { details?: { '@type'?: string; retryDelay?: string }[] }
    }
    for (const detail of parsed.error?.details ?? []) {
      if (!detail['@type']?.endsWith('RetryInfo')) continue
      const match = /^([\d.]+)s$/.exec(detail.retryDelay ?? '')
      if (match?.[1]) return Math.round(Number(match[1]) * 1000)
    }
  } catch {
    // Fall through to the header.
  }
  return undefined
}

/* ------------------------------------------------------------------------- */
/* Wire types — the subset of the Gemini schema we read or write             */
/* ------------------------------------------------------------------------- */

interface WireContent {
  role: 'user' | 'model'
  parts: WirePart[]
}

interface WireFunctionCall {
  name?: string
  args?: unknown
  /** Absent on `v1beta`; preferred when a newer surface supplies one. */
  id?: string
}

interface WirePart {
  text?: string
  thought?: boolean
  functionCall?: WireFunctionCall
  functionResponse?: { name: string; response: unknown }
}

interface WireFunctionDeclaration {
  name: string
  description: string
  parameters: Record<string, unknown>
}

interface WireUsage {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
}

interface WireResponse {
  modelVersion?: string
  usageMetadata?: WireUsage
  promptFeedback?: { blockReason?: string }
  candidates?: {
    finishReason?: string
    content?: { role?: string; parts?: WirePart[] }
  }[]
}
