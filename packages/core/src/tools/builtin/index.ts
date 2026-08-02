/**
 * `just-another-sdk/tools` — the tools that reach the outside world.
 *
 * The pure ones (`calculate`, `current_time`, `date_math`, `unit_convert`,
 * `think`) are **already on every agent** and need no import; see
 * `AgentConfig.builtins`. What is here is everything that touches the network,
 * because outbound egress should always be a choice someone made on purpose.
 *
 * Two tiers, split by **who chooses the host**:
 *
 * ```ts
 * import { webTools, httpFetch, webSearch } from 'just-another-sdk/tools'
 *
 * // Fixed endpoints, no key, no config — the model supplies a query, never a host.
 * tools: [...webTools()]
 *
 * // Arbitrary URLs — the model influences the host, so an allowlist is required.
 * tools: [httpFetch({ allow: ['api.example.com'] })]
 * ```
 *
 * The filesystem tools live at `just-another-sdk/tools/fs`, so a browser or edge
 * bundle importing this module never pulls in `node:fs`.
 */

/* ── No key, no config ───────────────────────────────────────────────────── */

export { webTools, getWeather, geocode, wikipedia, currencyConvert } from './web.js'
export type { WebToolOptions } from './web.js'

/* ── Arbitrary URLs, allowlist required ──────────────────────────────────── */

export { httpFetch, readUrl, extractText } from './http.js'
export type { UrlPolicy } from './http.js'
export { BlockedUrlError } from './http.js'

/* ── Search, with a client you supply ────────────────────────────────────── */

export { webSearch } from './search.js'
export type { SearchClient, SearchQuery, SearchResult, WebSearchOptions } from './search.js'

/* ── The automatic ones, exported so they can be composed deliberately ───── */

/**
 * Re-exported for the cases where you want them explicitly: alongside
 * `builtins: false`, or to pass one through a `toolGuardrail` filter by
 * reference rather than by name.
 */
export {
  PURE_BUILTINS,
  calculate,
  currentTime,
  dateMath,
  think,
  unitConvert,
  supportedUnits,
} from './pure.js'
