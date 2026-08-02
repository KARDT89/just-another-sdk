/**
 * Real data, no API key, no configuration.
 *
 * The interesting tier. Each of these hits **one fixed endpoint the model cannot
 * change** — it supplies a query, never a host — so there is no allowlist to
 * configure and no SSRF surface to defend. That is what separates them from
 * `httpFetch`, and it is why they can be one line with no arguments:
 *
 * ```ts
 * new Agent({ name: 'research', model, tools: [...webTools()] })
 * ```
 *
 * All four sources are free and keyless: Open-Meteo for weather and geocoding,
 * Wikipedia's REST API, and the European Central Bank's rates via Frankfurter.
 *
 * > **The trade.** This pins the SDK to third-party public APIs, which can
 * > change shape or rate-limit. Each tool therefore takes a `baseUrl` and a
 * > `fetch` override, so it is swappable and testable, and every one is tested
 * > offline against a stub. They are opt-in rather than automatic because
 * > outbound network egress should always be a choice someone made on purpose.
 */

import { s } from '../../schema/mini.js'
import { tool, type AnyTool, type ToolContext } from '../tool.js'

/** Shared by every tool here. Both fields exist for testing and for mirrors. */
export interface WebToolOptions {
  /** Override the upstream base URL — for a mirror, a proxy, or a test stub. */
  readonly baseUrl?: string
  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  /** Per-request deadline in ms. Default 10,000. */
  readonly timeoutMs?: number
  /**
   * Identifies your application to the upstream APIs.
   *
   * **Not cosmetic.** Wikipedia's API policy requires a descriptive
   * `User-Agent` and rate-limits anonymous callers hard — a bare Node `fetch`
   * gets `HTTP 429` within a handful of requests. The default below identifies
   * the SDK, which is enough to work; put your own app and a contact URL here
   * if you are going to make real volume.
   */
  readonly userAgent?: string
}

const DEFAULT_TIMEOUT_MS = 10_000

const DEFAULT_USER_AGENT = 'just-another-sdk (+https://github.com/KARDT89/just-another-sdk)'

const ENDPOINTS = Object.freeze({
  geocoding: 'https://geocoding-api.open-meteo.com/v1',
  forecast: 'https://api.open-meteo.com/v1',
  wikipedia: 'https://en.wikipedia.org',
  rates: 'https://api.frankfurter.dev/v1',
})

/**
 * All four keyless tools.
 *
 * ```ts
 * tools: [...webTools()]
 * ```
 */
export function webTools(options: WebToolOptions = {}): readonly AnyTool[] {
  return [getWeather(options), geocode(options), wikipedia(options), currencyConvert(options)]
}

/* ------------------------------------------------------------------------- */
/* Weather                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Current conditions and a forecast, for a place name.
 *
 * Two upstream calls when given a name — geocode, then forecast — because a
 * model that has to call `geocode` first and thread coordinates through wastes a
 * turn and often gets the latitude sign wrong.
 */
export function getWeather(options: WebToolOptions = {}): AnyTool {
  const call = caller(options)

  return tool({
    name: 'get_weather',
    description:
      'Get the current weather and a short forecast for a place. Accepts a place name ' +
      'directly — you do not need coordinates. Returns temperature, wind, precipitation, ' +
      'and conditions. Needs no API key.',
    inputSchema: s.object({
      location: s.string({ describe: 'Place name, e.g. "Paris" or "Austin, Texas".' }),
      units: s.enum(['metric', 'imperial'], {
        describe: 'metric gives °C and km/h; imperial gives °F and mph.',
        default: 'metric',
      }),
      forecastDays: s.integer({
        describe: 'Days of daily forecast to include, 0 for current conditions only.',
        min: 0,
        max: 7,
        default: 3,
      }),
    }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    execute: async (input, context) => {
      const place = await resolvePlace(call, options, input.location, context)

      const imperial = input.units === 'imperial'
      const query = new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        current:
          'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
        timezone: 'auto',
        ...(imperial
          ? { temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', precipitation_unit: 'inch' }
          : {}),
        ...(input.forecastDays > 0
          ? {
              daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum',
              forecast_days: String(input.forecastDays),
            }
          : {}),
      })

      const base = options.baseUrl ?? ENDPOINTS.forecast
      const data = await call<ForecastResponse>(
        `${base}/forecast?${query.toString()}`,
        context,
        'weather',
      )

      return {
        location: place.label,
        coordinates: { latitude: place.latitude, longitude: place.longitude },
        units: imperial ? { temperature: '°F', wind: 'mph' } : { temperature: '°C', wind: 'km/h' },
        current: data.current
          ? {
              temperature: data.current.temperature_2m,
              feelsLike: data.current.apparent_temperature,
              humidity: data.current.relative_humidity_2m,
              precipitation: data.current.precipitation,
              windSpeed: data.current.wind_speed_10m,
              conditions: describeWeatherCode(data.current.weather_code),
              observedAt: data.current.time,
            }
          : undefined,
        forecast: data.daily
          ? data.daily.time.map((date, index) => ({
              date,
              high: data.daily?.temperature_2m_max?.[index],
              low: data.daily?.temperature_2m_min?.[index],
              precipitation: data.daily?.precipitation_sum?.[index],
              conditions: describeWeatherCode(data.daily?.weather_code?.[index]),
            }))
          : undefined,
      }
    },
  })
}

/** Place name → coordinates, country, and timezone. */
export function geocode(options: WebToolOptions = {}): AnyTool {
  const call = caller(options)

  return tool({
    name: 'geocode',
    description:
      'Look up the coordinates, country, population, and timezone of a place by name. ' +
      'Use it to disambiguate a place before other work, or to answer "where is X". ' +
      'Needs no API key.',
    inputSchema: s.object({
      name: s.string({ describe: 'Place name to look up.' }),
      limit: s.integer({
        describe: 'How many candidate matches to return.',
        min: 1,
        max: 10,
        default: 3,
      }),
    }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    execute: async (input, context) => {
      const results = await searchPlaces(call, options, input.name, input.limit, context)

      if (results.length === 0) {
        throw new Error(`No place found matching "${input.name}".`)
      }

      return {
        query: input.name,
        matches: results.map((place) => ({
          name: place.name,
          country: place.country,
          admin1: place.admin1,
          latitude: place.latitude,
          longitude: place.longitude,
          timezone: place.timezone,
          population: place.population,
        })),
      }
    },
  })
}

/* ------------------------------------------------------------------------- */
/* Wikipedia                                                                 */
/* ------------------------------------------------------------------------- */

/**
 * Search Wikipedia and read article summaries.
 *
 * The cheapest grounding there is: one call replaces a paragraph of half-recalled
 * training data with something that has a URL you can check.
 */
export function wikipedia(options: WebToolOptions = {}): AnyTool {
  const call = caller(options)
  const base = options.baseUrl ?? ENDPOINTS.wikipedia

  return tool({
    name: 'wikipedia',
    description:
      'Search Wikipedia, or read the summary of a specific article. Use it to check a ' +
      'fact, a date, or a definition rather than relying on memory. Needs no API key.',
    inputSchema: s.object({
      query: s.string({ describe: 'What to search for, or an exact article title.' }),
      action: s.enum(['search', 'summary'], {
        describe:
          'search returns matching titles with snippets; summary returns the opening of ' +
          'one article. Search first when unsure of the exact title.',
        default: 'search',
      }),
      limit: s.integer({
        describe: 'Number of search results.',
        min: 1,
        max: 10,
        default: 5,
      }),
    }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    execute: async (input, context) => {
      if (input.action === 'summary') {
        const title = encodeURIComponent(input.query.replace(/\s+/gu, '_'))
        const page = await call<WikipediaSummary>(
          `${base}/api/rest_v1/page/summary/${title}`,
          context,
          'Wikipedia',
        )

        return {
          title: page.title,
          description: page.description,
          extract: page.extract,
          url: page.content_urls?.desktop?.page,
        }
      }

      const query = new URLSearchParams({
        action: 'query',
        list: 'search',
        srsearch: input.query,
        srlimit: String(input.limit),
        format: 'json',
        origin: '*',
      })

      const data = await call<WikipediaSearch>(
        `${base}/w/api.php?${query.toString()}`,
        context,
        'Wikipedia',
      )

      return {
        query: input.query,
        results: (data.query?.search ?? []).map((hit) => ({
          title: hit.title,
          // The API returns HTML snippets with <span class="searchmatch"> in them.
          snippet: hit.snippet.replace(/<[^>]+>/gu, ''),
          url: `${base}/wiki/${encodeURIComponent(hit.title.replace(/\s+/gu, '_'))}`,
        })),
      }
    },
  })
}

/* ------------------------------------------------------------------------- */
/* Currency                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Live currency conversion, on European Central Bank reference rates.
 *
 * Deliberately *not* part of `unit_convert`: exchange rates change by the hour,
 * so they cannot live in a static ratio table, and a stale rate that looks
 * authoritative is worse than no answer.
 */
export function currencyConvert(options: WebToolOptions = {}): AnyTool {
  const call = caller(options)
  const base = options.baseUrl ?? ENDPOINTS.rates

  return tool({
    name: 'currency_convert',
    description:
      'Convert an amount between currencies at current or historical rates, using ' +
      'European Central Bank reference data. Use ISO codes such as USD, EUR, GBP, JPY. ' +
      'Needs no API key.',
    inputSchema: s.object({
      amount: s.number({ describe: 'The amount to convert.' }),
      from: s.string({ describe: 'ISO 4217 code to convert from, e.g. "USD".' }),
      to: s.string({ describe: 'ISO 4217 code to convert to, e.g. "EUR".' }),
      date: s.optional(s.string({ describe: 'Rate date, YYYY-MM-DD. Omit for the latest rate.' })),
    }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    execute: async (input, context) => {
      const from = input.from.trim().toUpperCase()
      const to = input.to.trim().toUpperCase()

      if (!/^[A-Z]{3}$/u.test(from) || !/^[A-Z]{3}$/u.test(to)) {
        throw new Error(
          `Currencies must be three-letter ISO codes; received "${input.from}" and "${input.to}".`,
        )
      }

      if (from === to) {
        return { amount: input.amount, from, to, rate: 1, result: input.amount, date: 'n/a' }
      }

      const when = input.date ?? 'latest'
      const query = new URLSearchParams({ base: from, symbols: to })
      const data = await call<RatesResponse>(
        `${base}/${when}?${query.toString()}`,
        context,
        'exchange rates',
      )

      const rate = data.rates?.[to]
      if (typeof rate !== 'number') {
        throw new Error(
          `No rate available from ${from} to ${to}${input.date ? ` on ${input.date}` : ''}.`,
        )
      }

      return {
        amount: input.amount,
        from,
        to,
        rate,
        result: Math.round(input.amount * rate * 1e6) / 1e6,
        date: data.date,
      }
    },
  })
}

/* ------------------------------------------------------------------------- */
/* Shared plumbing                                                           */
/* ------------------------------------------------------------------------- */

type Call = <T>(url: string, context: ToolContext | undefined, source: string) => Promise<T>

/**
 * One JSON call, with the upstream's failures turned into messages a model can
 * act on.
 *
 * A 404 from Wikipedia should read as "no such article", not as an unhandled
 * exception with a status code in it — the difference decides whether the model
 * retries sensibly or gives up.
 */
function caller(options: WebToolOptions): Call {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT

  return async <T>(url: string, context: ToolContext | undefined, source: string): Promise<T> => {
    let response: Response
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/json', 'user-agent': userAgent },
        ...(context ? { signal: context.signal } : {}),
      })
    } catch (cause) {
      throw new Error(
        `Could not reach ${source}: ${cause instanceof Error ? cause.message : String(cause)}.`,
        { cause },
      )
    }

    if (!response.ok) {
      if (response.status === 404) throw new Error(`${source} has nothing matching that query.`)

      // 429 gets its own message because the fix is configuration, not a retry:
      // these are shared public endpoints, and the caller needs to know they can
      // identify themselves rather than assume the tool is broken.
      if (response.status === 429) {
        throw new Error(
          `${source} is rate-limiting this client. Set \`userAgent\` on the tool options to ` +
            'identify your application, or slow down.',
        )
      }

      throw new Error(`${source} returned HTTP ${response.status}.`)
    }

    try {
      return (await response.json()) as T
    } catch {
      throw new Error(`${source} returned a response that was not valid JSON.`)
    }
  }
}

interface Place {
  readonly name: string
  readonly latitude: number
  readonly longitude: number
  readonly country?: string
  readonly admin1?: string
  readonly timezone?: string
  readonly population?: number
}

async function searchPlaces(
  call: Call,
  options: WebToolOptions,
  name: string,
  limit: number,
  context: ToolContext | undefined,
): Promise<readonly Place[]> {
  const base = options.baseUrl ?? ENDPOINTS.geocoding
  const query = new URLSearchParams({ name, count: String(limit), format: 'json' })
  const data = await call<{ results?: Place[] }>(
    `${base}/search?${query.toString()}`,
    context,
    'geocoding',
  )
  return data.results ?? []
}

async function resolvePlace(
  call: Call,
  options: WebToolOptions,
  location: string,
  context: ToolContext | undefined,
): Promise<Place & { label: string }> {
  const [first] = await searchPlaces(call, options, location, 1, context)

  if (!first) {
    throw new Error(
      `No place found matching "${location}". Try a larger nearby city, or add the country.`,
    )
  }

  return {
    ...first,
    label: [first.name, first.admin1, first.country].filter(Boolean).join(', '),
  }
}

/**
 * WMO weather codes → prose.
 *
 * The forecast API returns an integer; handing a model `61` and hoping it knows
 * that means "slight rain" is the kind of shortcut that produces a confidently
 * wrong summary.
 */
const WEATHER_CODES: Readonly<Record<number, string>> = Object.freeze({
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'depositing rime fog',
  51: 'light drizzle',
  53: 'moderate drizzle',
  55: 'dense drizzle',
  56: 'light freezing drizzle',
  57: 'dense freezing drizzle',
  61: 'slight rain',
  63: 'moderate rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'heavy freezing rain',
  71: 'slight snowfall',
  73: 'moderate snowfall',
  75: 'heavy snowfall',
  77: 'snow grains',
  80: 'slight rain showers',
  81: 'moderate rain showers',
  82: 'violent rain showers',
  85: 'slight snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with slight hail',
  99: 'thunderstorm with heavy hail',
})

function describeWeatherCode(code: number | undefined): string | undefined {
  if (code === undefined) return undefined
  return WEATHER_CODES[code] ?? `weather code ${code}`
}

/* ------------------------------------------------------------------------- */
/* Upstream response shapes                                                  */
/* ------------------------------------------------------------------------- */

interface ForecastResponse {
  readonly current?: {
    readonly time: string
    readonly temperature_2m: number
    readonly apparent_temperature: number
    readonly relative_humidity_2m: number
    readonly precipitation: number
    readonly weather_code: number
    readonly wind_speed_10m: number
  }
  readonly daily?: {
    readonly time: readonly string[]
    readonly weather_code?: readonly number[]
    readonly temperature_2m_max?: readonly number[]
    readonly temperature_2m_min?: readonly number[]
    readonly precipitation_sum?: readonly number[]
  }
}

interface WikipediaSummary {
  readonly title: string
  readonly description?: string
  readonly extract?: string
  readonly content_urls?: { readonly desktop?: { readonly page?: string } }
}

interface WikipediaSearch {
  readonly query?: { readonly search?: readonly { title: string; snippet: string }[] }
}

interface RatesResponse {
  readonly date: string
  readonly rates?: Readonly<Record<string, number>>
}
