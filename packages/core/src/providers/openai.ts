import { ConfigurationError } from '../errors/errors.js'
import { readEnv } from '../util/env.js'
import type { ModelProvider } from './provider.js'
import { createOpenAICompatibleProvider } from './openai-compatible.js'

export interface OpenAIOptions {
  /** Defaults to `process.env.OPENAI_API_KEY`. */
  readonly apiKey?: string
  /** Defaults to `https://api.openai.com/v1`. */
  readonly baseUrl?: string
  /** Sent as `OpenAI-Organization`. */
  readonly organization?: string
  /** Sent as `OpenAI-Project`. */
  readonly project?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: typeof globalThis.fetch
}

/**
 * An OpenAI model, via the Chat Completions API.
 *
 * ```ts
 * const agent = new Agent({ name: 'assistant', model: openai('gpt-5') })
 * ```
 */
export function openai(modelId: string, options: OpenAIOptions = {}): ModelProvider {
  const apiKey = options.apiKey ?? readEnv('OPENAI_API_KEY')

  if (!apiKey) {
    throw new ConfigurationError('No OpenAI API key found.', {
      hint:
        'Set the OPENAI_API_KEY environment variable, or pass ' + "openai('model-id', { apiKey }).",
    })
  }

  const headers: Record<string, string> = { ...options.headers }
  if (options.organization) headers['openai-organization'] = options.organization
  if (options.project) headers['openai-project'] = options.project

  return createOpenAICompatibleProvider({
    providerId: 'openai',
    modelId,
    baseUrl: (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    apiKey,
    headers,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })
}

export interface CompatibleOptions extends OpenAIOptions {
  /** Identifier for traces, e.g. `'groq'` or `'ollama'`. */
  readonly providerId?: string
  /** Required — there is no sensible default for an arbitrary endpoint. */
  readonly baseUrl: string
  /** Some local servers need no key; a placeholder is sent to satisfy the header. */
  readonly apiKey?: string
  /**
   * Merged into every request body, overriding what the SDK would otherwise
   * send. The escape hatch for endpoints that diverge from the OpenAI schema.
   *
   * Older vLLM builds and some Ollama versions reject `stream_options` with a
   * 400; `{ stream_options: null }` removes it while leaving streaming on.
   */
  readonly defaultBody?: Readonly<Record<string, unknown>>
}

/**
 * Any other OpenAI-compatible endpoint: Groq, Together, Fireworks, DeepSeek, xAI,
 * Ollama, vLLM, LM Studio, or your own gateway.
 *
 * ```ts
 * const local = compatible('llama3.1', { baseUrl: 'http://localhost:11434/v1' })
 * const groq  = compatible('llama-3.3-70b', {
 *   baseUrl: 'https://api.groq.com/openai/v1',
 *   apiKey: process.env.GROQ_API_KEY,
 *   providerId: 'groq',
 * })
 * ```
 */
export function compatible(modelId: string, options: CompatibleOptions): ModelProvider {
  return createOpenAICompatibleProvider({
    providerId: options.providerId ?? 'openai-compatible',
    modelId,
    baseUrl: options.baseUrl.replace(/\/$/, ''),
    // Local servers such as Ollama ignore the header but still require one.
    apiKey: options.apiKey ?? 'not-required',
    headers: options.headers ?? {},
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.defaultBody ? { defaultBody: options.defaultBody } : {}),
  })
}
