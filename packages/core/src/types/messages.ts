/**
 * The SDK's own conversation format.
 *
 * Providers translate to and from their vendor wire format at the edge
 * (`src/providers/*`), so the agent loop, sessions, guardrails, and traces only
 * ever deal with these shapes. Adding a provider must never require changing
 * this file.
 */

/** Plain model-authored or user-authored prose. */
export interface TextPart {
  readonly type: 'text'
  readonly text: string
}

/** The model asking to invoke a tool. */
export interface ToolCallPart {
  readonly type: 'tool-call'
  /** Provider-assigned id used to correlate the matching result. */
  readonly toolCallId: string
  readonly toolName: string
  /** Arguments as the model produced them — not yet validated. */
  readonly input: unknown
}

/** Our answer to a `ToolCallPart`. */
export interface ToolResultPart {
  readonly type: 'tool-result'
  readonly toolCallId: string
  readonly toolName: string
  /** Whatever the handler returned, or an error envelope when `isError`. */
  readonly output: unknown
  /**
   * `true` when the tool failed. The result is still sent to the model so it
   * can recover, rather than being thrown away.
   */
  readonly isError?: boolean
}

export type ContentPart = TextPart | ToolCallPart | ToolResultPart

/** Instructions. Hoisted into the provider's system field, never a chat turn. */
export interface SystemMessage {
  readonly role: 'system'
  readonly content: string
}

export interface UserMessage {
  readonly role: 'user'
  readonly content: string | readonly TextPart[]
}

export interface AssistantMessage {
  readonly role: 'assistant'
  readonly content: readonly (TextPart | ToolCallPart)[]
}

/** One message carrying every tool result for the preceding assistant turn. */
export interface ToolMessage {
  readonly role: 'tool'
  readonly content: readonly ToolResultPart[]
}

export type ModelMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage

export type MessageRole = ModelMessage['role']

/** Token accounting for a single model call. */
export interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  /** Populated only by providers that report it. */
  readonly cachedInputTokens?: number
  readonly reasoningTokens?: number
}

export const ZERO_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
})

/** Adds two usage records. Optional fields survive if either side reported them. */
export function addUsage(a: Usage, b: Usage): Usage {
  const cached = (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0)
  const reasoning = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  }
}

/* ------------------------------------------------------------------------- */
/* Construction and narrowing helpers                                        */
/* ------------------------------------------------------------------------- */

export function textPart(text: string): TextPart {
  return { type: 'text', text }
}

export function userMessage(content: string | readonly TextPart[]): UserMessage {
  return { role: 'user', content }
}

export function assistantMessage(content: readonly (TextPart | ToolCallPart)[]): AssistantMessage {
  return { role: 'assistant', content }
}

export function toolMessage(content: readonly ToolResultPart[]): ToolMessage {
  return { role: 'tool', content }
}

export function isTextPart(part: ContentPart): part is TextPart {
  return part.type === 'text'
}

export function isToolCallPart(part: ContentPart): part is ToolCallPart {
  return part.type === 'tool-call'
}

export function isToolResultPart(part: ContentPart): part is ToolResultPart {
  return part.type === 'tool-result'
}

/** Concatenates every text part of a message, ignoring tool calls. */
export function messageText(message: ModelMessage): string {
  if (message.role === 'system') return message.content
  if (message.role === 'tool') return ''
  if (typeof message.content === 'string') return message.content

  // Widened to ContentPart[] first: `content` differs between UserMessage and
  // AssistantMessage, and filtering across that union loses the narrowing.
  const parts: readonly ContentPart[] = message.content
  return parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join('')
}
