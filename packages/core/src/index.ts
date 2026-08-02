/**
 * just-another-sdk — a TypeScript agent SDK with zero runtime dependencies.
 *
 * ```ts
 * import { Agent, tool } from 'just-another-sdk'
 * import { openrouter } from 'just-another-sdk/providers'
 * import * as z from 'zod'
 *
 * const agent = new Agent({
 *   name: 'assistant',
 *   instructions: 'Be concise.',
 *   model: openrouter('anthropic/claude-opus-5'),
 *   tools: [
 *     tool({
 *       name: 'get_weather',
 *       description: 'Get current weather for a city.',
 *       inputSchema: z.object({ city: z.string() }),
 *       execute: async ({ city }) => ({ tempC: 18, summary: 'clear', city }),
 *     }),
 *   ],
 * })
 *
 * const result = await agent.run('What is the weather in Paris?')
 * console.log(result.output)
 * ```
 *
 * This file *is* the public API. Anything not exported here is internal and may
 * change in a patch release.
 */

/* ── Agents ──────────────────────────────────────────────────────────────── */

export { Agent, run } from './agent/agent.js'
export type { AgentSession } from './agent/agent.js'
export { AGENT_DEFAULTS } from './agent/types.js'
export type { AgentConfig, AgentInput, RunOptions, ToolErrorPolicy } from './agent/types.js'

/* ── Sessions ────────────────────────────────────────────────────────────── */

/**
 * The contract and the default store live at the root so that persisting a
 * conversation, or writing an adapter for your own database, needs no extra
 * import. The backed adapters are in `just-another-sdk/sessions`.
 */
export { memorySession } from './sessions/memory.js'
export type { MemorySessionOptions } from './sessions/memory.js'
export type { LoadOptions, SessionStore } from './sessions/store.js'
export { estimateTokens, trimHistory } from './sessions/trim.js'
export type { ContextPolicy } from './sessions/trim.js'
export { isSummaryMessage } from './sessions/summarize.js'
export type { SummarizeOptions } from './sessions/summarize.js'

/* ── Guardrails ──────────────────────────────────────────────────────────── */

/**
 * Policy around a run: reject or rewrite the input, gate a tool call, check the
 * final answer, or pause for a human. Types only — a guardrail is a plain object
 * you write, so there is nothing to construct.
 */
export type {
  AnyToolGuardrail,
  ApprovalDecision,
  ApprovalSuspension,
  GuardrailAllow,
  GuardrailContext,
  GuardrailReject,
  GuardrailRequireApproval,
  GuardrailRewrite,
  GuardrailVerdict,
  InputGuardrail,
  OutputGuardrail,
  OutputGuardrailContext,
  PendingApproval,
  PendingToolCall,
  ToolGuardrail,
  ToolGuardrailSubject,
  ToolGuardrailVerdict,
} from './guardrails/types.js'

/* ── Tools ───────────────────────────────────────────────────────────────── */

export { tool } from './tools/tool.js'
export type {
  AnyTool,
  NullaryToolSpec,
  Tool,
  ToolContext,
  ToolHandler,
  ToolSpec,
} from './tools/tool.js'
export { ToolRegistry } from './tools/registry.js'

/* ── Run results ─────────────────────────────────────────────────────────── */

export { isComplete } from './run/result.js'
export type { RunResult, RunStep, StopReason } from './run/result.js'
export { runAgent } from './run/runner.js'

/* ── Streaming ───────────────────────────────────────────────────────────── */

export { streamAgent } from './run/stream.js'
export type { StreamedRun } from './run/stream.js'

/* ── Streaming over HTTP ─────────────────────────────────────────────────── */

/**
 * The two halves of streaming a run to a browser. Both are runtime-neutral —
 * `readEventStream` is the client side and runs anywhere `fetch` does.
 */
export { readEventStream } from './http/read-stream.js'
export type { ReadEventStreamOptions } from './http/read-stream.js'
export type { EventStreamOptions } from './http/to-stream.js'

/* ── Resumable streams ───────────────────────────────────────────────────── */

/**
 * The contract and the default store live at the root; the Redis adapter is in
 * `just-another-sdk/streams`.
 */
export { memoryStreamStore } from './streams/memory.js'
export type { MemoryStreamStoreOptions } from './streams/memory.js'
export type { FollowOptions, ResumableOptions, ResumableRun } from './streams/resumable.js'
export type { StreamOutcome, StreamStatus, StreamStore } from './streams/store.js'

/* ── Reliability ─────────────────────────────────────────────────────────── */

export type { RetryPolicy } from './run/retry.js'

/* ── Events ──────────────────────────────────────────────────────────────── */

export { consoleTracer, type ConsoleTracerOptions } from './events/console-tracer.js'
export { EventEmitter } from './events/emitter.js'
export type {
  AgentEvent,
  AgentEventType,
  ApprovalRequiredEvent,
  ApprovalResolvedEvent,
  EventListener,
  EventOfType,
  GuardrailTriggeredEvent,
  ModelFallbackEvent,
  ModelRequestEvent,
  ModelResponseEvent,
  ModelRetryEvent,
  OutputInvalidEvent,
  RunErrorEvent,
  RunFinishEvent,
  RunStartEvent,
  SessionLoadEvent,
  SessionSaveEvent,
  SessionSummarizeEvent,
  TextDeltaEvent,
  ToolEndEvent,
  ToolStartEvent,
} from './events/events.js'

/* ── Errors ──────────────────────────────────────────────────────────────── */

export {
  AbortError,
  AgentError,
  ApprovalRequiredError,
  AuthenticationError,
  ConfigurationError,
  GuardrailError,
  InvalidOutputError,
  InvalidSchemaError,
  InvalidToolInputError,
  NetworkError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  ToolExecutionError,
  ToolNotFoundError,
  isAgentError,
  toAgentError,
} from './errors/errors.js'
export type { AgentErrorCode, AgentErrorOptions, SchemaIssue } from './errors/errors.js'

/* ── Messages & conversation ─────────────────────────────────────────────── */

export {
  addUsage,
  assistantMessage,
  isTextPart,
  isToolCallPart,
  isToolResultPart,
  messageText,
  textPart,
  toolMessage,
  userMessage,
  ZERO_USAGE,
} from './types/messages.js'
export type {
  AssistantMessage,
  ContentPart,
  MessageRole,
  ModelMessage,
  SystemMessage,
  TextPart,
  ToolCallPart,
  ToolMessage,
  ToolResultPart,
  Usage,
  UserMessage,
} from './types/messages.js'

/* ── Schema interop ──────────────────────────────────────────────────────── */

export {
  isStandardSchema,
  registerJsonSchemaConverter,
  resolveJsonSchema,
  validate,
} from './schema/standard-schema.js'
export type {
  InferSchemaOutput,
  SchemaSubject,
  StandardSchemaV1,
  ValidationResult,
} from './schema/standard-schema.js'
export type { JsonSchema, ObjectJsonSchema } from './types/json-schema.js'

/* ── Provider contract ───────────────────────────────────────────────────── */

/**
 * Re-exported here as well as from `just-another-sdk/providers` so that writing a
 * custom provider only needs the root import.
 */
export type {
  FinishReason,
  ModelCallOptions,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
  ResponseFormat,
  ToolChoice,
  ToolDefinition,
} from './providers/provider.js'
export { textOf, toolCallsOf } from './providers/provider.js'

/* ── Utilities ───────────────────────────────────────────────────────────── */

export { createId } from './util/id.js'
export { redact, redactHeaders, redactString } from './util/redact.js'
