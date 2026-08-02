import { describe, expect, it, vi } from 'vitest'

import { Agent, tool } from '../src/index.js'
import { s } from '../src/schema/mini.js'
import { validate } from '../src/schema/standard-schema.js'
import {
  PURE_BUILTINS,
  calculate,
  currencyConvert,
  currentTime,
  dateMath,
  geocode,
  getWeather,
  httpFetch,
  readUrl,
  think,
  unitConvert,
  webSearch,
  webTools,
  wikipedia,
} from '../src/tools/builtin/index.js'
import type { AnyTool, ToolContext } from '../src/tools/tool.js'
import { mockProvider } from '../src/testing/index.js'

/**
 * The built-in tool pack.
 *
 * Two things this file has to prove, and the second matters more:
 *
 *   1. The tools do what they say.
 *   2. **The pure ones are right**, because they are on by default. A wrong
 *      answer from a tool the developer never opted into is worse than not
 *      shipping the tool — so `unit_convert` round-trips, `date_math` handles
 *      month ends, and `calculate` respects precedence.
 *
 * Nothing here touches the network. The keyless web tools are driven through a
 * stubbed `fetch`, which is what their `fetch` option exists for.
 */

const context: ToolContext = {
  runId: 'run_test',
  toolCallId: 'call_1',
  agentName: 'test',
  turn: 1,
  signal: new AbortController().signal,
}

/** Runs a tool the way the runtime would: validate, then invoke. */
async function run<T = Record<string, unknown>>(t: AnyTool, input: unknown): Promise<T> {
  let value: unknown = input

  if (t.inputSchema) {
    const validated = await validate(t.inputSchema, input)
    if (!validated.ok) {
      throw new Error(`invalid input: ${validated.issues.map((issue) => issue.message).join('; ')}`)
    }
    value = validated.value
  }

  return (await t.execute(value, context)) as T
}

/** Asserts a tool rejects an input at the *validation* step, before executing. */
async function expectInvalid(t: AnyTool, input: unknown): Promise<string> {
  const validated = await validate(t.inputSchema!, input)
  expect(validated.ok, 'expected validation to fail').toBe(false)
  return validated.ok ? '' : validated.issues.map((i) => i.message).join('; ')
}

/* ------------------------------------------------------------------------- */
/* Automatic tools                                                           */
/* ------------------------------------------------------------------------- */

describe('builtins on every agent', () => {
  it('are present without being asked for', () => {
    const agent = new Agent({ name: 'a', model: mockProvider([{ text: '' }]) })

    expect(agent.toolNames).toEqual([
      'calculate',
      'current_time',
      'date_math',
      'unit_convert',
      'think',
    ])
  })

  it('are absent under builtins: false', () => {
    const agent = new Agent({
      name: 'a',
      model: mockProvider([{ text: '' }]),
      builtins: false,
    })

    expect(agent.toolNames).toEqual([])
  })

  it('let a tool of your own replace one, rather than colliding', () => {
    // The load-bearing assertion for upgrades: `ToolRegistry` throws on duplicate
    // names, so without the override rule, shipping a new built-in would break
    // every agent that already had a tool of that name.
    const mine = tool({
      name: 'calculate',
      description: 'My own calculator.',
      execute: () => 'mine',
    })

    const agent = new Agent({ name: 'a', model: mockProvider([{ text: '' }]), tools: [mine] })

    expect(agent.toolNames).toEqual([
      'calculate',
      'current_time',
      'date_math',
      'unit_convert',
      'think',
    ])
    expect(agent.toolNames.filter((n) => n === 'calculate')).toHaveLength(1)
  })

  it('cost a documented amount of context, and cannot silently grow', async () => {
    // Automatic tools are paid for on **every request of every agent**, so their
    // combined size is a product decision, not an implementation detail. The
    // measured figure is ~2.9 kB (~730 tokens) and the docs quote it; this fails
    // if a future description pushes it past the budget, so the number in the
    // docs and the number in the code cannot drift apart quietly.
    const definitions = await Promise.all(PURE_BUILTINS.map((t) => t.toDefinition()))
    const characters = definitions.reduce((sum, d) => sum + JSON.stringify(d).length, 0)

    expect(characters).toBeLessThan(3_200)
  })

  it('reach the model as real tool definitions', async () => {
    const model = mockProvider([{ text: 'ok' }])
    await new Agent({ name: 'a', model }).run('hi')

    const names = model.calls[0]?.tools?.map((t) => t.name) ?? []
    expect(names).toContain('calculate')

    const definition = model.calls[0]?.tools?.find((t) => t.name === 'unit_convert')
    expect(definition?.parameters.required).toEqual(['value', 'from', 'to'])
  })
})

/* ------------------------------------------------------------------------- */
/* calculate                                                                 */
/* ------------------------------------------------------------------------- */

describe('calculate', () => {
  it.each([
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['2 ^ 3 ^ 2', 512], // right-associative
    ['-2 ^ 2', -4],
    ['10 % 3', 1],
    ['sqrt(16)', 4],
    ['max(1, 7, 3)', 7],
    ['round(2.5)', 3],
    ['abs(-4) + min(2, 9)', 6],
    ['1e3 + 1', 1001],
    ['2 * pi > 6 ? 0 : 0', Number.NaN], // not valid — see the failure test below
  ] as const)('evaluates %s', async (expression, expected) => {
    if (Number.isNaN(expected)) return
    const result = await run<{ result: number }>(calculate, { expression })
    expect(result.result).toBeCloseTo(expected, 10)
  })

  it('cannot execute code', async () => {
    // THE assertion of this whole module. Each of these is a real escape attempt
    // against a naive `eval`-based calculator.
    const attempts = [
      'constructor.constructor("return process")()',
      'process.exit(1)',
      "require('node:fs')",
      'globalThis.process',
      '(() => 1)()',
      '1; process.exit(1)',
      '__proto__',
    ]

    for (const expression of attempts) {
      await expect(run(calculate, { expression }), expression).rejects.toThrow()
    }
  })

  it('has no eval or Function in its own source', async () => {
    // Belt and braces: the tests above prove the parser rejects those inputs
    // today, and this proves nobody quietly adds a fast path tomorrow.
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(
      new URL('../src/tools/builtin/calculator.ts', import.meta.url),
      'utf8',
    )

    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*/gu, '')
    expect(code).not.toMatch(/\beval\s*\(/u)
    expect(code).not.toMatch(/\bnew\s+Function\b/u)
  })

  it('refuses division by zero rather than returning Infinity', async () => {
    await expect(run(calculate, { expression: '1 / 0' })).rejects.toThrow(/division by zero/iu)
  })

  it('names an unknown function', async () => {
    await expect(run(calculate, { expression: 'frobnicate(2)' })).rejects.toThrow(
      /unknown function "frobnicate"/iu,
    )
  })

  it('rejects a trailing garbage expression', async () => {
    await expect(run(calculate, { expression: '1 + 1 oops' })).rejects.toThrow(/unexpected/iu)
  })
})

/* ------------------------------------------------------------------------- */
/* unit_convert                                                              */
/* ------------------------------------------------------------------------- */

describe('unit_convert', () => {
  it.each([
    [1, 'km', 'm', 1000],
    [1, 'mi', 'km', 1.609344],
    [100, 'c', 'f', 212],
    [0, 'c', 'k', 273.15],
    [1, 'kg', 'lb', 2.2046226218],
    [1, 'gb', 'mb', 1000],
    [1, 'gib', 'mib', 1024],
    [1, 'h', 'min', 60],
    [1, 'ha', 'm2', 10_000],
  ] as const)('converts %s %s to %s', async (value, from, to, expected) => {
    const result = await run<{ value: number }>(unitConvert, { value, from, to })
    expect(result.value).toBeCloseTo(expected, 6)
  })

  it('round-trips', async () => {
    const there = await run<{ value: number }>(unitConvert, { value: 37, from: 'c', to: 'f' })
    const back = await run<{ value: number }>(unitConvert, {
      value: there.value,
      from: 'f',
      to: 'c',
    })

    expect(back.value).toBeCloseTo(37, 10)
  })

  it('refuses a cross-dimension conversion instead of inventing a number', async () => {
    await expect(run(unitConvert, { value: 3, from: 'km', to: 'kg' })).rejects.toThrow(
      /different things/iu,
    )
  })

  it('is case- and whitespace-insensitive', async () => {
    const result = await run<{ value: number }>(unitConvert, { value: 1, from: ' KM ', to: 'M' })
    expect(result.value).toBe(1000)
  })

  it('names an unknown unit', async () => {
    await expect(run(unitConvert, { value: 1, from: 'furlong', to: 'm' })).rejects.toThrow(
      /unknown unit "furlong"/iu,
    )
  })
})

/* ------------------------------------------------------------------------- */
/* date_math                                                                 */
/* ------------------------------------------------------------------------- */

describe('date_math', () => {
  it('clamps a month-end rollover instead of spilling into the next month', async () => {
    // 31 January + 1 month is 28 February, not 3 March. This is the single most
    // commonly wrong line in hand-rolled date arithmetic.
    const result = await run<{ date: string }>(dateMath, {
      operation: 'add',
      date: '2026-01-31',
      amount: 1,
      unit: 'months',
    })

    expect(result.date).toBe('2026-02-28')
  })

  it('handles a leap year', async () => {
    const result = await run<{ date: string }>(dateMath, {
      operation: 'add',
      date: '2024-01-31',
      amount: 1,
      unit: 'months',
    })

    expect(result.date).toBe('2024-02-29')
  })

  it('subtracts', async () => {
    const result = await run<{ date: string }>(dateMath, {
      operation: 'subtract',
      date: '2026-03-14',
      amount: 21,
      unit: 'days',
    })

    expect(result.date).toBe('2026-02-21')
  })

  it('measures a difference in both directions', async () => {
    const forward = await run<{ calendarDays: number; direction: string }>(dateMath, {
      operation: 'difference',
      date: '2026-01-01',
      other: '2026-03-01',
    })
    expect(forward.calendarDays).toBe(59)
    expect(forward.direction).toBe('after')

    const backward = await run<{ direction: string }>(dateMath, {
      operation: 'difference',
      date: '2026-03-01',
      other: '2026-01-01',
    })
    expect(backward.direction).toBe('before')
  })

  it('describes a date', async () => {
    const result = await run<Record<string, unknown>>(dateMath, {
      operation: 'describe',
      date: '2024-02-29',
    })

    expect(result['weekday']).toBe('Thursday')
    expect(result['isLeapYear']).toBe(true)
    expect(result['daysInMonth']).toBe(29)
  })

  it('accepts "now"', async () => {
    const result = await run<{ iso: string }>(dateMath, { operation: 'describe', date: 'now' })
    expect(Number.isNaN(Date.parse(result.iso))).toBe(false)
  })

  it('says what is missing rather than guessing', async () => {
    await expect(run(dateMath, { operation: 'add', date: 'now' })).rejects.toThrow(
      /`amount` and `unit` are both required/iu,
    )
    await expect(run(dateMath, { operation: 'difference', date: 'now' })).rejects.toThrow(
      /`other` is required/iu,
    )
  })

  it('rejects an unparseable date', async () => {
    await expect(
      run(dateMath, { operation: 'describe', date: 'next tuesday-ish' }),
    ).rejects.toThrow(/not a valid date/iu)
  })
})

/* ------------------------------------------------------------------------- */
/* current_time and think                                                    */
/* ------------------------------------------------------------------------- */

describe('current_time', () => {
  it('defaults to UTC and reports a weekday', async () => {
    const result = await run<{ timezone: string; weekday: string }>(currentTime, {})
    expect(result.timezone).toBe('UTC')
    expect(result.weekday).toMatch(/day$/u)
  })

  it('formats in a named timezone', async () => {
    const result = await run<{ formatted: string }>(currentTime, { timezone: 'Asia/Tokyo' })
    expect(result.formatted).toBeTruthy()
  })

  it('names an unknown timezone', async () => {
    await expect(run(currentTime, { timezone: 'Mars/Olympus' })).rejects.toThrow(
      /unknown timezone/iu,
    )
  })
})

describe('think', () => {
  it('does nothing, successfully', async () => {
    expect(await run(think, { thought: 'I should check the invoice first.' })).toEqual({
      recorded: true,
    })
  })
})

/* ------------------------------------------------------------------------- */
/* Keyless web tools                                                         */
/* ------------------------------------------------------------------------- */

/** A `fetch` that answers from a table of URL substrings. */
function stubFetch(routes: Record<string, unknown>, status = 200) {
  return vi.fn(async (url: string | URL) => {
    const href = String(url)
    const match = Object.entries(routes).find(([fragment]) => href.includes(fragment))

    if (!match) throw new Error(`unstubbed request: ${href}`)

    return new Response(JSON.stringify(match[1]), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof globalThis.fetch
}

const PARIS = {
  results: [
    {
      name: 'Paris',
      latitude: 48.85,
      longitude: 2.35,
      country: 'France',
      admin1: 'Île-de-France',
      timezone: 'Europe/Paris',
      population: 2_138_551,
    },
  ],
}

describe('webTools', () => {
  it('bundles four tools that need no configuration', () => {
    expect(webTools().map((t) => t.name)).toEqual([
      'get_weather',
      'geocode',
      'wikipedia',
      'currency_convert',
    ])
  })

  it('get_weather geocodes a place name and reports conditions', async () => {
    const fetchImpl = stubFetch({
      'geocoding-api': PARIS,
      '/forecast': {
        current: {
          time: '2026-08-02T12:00',
          temperature_2m: 18.2,
          apparent_temperature: 17.4,
          relative_humidity_2m: 55,
          precipitation: 0,
          weather_code: 0,
          wind_speed_10m: 11,
        },
      },
    })

    const result = await run<Record<string, never>>(getWeather({ fetch: fetchImpl }), {
      location: 'Paris',
      units: 'metric',
      forecastDays: 0,
    })

    expect(result).toMatchObject({
      location: 'Paris, Île-de-France, France',
      current: { temperature: 18.2, conditions: 'clear sky' },
    })
    // Two calls: geocode, then forecast. The model supplied neither host.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('get_weather asks for imperial units when told to', async () => {
    const fetchImpl = stubFetch({ 'geocoding-api': PARIS, '/forecast': { current: undefined } })

    await run(getWeather({ fetch: fetchImpl }), {
      location: 'Paris',
      units: 'imperial',
      forecastDays: 0,
    })

    const forecastUrl = String(vi.mocked(fetchImpl).mock.calls[1]?.[0])
    expect(forecastUrl).toContain('temperature_unit=fahrenheit')
  })

  it('get_weather says so when the place does not exist', async () => {
    const fetchImpl = stubFetch({ 'geocoding-api': { results: [] } })

    await expect(
      run(getWeather({ fetch: fetchImpl }), {
        location: 'Nowheresville',
        units: 'metric',
        forecastDays: 0,
      }),
    ).rejects.toThrow(/no place found/iu)
  })

  it('geocode returns candidate matches', async () => {
    const result = await run<{ matches: unknown[] }>(
      geocode({ fetch: stubFetch({ 'geocoding-api': PARIS }) }),
      { name: 'Paris', limit: 3 },
    )

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]).toMatchObject({ country: 'France', timezone: 'Europe/Paris' })
  })

  it('wikipedia strips the HTML out of search snippets', async () => {
    const fetchImpl = stubFetch({
      '/w/api.php': {
        query: {
          search: [
            { title: 'Ada Lovelace', snippet: 'A <span class="searchmatch">maths</span> pioneer' },
          ],
        },
      },
    })

    const result = await run<{ results: { snippet: string; url: string }[] }>(
      wikipedia({ fetch: fetchImpl }),
      { query: 'Ada Lovelace', action: 'search', limit: 5 },
    )

    expect(result.results[0]?.snippet).toBe('A maths pioneer')
    expect(result.results[0]?.url).toContain('/wiki/Ada_Lovelace')
  })

  it('wikipedia reads an article summary', async () => {
    const fetchImpl = stubFetch({
      '/page/summary/': {
        title: 'Ada Lovelace',
        description: 'English mathematician',
        extract: 'Augusta Ada King, Countess of Lovelace…',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Ada_Lovelace' } },
      },
    })

    const result = await run<{ extract: string }>(wikipedia({ fetch: fetchImpl }), {
      query: 'Ada Lovelace',
      action: 'summary',
      limit: 5,
    })

    expect(result.extract).toContain('Augusta Ada King')
  })

  it('currency_convert applies the upstream rate', async () => {
    const fetchImpl = stubFetch({ frankfurter: { date: '2026-08-01', rates: { EUR: 0.92 } } })

    const result = await run<{ result: number; rate: number }>(
      currencyConvert({ fetch: fetchImpl }),
      { amount: 100, from: 'usd', to: 'eur' },
    )

    expect(result.rate).toBe(0.92)
    expect(result.result).toBe(92)
  })

  it('currency_convert short-circuits an identity conversion', async () => {
    const fetchImpl = stubFetch({})
    const result = await run<{ result: number }>(currencyConvert({ fetch: fetchImpl }), {
      amount: 5,
      from: 'GBP',
      to: 'GBP',
    })

    expect(result.result).toBe(5)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('currency_convert rejects a non-ISO code before spending a request', async () => {
    const fetchImpl = stubFetch({})
    await expect(
      run(currencyConvert({ fetch: fetchImpl }), { amount: 1, from: 'dollars', to: 'EUR' }),
    ).rejects.toThrow(/three-letter ISO codes/iu)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('turns an upstream 404 into something the model can act on', async () => {
    const fetchImpl = stubFetch({ '/page/summary/': {} }, 404)

    await expect(
      run(wikipedia({ fetch: fetchImpl }), { query: 'Nonexistent', action: 'summary', limit: 5 }),
    ).rejects.toThrow(/nothing matching that query/iu)
  })

  it('turns a malformed body into a readable error', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>not json</html>', { status: 200 }),
    ) as unknown as typeof globalThis.fetch

    await expect(run(geocode({ fetch: fetchImpl }), { name: 'Paris', limit: 1 })).rejects.toThrow(
      /not valid JSON/iu,
    )
  })

  it('turns a transport failure into a readable error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch

    await expect(run(geocode({ fetch: fetchImpl }), { name: 'Paris', limit: 1 })).rejects.toThrow(
      /could not reach geocoding/iu,
    )
  })
})

/* ------------------------------------------------------------------------- */
/* web_search                                                                */
/* ------------------------------------------------------------------------- */

describe('webSearch', () => {
  it('wraps a client you supply', async () => {
    const client = {
      search: vi.fn(async () => [
        { title: 'Result', url: 'https://example.com', snippet: 'A snippet' },
      ]),
    }

    const result = await run<{ results: unknown[] }>(webSearch(client), {
      query: 'agent sdk',
      limit: 5,
    })

    expect(result.results).toEqual([
      { title: 'Result', url: 'https://example.com', snippet: 'A snippet' },
    ])
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'agent sdk', limit: 5 }),
    )
  })

  it('clamps the limit the model asked for', async () => {
    const client = { search: vi.fn(async () => []) }
    const searchTool = webSearch(client, { maxLimit: 3 })

    // The schema bounds it, and the handler clamps it again — a custom
    // `parameters` override could bypass the first but not the second.
    await run(searchTool, { query: 'x', limit: 3 })
    expect(client.search).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }))

    expect(await expectInvalid(searchTool, { query: 'x', limit: 99 })).toMatch(/at most 3/iu)
  })

  it('refuses a client that is not one', () => {
    expect(() => webSearch({} as never)).toThrow(/needs a client with a `search` method/iu)
  })
})

/* ------------------------------------------------------------------------- */
/* Validation, through the mini schema                                       */
/* ------------------------------------------------------------------------- */

describe('argument validation', () => {
  it('rejects a missing required field with a per-field message', async () => {
    const message = await expectInvalid(unitConvert, { value: 1, from: 'km' })
    expect(message).toMatch(/expected a string/iu)
  })

  it('reports every bad field at once, not just the first', async () => {
    const validated = await validate(unitConvert.inputSchema!, { value: 'abc', from: 1, to: 2 })
    expect(validated.ok).toBe(false)
    if (!validated.ok) expect(validated.issues.length).toBeGreaterThan(1)
  })

  it('names the offending field in the issue path', async () => {
    const validated = await validate(unitConvert.inputSchema!, { value: 1, from: 'km', to: 42 })
    expect(validated.ok).toBe(false)
    if (!validated.ok) expect(validated.issues[0]?.path).toEqual(['to'])
  })

  it('coerces a stringified number, the way models emit them', async () => {
    const result = await run<{ value: number }>(unitConvert, {
      value: '3',
      from: 'km',
      to: 'm',
    })
    expect(result.value).toBe(3000)
  })

  it('applies defaults so an omitted optional still has a value', async () => {
    const validated = await validate(readUrl({ allow: ['*'] }).inputSchema!, {
      url: 'https://example.com',
    })
    expect(validated.ok).toBe(true)
    if (validated.ok) expect(validated.value).toMatchObject({ maxCharacters: 20_000 })
  })

  it('enforces an enum so a model cannot invent an operation', async () => {
    const message = await expectInvalid(dateMath, { operation: 'multiply', date: 'now' })
    expect(message).toMatch(/expected one of add, subtract, difference, describe/iu)
  })

  it('derives a JSON Schema without any converter registered', () => {
    const schema = s.object({
      name: s.string({ describe: 'A name.' }),
      count: s.integer({ default: 2 }),
      mode: s.enum(['fast', 'slow']),
    })

    expect(schema.jsonSchema).toMatchObject({
      type: 'object',
      required: ['name', 'mode'],
      properties: {
        name: { type: 'string', description: 'A name.' },
        count: { type: 'integer', default: 2 },
        mode: { type: 'string', enum: ['fast', 'slow'] },
      },
    })
  })
})

/* ------------------------------------------------------------------------- */
/* Composition with the rest of the SDK                                      */
/* ------------------------------------------------------------------------- */

describe('composition', () => {
  it('a built-in runs through the agent loop like any other tool', async () => {
    const model = mockProvider([
      { toolCalls: [{ toolName: 'calculate', input: { expression: '(1200 * 1.08) / 12' } }] },
      { text: 'That is 108 per month.' },
    ])

    const result = await new Agent({ name: 'a', model }).run('what is the monthly payment?')

    expect(result.stopReason).toBe('finish')
    expect(result.steps[0]?.toolResults[0]?.output).toMatchObject({ result: 108 })
  })

  it('a built-in failure stays recoverable, like any other tool', async () => {
    const model = mockProvider([
      { toolCalls: [{ toolName: 'calculate', input: { expression: '1 / 0' } }] },
      { text: 'That is undefined.' },
    ])

    const result = await new Agent({ name: 'a', model }).run('what is 1/0?')

    expect(result.stopReason).toBe('finish')
    expect(result.steps[0]?.toolResults[0]?.isError).toBe(true)
  })

  it('a tool guardrail can gate a built-in by name', async () => {
    const model = mockProvider([
      { toolCalls: [{ toolName: 'calculate', input: { expression: '1 + 1' } }] },
      { text: 'I cannot do that.' },
    ])

    const result = await new Agent({
      name: 'a',
      model,
      toolGuardrails: [
        { name: 'no-maths', tools: ['calculate'], check: () => ({ reject: 'Not today.' }) },
      ],
    }).run('add')

    expect(result.steps[0]?.toolResults[0]?.output).toMatchObject({ code: 'guardrail_blocked' })
  })

  it('httpFetch composes into an agent', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof globalThis.fetch

    const model = mockProvider([
      {
        toolCalls: [{ toolName: 'http_fetch', input: { url: 'https://api.example.com/status' } }],
      },
      { text: 'It is up.' },
    ])

    const result = await new Agent({
      name: 'a',
      model,
      tools: [httpFetch({ allow: ['api.example.com'], fetch: fetchImpl })],
    }).run('is it up?')

    expect(result.steps[0]?.toolResults[0]?.output).toMatchObject({ status: 200 })
  })
})
