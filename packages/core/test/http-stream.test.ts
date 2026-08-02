import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import { Agent, readEventStream, tool } from '../src/index.js'
import type { AgentEvent } from '../src/index.js'
import { mockProvider } from '../src/testing/index.js'

/**
 * The bridge between a run and the web platform: a `ReadableStream` of text, a
 * `Response`, an SSE stream of events, and the client-side reader that parses it
 * back.
 *
 * Everything here uses web globals only — no `node:` imports — because that is
 * exactly the property these helpers are supposed to have.
 */

const weather = tool({
  name: 'get_weather',
  description: 'Get the weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, tempC: 18 }),
})

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

describe('toTextStream', () => {
  it('yields exactly the run text and closes', async () => {
    const model = mockProvider([{ text: 'Hello from a real stream.' }])
    const stream = new Agent({ name: 'a', model }).stream('hi')

    const text = await collect(stream.toTextStream())
    const result = await stream

    expect(text).toBe('Hello from a real stream.')
    expect(text).toBe(result.text)
  })

  it('carries text across turns, and no tool noise', async () => {
    const model = mockProvider([
      { text: 'Checking. ', toolCalls: [{ toolName: 'get_weather', input: { city: 'Paris' } }] },
      { text: 'It is 18°C.' },
    ])
    const stream = new Agent({ name: 'a', model, tools: [weather] }).stream('weather?')

    expect(await collect(stream.toTextStream())).toBe('Checking. It is 18°C.')
  })

  it('is UTF-8 encoded, so multi-byte characters survive chunking', async () => {
    const model = mockProvider([{ text: '概要: 18°C — ☀️ café' }])
    const stream = new Agent({ name: 'a', model }).stream('hi')

    expect(await collect(stream.toTextStream())).toBe('概要: 18°C — ☀️ café')
  })

  it('aborts the run when the consumer cancels', async () => {
    const model = mockProvider([{ text: 'one two three four', chunkDelayMs: 20 }])
    const stream = new Agent({ name: 'a', model }).stream('hi')

    const reader = stream.toTextStream().getReader()
    await reader.read()
    await reader.cancel()

    // Cancelling the body is a client hanging up; the run must not keep going.
    await expect(stream.completed).rejects.toMatchObject({ code: 'aborted' })
  })

  it('still counts as the one permitted consumer', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const stream = new Agent({ name: 'a', model }).stream('hi')

    stream.toTextStream()

    expect(() => stream.textStream()).toThrow(/already been iterated/)
  })
})

describe('toResponse', () => {
  it('round-trips through a Response', async () => {
    const model = mockProvider([{ text: 'the answer' }])
    const response = new Agent({ name: 'a', model }).stream('hi').toResponse()

    expect(await response.text()).toBe('the answer')
  })

  it('sets headers a proxy will not eat', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const stream = new Agent({ name: 'a', model }).stream('hi')
    const response = stream.toResponse()

    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(response.headers.get('x-run-id')).toBe(stream.runId)

    await response.text()
  })

  it('lets init override the defaults', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const response = new Agent({ name: 'a', model }).stream('hi').toResponse({
      status: 201,
      headers: { 'content-type': 'text/markdown', 'x-mine': 'yes' },
    })

    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toBe('text/markdown')
    expect(response.headers.get('x-mine')).toBe('yes')
    expect(response.headers.get('cache-control')).toBe('no-store')

    await response.text()
  })

  it('exposes the run id before the run has produced anything', () => {
    const model = mockProvider([{ text: 'ok', delayMs: 50 }])
    const stream = new Agent({ name: 'a', model }).stream('hi')

    expect(stream.runId).toMatch(/^run_/)
    stream.abort()
  })

  it('uses a caller-supplied run id', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const stream = new Agent({ name: 'a', model }).stream('hi', { runId: 'run_mine' })

    expect(stream.runId).toBe('run_mine')
    expect((await stream).runId).toBe('run_mine')
  })
})

describe('toEventResponse and readEventStream', () => {
  it('round-trips the event sequence intact', async () => {
    const model = mockProvider([
      { text: 'Checking. ', toolCalls: [{ toolName: 'get_weather', input: { city: 'Paris' } }] },
      { text: 'It is 18°C.' },
    ])

    const seen: AgentEvent[] = []
    const stream = new Agent({ name: 'a', model, tools: [weather] }).stream('weather?', {
      onEvent: (event) => seen.push(event),
    })

    const received: AgentEvent[] = []
    for await (const event of readEventStream(stream.toEventResponse())) received.push(event)

    // `model.request` is withheld by default; everything else must survive.
    const expected = seen.filter((event) => event.type !== 'model.request')
    expect(received.map((e) => e.type)).toEqual(expected.map((e) => e.type))
    expect(
      received
        .filter((e) => e.type === 'text.delta')
        .map((e) => e.delta)
        .join(''),
    ).toBe('Checking. It is 18°C.')
  })

  it('withholds model.request by default and honours include', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model })

    const withheld: AgentEvent[] = []
    for await (const event of readEventStream(agent.stream('hi').toEventResponse())) {
      withheld.push(event)
    }
    expect(withheld.some((e) => e.type === 'model.request')).toBe(false)

    const chosen: AgentEvent[] = []
    const response = agent
      .stream('hi')
      .toEventResponse({ include: ['model.request', 'run.finish'] })
    for await (const event of readEventStream(response)) chosen.push(event)

    expect(chosen.map((e) => e.type)).toEqual(['model.request', 'run.finish'])
  })

  it('redacts secrets before they leave the process', async () => {
    // A tool handed an API key must not put it on the wire to a browser.
    const leaky = tool({
      name: 'call_api',
      description: 'Calls an API.',
      inputSchema: z.object({ apiKey: z.string() }),
      execute: ({ apiKey }) => ({ ok: true, apiKey }),
    })

    const model = mockProvider([
      { toolCalls: [{ toolName: 'call_api', input: { apiKey: 'sk-live-SUPERSECRET' } }] },
      { text: 'done' },
    ])

    const response = new Agent({ name: 'a', model, tools: [leaky] }).stream('go').toEventResponse()
    const body = await response.text()

    expect(body).not.toContain('sk-live-SUPERSECRET')
    expect(body).toContain('call_api')
  })

  it('numbers events monotonically from zero', async () => {
    const model = mockProvider([{ text: 'a b c' }])
    const body = await new Agent({ name: 'a', model }).stream('hi').toEventResponse().text()

    const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))

    expect(ids[0]).toBe(0)
    expect(ids).toEqual([...ids].sort((x, y) => x - y))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('resumes from fromIndex without renumbering', async () => {
    const model = mockProvider([{ text: 'hello there' }])
    const body = await new Agent({ name: 'a', model })
      .stream('hi')
      .toEventResponse({ fromIndex: 3 })
      .text()

    const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))

    // Indices are positions in the run, not positions in this response — that is
    // what makes them usable as a resume cursor.
    expect(ids[0]).toBe(3)
  })

  it('tracks a cursor the caller can reconnect from', async () => {
    const model = mockProvider([{ text: 'one two' }])
    const cursor = { index: -1 }

    const response = new Agent({ name: 'a', model }).stream('hi').toEventResponse()
    for await (const _event of readEventStream(response, { cursor })) void _event

    expect(cursor.index).toBeGreaterThan(0)
  })

  it('sets the SSE content type', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const response = new Agent({ name: 'a', model }).stream('hi').toEventResponse()

    expect(response.headers.get('content-type')).toBe('text/event-stream')

    await response.text()
  })

  it('surfaces a run failure to the reader rather than ending quietly', async () => {
    const model = mockProvider([{ error: new Error('upstream exploded') }])
    const stream = new Agent({ name: 'a', model, maxRetries: 0 }).stream('hi')

    const received: AgentEvent[] = []
    await expect(async () => {
      for await (const event of readEventStream(stream.toEventStream())) received.push(event)
    }).rejects.toThrow()

    // run.error is delivered before the stream errors, so a UI can explain itself.
    expect(received.at(-1)?.type).toBe('run.error')
  })
})

describe('the stream never outlives its consumer', () => {
  it('does not warn about an unhandled rejection when only the body is read', async () => {
    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)

    try {
      const model = mockProvider([{ error: new Error('boom') }])
      const stream = new Agent({ name: 'a', model, maxRetries: 0 }).stream('hi')

      await collect(stream.toTextStream()).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
