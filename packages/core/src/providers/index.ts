/**
 * Model providers — `just-another-sdk/providers`.
 *
 * Every provider here is a thin `fetch` wrapper implementing the
 * {@link ModelProvider} contract. Adding a vendor means adding one file; it never
 * requires a change to the agent runtime.
 */

export { openrouter, type OpenRouterOptions } from './openrouter.js'
export { openai, compatible, type OpenAIOptions, type CompatibleOptions } from './openai.js'
export { createOpenAICompatibleProvider, type OpenAICompatibleConfig } from './openai-compatible.js'

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
} from './provider.js'
export { textOf, toolCallsOf } from './provider.js'
