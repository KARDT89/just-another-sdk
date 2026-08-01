import { ConfigurationError } from '../errors/errors.js'
import { readEnv } from '../util/env.js'
import type { ModelProvider } from './provider.js'
import { createOpenAICompatibleProvider } from './openai-compatible.js'

export interface OpenRouterOptions {
  /** Defaults to `process.env.OPENROUTER_API_KEY`. */
  readonly apiKey?: string
  /** Defaults to `https://openrouter.ai/api/v1`. */
  readonly baseUrl?: string
  /**
   * Your site URL. OpenRouter uses it for attribution on their model-usage
   * leaderboards, and it is what gets you listed as an app using a model.
   */
  readonly referer?: string
  /** Your app name, shown alongside the referer in OpenRouter's rankings. */
  readonly title?: string
  /** Restrict which upstream providers OpenRouter may route to. */
  readonly only?: readonly string[]
  /** Extra headers merged into every request. */
  readonly headers?: Readonly<Record<string, string>>
  /** Injected for tests. */
  readonly fetch?: typeof globalThis.fetch
}

/**
 * An [OpenRouter](https://openrouter.ai) model.
 *
 * One key reaches hundreds of models across every major vendor, which makes it
 * the fastest way to get an agent running and the easiest way to A/B a model
 * change — swap the string, keep the code:
 *
 * ```ts
 * const agent = new Agent({
 *   name: 'assistant',
 *   model: openrouter('anthropic/claude-opus-5'),
 * })
 * ```
 *
 * Model ids are `vendor/model`, exactly as listed at openrouter.ai/models.
 */
export function openrouter(modelId: string, options: OpenRouterOptions = {}): ModelProvider {
  const apiKey = options.apiKey ?? readEnv('OPENROUTER_API_KEY')

  if (!apiKey) {
    throw new ConfigurationError('No OpenRouter API key found.', {
      hint:
        'Set the OPENROUTER_API_KEY environment variable, or pass ' +
        "openrouter('model-id', { apiKey }). Create a key at https://openrouter.ai/keys",
    })
  }

  const headers: Record<string, string> = { ...options.headers }
  if (options.referer) headers['http-referer'] = options.referer
  if (options.title) headers['x-title'] = options.title

  return createOpenAICompatibleProvider({
    providerId: 'openrouter',
    modelId,
    baseUrl: (options.baseUrl ?? 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    apiKey,
    headers,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.only?.length ? { defaultBody: { provider: { only: [...options.only] } } } : {}),
  })
}
