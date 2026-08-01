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
export { AGENT_DEFAULTS } from './agent/types.js'
export type { AgentConfig, AgentInput, RunOptions, ToolErrorPolicy } from './agent/types.js'

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

/* ── Events ──────────────────────────────────────────────────────────────── */

export { consoleTracer, type ConsoleTracerOptions } from './events/console-tracer.js'
export { EventEmitter } from './events/emitter.js'
export type {
  AgentEvent,
  AgentEventType,
  EventListener,
  EventOfType,
  ModelRequestEvent,
  ModelResponseEvent,
  RunErrorEvent,
  RunFinishEvent,
  RunStartEvent,
  TextDeltaEvent,
  ToolEndEvent,
  ToolStartEvent,
} from './events/events.js'

/* ── Errors ──────────────────────────────────────────────────────────────── */

export {
  AbortError,
  AgentError,
  AuthenticationError,
  ConfigurationError,
  InvalidSchemaError,
  InvalidToolInputError,
  NetworkError,
  ProviderError,
  RateLimitError,
  TimeoutError,
  ToolExecutionError,
  ToolNotFoundError,
  isAgentError,
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
