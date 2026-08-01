import type { ObjectJsonSchema } from '../types/json-schema.js'
import type { ModelMessage, TextPart, ToolCallPart, Usage } from '../types/messages.js'

/**
 * The provider contract — the seam between the agent loop and any vendor.
 *
 * A provider is responsible for exactly three things:
 *   1. translating a `ModelRequest` into its vendor's wire format,
 *   2. performing the HTTP call,
 *   3. translating the vendor's response back into a `ModelResponse`, and its
 *      errors into the SDK's error types.
 *
 * It must not retry, must not manage conversation state, and must not know that
 * agents or tools-as-functions exist. That keeps `run()` provider-agnostic and
 * makes a new vendor a single self-contained file.
 */
export interface ModelProvider {
  /** Vendor identifier, e.g. `'openrouter'`. Appears in traces. */
  readonly providerId: string
  /** The model this instance is bound to, e.g. `'anthropic/claude-opus-5'`. */
  readonly modelId: string

  generate(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResponse>

  /**
   * Incremental generation. Optional: the loop falls back to `generate` when a
   * provider does not implement it. Wired up in the streaming milestone.
   */
  stream?(request: ModelRequest, options?: ModelCallOptions): AsyncIterable<ModelStreamChunk>
}

/** A tool as the *model* sees it: a name, a description, and a JSON Schema. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: ObjectJsonSchema
}

export type ToolChoice =
  'auto' | 'required' | 'none' | { readonly type: 'tool'; readonly name: string }

export interface ModelRequest {
  /** Conversation so far, oldest first. Excludes the system message. */
  readonly messages: readonly ModelMessage[]
  /** Hoisted instructions. Providers place this in their own system field. */
  readonly system?: string
  readonly tools?: readonly ToolDefinition[]
  readonly toolChoice?: ToolChoice
  readonly maxOutputTokens?: number
  readonly temperature?: number
  readonly stopSequences?: readonly string[]
  /**
   * Ask the model to emit JSON matching a schema. Providers that cannot honour
   * this must ignore it rather than fail — the run layer validates regardless.
   */
  readonly responseFormat?: ResponseFormat
  /** Passed through to providers that support request tagging. */
  readonly metadata?: Readonly<Record<string, string>>
  /** Escape hatch for vendor-specific fields, merged into the request body. */
  readonly providerOptions?: Readonly<Record<string, unknown>>
}

export interface ResponseFormat {
  readonly type: 'json'
  readonly schema?: ObjectJsonSchema
  readonly name?: string
}

export interface ModelCallOptions {
  readonly signal?: AbortSignal
  /** Deadline for this single call, in milliseconds. */
  readonly timeoutMs?: number
  /** Extra headers merged over the provider's defaults. */
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * Why the model stopped.
 * - `stop`           — it finished its turn
 * - `tool_calls`     — it wants tools executed
 * - `length`         — hit the output token cap (response may be truncated)
 * - `content_filter` — the provider's safety layer intervened
 * - `other`          — anything a provider reports that we cannot map
 */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other'

export interface ModelResponse {
  readonly content: readonly (TextPart | ToolCallPart)[]
  readonly finishReason: FinishReason
  readonly usage: Usage
  /** The model that actually served the request (may differ from `modelId`). */
  readonly modelId: string
  /** Unmodified provider payload, for debugging. Never inspected by the loop. */
  readonly raw?: unknown
}

/** Incremental output. Consumed by the streaming layer, not by `generate`. */
export type ModelStreamChunk =
  | { readonly type: 'text-delta'; readonly text: string }
  | {
      readonly type: 'tool-call-delta'
      readonly toolCallId: string
      readonly toolName?: string
      readonly inputDelta: string
    }
  | { readonly type: 'finish'; readonly response: ModelResponse }

/**
 * Convenience: extract the tool calls from a response.
 * Providers set `finishReason: 'tool_calls'`, but we trust the content over the
 * flag — some vendors report `stop` while still emitting calls.
 */
export function toolCallsOf(response: ModelResponse): readonly ToolCallPart[] {
  return response.content.filter((part): part is ToolCallPart => part.type === 'tool-call')
}

/** Concatenated text of a response, ignoring tool calls. */
export function textOf(response: ModelResponse): string {
  return response.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('')
}
