/**
 * Web search, without a search vendor becoming a dependency.
 *
 * Same shape as [`redisSession(client)`](../../sessions/redis.ts): you pass the
 * client, the SDK declares the interface it needs structurally, and no package
 * is added to anyone's tree — not even an optional peer. Brave, Tavily, Exa,
 * SerpAPI, or your own index all satisfy it in a few lines.
 *
 * For search that needs **no** setup at all, `wikipedia()` in
 * [`web.ts`](./web.ts) is keyless and covers a surprising amount of what agents
 * actually look things up for.
 */

import { ConfigurationError } from '../../errors/errors.js'
import { s } from '../../schema/mini.js'
import { tool, type AnyTool } from '../tool.js'

/** One result. Only `title` and `url` are required; the rest improve the answer. */
export interface SearchResult {
  readonly title: string
  readonly url: string
  /** A snippet or summary. Worth providing — it often saves a `read_url` call. */
  readonly snippet?: string
  readonly publishedAt?: string
  readonly score?: number
}

export interface SearchQuery {
  readonly query: string
  readonly limit: number
  /** Forwarded from the run, so cancelling a run cancels the search. */
  readonly signal?: AbortSignal
}

/**
 * Whatever you already use to search, structurally.
 *
 * ```ts
 * const brave: SearchClient = {
 *   async search({ query, limit, signal }) {
 *     const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`
 *     const response = await fetch(url, {
 *       headers: { 'x-subscription-token': process.env.BRAVE_API_KEY! },
 *       signal,
 *     })
 *     const data = await response.json()
 *     return data.web.results.map((r) => ({ title: r.title, url: r.url, snippet: r.description }))
 *   },
 * }
 *
 * new Agent({ name: 'research', model, tools: [webSearch(brave)] })
 * ```
 */
export interface SearchClient {
  search(query: SearchQuery): Promise<readonly SearchResult[]>
}

export interface WebSearchOptions {
  /** Overrides the tool name, if `web_search` collides with something. */
  readonly name?: string
  /** Default number of results per query. Default 5. */
  readonly defaultLimit?: number
  /** Hard ceiling the model cannot exceed. Default 10. */
  readonly maxLimit?: number
  /** Per-search deadline in ms. Default 15,000. */
  readonly timeoutMs?: number
}

/**
 * Search the web with a client you supply.
 *
 * The SDK owns the schema, the validation, the result shape, and the error
 * handling; your client owns the one function that knows about your vendor.
 */
export function webSearch(client: SearchClient, options: WebSearchOptions = {}): AnyTool {
  if (!client || typeof client.search !== 'function') {
    throw new ConfigurationError('webSearch needs a client with a `search` method.', {
      hint:
        'Pass an object shaped like `{ search({ query, limit, signal }) { … } }` that returns ' +
        '`{ title, url, snippet? }[]`. Any vendor works — the SDK depends on none of them.',
    })
  }

  const defaultLimit = options.defaultLimit ?? 5
  const maxLimit = options.maxLimit ?? 10

  return tool({
    name: options.name ?? 'web_search',
    description:
      'Search the web and return matching pages with titles, URLs, and snippets. Use it ' +
      'for anything current, or anything you are not confident about. Follow up with ' +
      'read_url when a snippet is not enough.',
    inputSchema: s.object({
      query: s.string({
        describe: 'The search query. Keywords work better than a full sentence.',
        maxLength: 500,
      }),
      limit: s.integer({
        describe: 'How many results to return.',
        min: 1,
        max: maxLimit,
        default: defaultLimit,
      }),
    }),
    timeoutMs: options.timeoutMs ?? 15_000,
    execute: async ({ query, limit }, context) => {
      const results = await client.search({
        query,
        // Clamped as well as schema-bounded: the ceiling is a promise to the
        // vendor's rate limit, and a custom `parameters` override could bypass
        // the schema while this cannot be bypassed at all.
        limit: Math.min(limit, maxLimit),
        signal: context.signal,
      })

      if (!Array.isArray(results)) {
        throw new Error('The search client returned something that was not an array of results.')
      }

      return {
        query,
        count: results.length,
        results: results.slice(0, maxLimit).map((result) => ({
          title: result.title,
          url: result.url,
          ...(result.snippet !== undefined ? { snippet: result.snippet } : {}),
          ...(result.publishedAt !== undefined ? { publishedAt: result.publishedAt } : {}),
        })),
      }
    },
  })
}
