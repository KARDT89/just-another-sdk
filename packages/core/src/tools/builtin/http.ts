/**
 * Fetching arbitrary URLs a model chose.
 *
 * The dangerous tier. Everything protecting you lives in
 * [`url-policy.ts`](./url-policy.ts); this file is the transport plus the two
 * tools built on it.
 */

import { s } from '../../schema/mini.js'
import { tool, type AnyTool, type ToolContext } from '../tool.js'
import {
  assertAllowedUrl,
  resolvePolicy,
  type ResolvedPolicy,
  type UrlPolicy,
} from './url-policy.js'

export type { UrlPolicy } from './url-policy.js'
export { BlockedUrlError } from './url-policy.js'

/**
 * HTTP for agents, locked down.
 *
 * ```ts
 * tools: [httpFetch({ allow: ['api.example.com'], headers: { authorization: `Bearer ${key}` } })]
 * ```
 *
 * The allowlist is required — see {@link UrlPolicy}. Responses are capped,
 * redirects are bounded and re-checked, and the run's `AbortSignal` is
 * forwarded, so cancelling a run cancels an in-flight fetch.
 */
export function httpFetch(policy: UrlPolicy): AnyTool {
  const resolved = resolvePolicy(policy, 'httpFetch')

  return tool({
    name: 'http_fetch',
    description:
      `Make an HTTP request and return the response. Allowed hosts: ${describeAllow(resolved)}. ` +
      `Methods: ${resolved.methods.join(', ')}. Responses are truncated at ` +
      `${resolved.maxBytes.toLocaleString('en-US')} bytes.`,
    inputSchema: s.object({
      url: s.string({ describe: 'Absolute URL, http or https.' }),
      method: s.optional(
        s.string({ describe: `HTTP method. One of: ${resolved.methods.join(', ')}.` }),
      ),
      body: s.optional(s.string({ describe: 'Request body, for methods that take one.' })),
      headers: s.optional(s.string({ describe: 'Extra request headers as a JSON object string.' })),
    }),
    timeoutMs: resolved.timeoutMs,
    execute: async (input, context) => {
      const method = (input.method ?? 'GET').toUpperCase()

      if (!resolved.methods.includes(method)) {
        throw new Error(
          `The ${method} method is not allowed. Permitted: ${resolved.methods.join(', ')}.`,
        )
      }

      const extra = parseHeaders(input.headers)

      const response = await request(input.url, {
        policy: resolved,
        method,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(extra ? { headers: extra } : {}),
        context,
      })

      return {
        status: response.status,
        ok: response.ok,
        url: response.url,
        contentType: response.contentType,
        body: response.text,
        truncated: response.truncated,
      }
    },
  })
}

/**
 * Fetch a page and return readable text.
 *
 * The tool a research agent actually wants: raw HTML burns thousands of tokens
 * on markup the model then has to ignore. This strips it and hands back prose.
 *
 * ```ts
 * tools: [readUrl({ allow: ['*.wikipedia.org', 'docs.example.com'] })]
 * ```
 */
export function readUrl(policy: UrlPolicy): AnyTool {
  const resolved = resolvePolicy(policy, 'readUrl')

  return tool({
    name: 'read_url',
    description:
      `Fetch a web page and return its readable text with the markup removed. ` +
      `Use this to read an article or documentation page. Allowed hosts: ${describeAllow(resolved)}.`,
    inputSchema: s.object({
      url: s.string({ describe: 'Absolute URL of the page to read.' }),
      maxCharacters: s.integer({
        describe: 'Cap on returned characters. Lower it when you only need the beginning.',
        min: 200,
        max: 100_000,
        default: 20_000,
      }),
    }),
    timeoutMs: resolved.timeoutMs,
    execute: async (input, context) => {
      const response = await request(input.url, {
        policy: resolved,
        method: 'GET',
        headers: { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.8' },
        context,
      })

      if (!response.ok) {
        throw new Error(`${response.url} returned HTTP ${response.status}.`)
      }

      const extracted = response.contentType.includes('html')
        ? extractText(response.text)
        : { text: response.text.trim(), title: undefined }

      const clipped = extracted.text.slice(0, input.maxCharacters)

      return {
        url: response.url,
        ...(extracted.title !== undefined ? { title: extracted.title } : {}),
        text: clipped,
        characters: clipped.length,
        truncated: clipped.length < extracted.text.length || response.truncated,
      }
    },
  })
}

/* ------------------------------------------------------------------------- */
/* Transport                                                                 */
/* ------------------------------------------------------------------------- */

export interface FetchedResponse {
  readonly status: number
  readonly ok: boolean
  readonly url: string
  readonly contentType: string
  readonly text: string
  readonly truncated: boolean
}

interface RequestOptions {
  readonly policy: ResolvedPolicy
  readonly method: string
  readonly body?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly context?: ToolContext
}

/**
 * One policy-checked HTTP request, following redirects by hand.
 *
 * `redirect: 'manual'` is the load-bearing detail. Letting `fetch` follow
 * redirects itself would check the allowlist once, against the URL the model
 * supplied, and then happily follow a `302` to anywhere — which is how an
 * allowlist becomes decorative.
 */
export async function request(raw: string, options: RequestOptions): Promise<FetchedResponse> {
  const { policy, method, body, headers, context } = options

  let target = assertAllowedUrl(raw, policy)
  let hops = 0

  for (;;) {
    const response = await policy.fetch(target.toString(), {
      method,
      redirect: 'manual',
      headers: { ...policy.headers, ...headers },
      ...(body !== undefined && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
      ...(context ? { signal: context.signal } : {}),
    })

    const location =
      response.status >= 300 && response.status < 400 && response.headers.get('location')

    if (!location) {
      return {
        status: response.status,
        ok: response.ok,
        url: target.toString(),
        contentType: response.headers.get('content-type') ?? '',
        ...(await readCapped(response, policy.maxBytes)),
      }
    }

    hops += 1
    if (hops > policy.maxRedirects) {
      throw new Error(`Too many redirects (limit ${policy.maxRedirects}) starting from ${raw}.`)
    }

    // Re-checked against the full policy, every hop, no exceptions.
    target = assertAllowedUrl(new URL(location, target).toString(), policy)
  }
}

/**
 * Reads a body, stopping at the cap.
 *
 * Streamed rather than `await response.text()` because the point of a cap is to
 * refuse to *buffer* a 2 GB response, not to buffer it and then measure it.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  // `ReadableStream` is typed `any` in the DOM lib this package builds against,
  // so the chunk type is asserted once here rather than at three use sites.
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader()
  if (!reader) return { text: '', truncated: false }

  const decoder = new TextDecoder('utf-8')
  let text = ''
  let total = 0
  let truncated = false

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      total += value.byteLength
      if (total > maxBytes) {
        const keep = value.byteLength - (total - maxBytes)
        text += decoder.decode(value.subarray(0, Math.max(0, keep)))
        truncated = true
        break
      }

      text += decoder.decode(value, { stream: true })
    }
  } finally {
    // Releasing matters: an un-cancelled reader on a truncated response holds
    // the connection open until the socket times out.
    await reader.cancel().catch(() => {})
  }

  return { text: truncated ? text : text + decoder.decode(), truncated }
}

/* ------------------------------------------------------------------------- */
/* HTML → text                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Strips markup, keeping prose.
 *
 * Not a parser, and does not pretend to be — a real one is a dependency, and
 * this package has none. For the job at hand (give a model something readable
 * instead of 300 kB of `<div>`) a scrub is enough, and it degrades gracefully:
 * worst case the model sees slightly untidy text rather than nothing.
 */
export function extractText(html: string): { text: string; title: string | undefined } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1]

  const text = html
    // Whole subtrees whose *content* is not prose. Dropped before tag-stripping,
    // or a page's JavaScript would end up in the output as text.
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    // Block boundaries become newlines so paragraphs survive the strip.
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre)>/giu, '\n')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&lt;/giu, '<')
    .replace(/&gt;/giu, '>')
    .replace(/&quot;/giu, '"')
    .replace(/&#(\d+);/gu, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    // \u00A0 is a non-breaking space: extremely common in HTML and invisible in
    // source, so it is written as an escape rather than pasted in.
    .replace(/[ \t\u00A0]+/gu, ' ')
    .replace(/\n\s*\n\s*\n+/gu, '\n\n')
    .trim()

  return { text, title: title ? decodeTitle(title) : undefined }
}

function decodeTitle(raw: string): string {
  return raw.replace(/\s+/gu, ' ').replace(/&amp;/giu, '&').trim()
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

function describeAllow(policy: ResolvedPolicy): string {
  if (policy.allow.length === 0) return 'none configured — this tool cannot reach anything'
  return policy.allow.join(', ')
}

/**
 * Headers arrive as a JSON *string* because several providers handle a nested
 * free-form object poorly in a tool schema. A malformed one is the model's
 * mistake to fix, so it is an error rather than a silent drop.
 */
function parseHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.trim() === '') return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`\`headers\` must be a JSON object string, received: ${raw}`)
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('`headers` must be a JSON object, e.g. {"accept":"application/json"}.')
  }

  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`Header "${key}" must be a string.`)
    }
    headers[key] = value
  }
  return headers
}
