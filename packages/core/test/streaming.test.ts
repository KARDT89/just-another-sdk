import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { Agent, tool, type AgentEvent } from '../src/index.js'
import { compatible, openrouter } from '../src/providers/index.js'
import { mockProvider } from '../src/testing/index.js'

const SECRET = 'sk-or-v1-super-secret-key-value-1234567890'

/** Builds an SSE response body from raw frame payloads. */
function sseResponse(...frames: readonly string[]): Response {
  const body = frames.map((frame) => `data: ${frame}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** One `choices[0].delta` chunk, serialized. */
function delta(payload: Record<string, unknown>): string {
  return JSON.stringify({
    model: 'anthropic/claude-opus-5',
    choices: [{ index: 0, delta: payload }],
  })
}

async function collectEvents(stream: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

/* ------------------------------------------------------------------------- */
/* The transport                                                             */
/* ------------------------------------------------------------------------- */

describe('streaming transport', () => {
  it('asks for a stream and for usage totals', async () => {
    let captured: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse(delta({ content: 'hi' }), '[DONE]')
    }

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
    })

    await agent.stream('go')

    expect(captured?.['stream']).toBe(true)
    expect(captured?.['stream_options']).toEqual({ include_usage: true })
  })

  /**
   * Older vLLM and some Ollama builds 400 on `stream_options`. Removing it must
   * be possible without giving up streaming, which is why the flag is emitted
   * *before* `defaultBody` rather than after it.
   */
  it('lets defaultBody drop stream_options for servers that reject it', async () => {
    let captured: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>
      return sseResponse(delta({ content: 'hi' }), '[DONE]')
    }

    const model = compatible('local-model', {
      baseUrl: 'http://localhost:11434/v1',
      fetch: fetchMock,
      defaultBody: { stream_options: null },
    })

    await new Agent({ name: 'a', model }).stream('go')

    expect(captured?.['stream']).toBe(true)
    expect(captured?.['stream_options']).toBeNull()
  })

  it('concatenates deltas into the same text a non-streamed call would return', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponse(
        delta({ content: 'The ' }),
        delta({ content: 'quick ' }),
        delta({ content: 'fox.' }),
        JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        '[DONE]',
      )

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
    })

    const stream = agent.stream('go')
    const events = await collectEvents(stream)
    const result = await stream

    const streamed = events
      .filter((e) => e.type === 'text.delta')
      .map((e) => e.delta)
      .join('')

    expect(streamed).toBe('The quick fox.')
    expect(result.text).toBe('The quick fox.')
  })

  it('reads usage from the final chunk, which carries no choices', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponse(
        delta({ content: 'hi' }),
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 31, completion_tokens: 7, total_tokens: 38 },
        }),
        '[DONE]',
      )

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
    })

    const result = await agent.stream('go')

    expect(result.usage).toMatchObject({ inputTokens: 31, outputTokens: 7, totalTokens: 38 })
  })

  /**
   * The fiddliest part of the wire format: `id` and `name` appear once, in the
   * first fragment for an index, and every later fragment carries only a slice
   * of the arguments string. Two calls interleave by `index`.
   */
  it('reassembles tool calls fragmented across frames', async () => {
    let call = 0
    const fetchMock: typeof fetch = async () => {
      call += 1
      if (call === 1) {
        return sseResponse(
          delta({
            tool_calls: [
              { index: 0, id: 'call_a', function: { name: 'get_weather', arguments: '{"ci' } },
              { index: 1, id: 'call_b', function: { name: 'get_weather', arguments: '{"ci' } },
            ],
          }),
          delta({ tool_calls: [{ index: 0, function: { arguments: 'ty":"Par' } }] }),
          delta({ tool_calls: [{ index: 1, function: { arguments: 'ty":"Ber' } }] }),
          delta({ tool_calls: [{ index: 0, function: { arguments: 'is"}' } }] }),
          delta({ tool_calls: [{ index: 1, function: { arguments: 'lin"}' } }] }),
          JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
          '[DONE]',
        )
      }
      return sseResponse(delta({ content: 'Both are mild.' }), '[DONE]')
    }

    const seen: string[] = []
    const weather = tool({
      name: 'get_weather',
      description: 'Get weather.',
      inputSchema: z.object({ city: z.string() }),
      execute: ({ city }) => {
        seen.push(city)
        return `${city}: 18C`
      },
    })

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
    })

    const result = await agent.stream('go')

    expect(seen.sort()).toEqual(['Berlin', 'Paris'])
    expect(result.text).toBe('Both are mild.')
  })

  it('produces a response even when the stream never sends a finish reason', async () => {
    const fetchMock: typeof fetch = async () => sseResponse(delta({ content: 'partial' }))

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
    })

    const result = await agent.stream('go')

    expect(result.text).toBe('partial')
    expect(result.stopReason).toBe('finish')
  })

  it('maps a non-200 on a streaming request through the shared error mapping', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'nope' } }), { status: 401 })

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
    })

    await expect(agent.stream('go')).rejects.toMatchObject({
      code: 'authentication_error',
      retryable: false,
    })
  })

  it('surfaces a mid-stream error frame as a provider error', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponse(
        delta({ content: 'starting' }),
        JSON.stringify({ error: { message: 'upstream exploded', code: 'server_error' } }),
      )

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
      maxRetries: 0,
    })

    await expect(agent.stream('go')).rejects.toMatchObject({
      code: 'provider_error',
      message: expect.stringContaining('upstream exploded'),
    })
  })

  it('maps a mid-stream socket failure to a network error', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'))
            controller.error(new TypeError('connection reset'))
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
      maxRetries: 0,
    })

    await expect(agent.stream('go')).rejects.toMatchObject({ code: 'network_error' })
  })

  it('rejects a body that is not an event stream at all', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response('<html>gateway error</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
      maxRetries: 0,
    })

    await expect(agent.stream('go')).rejects.toMatchObject({ code: 'provider_error' })
  })
})

/* ------------------------------------------------------------------------- */
/* agent.stream()                                                            */
/* ------------------------------------------------------------------------- */

describe('agent.stream()', () => {
  it('emits events in a deterministic order', async () => {
    const model = mockProvider([{ text: 'Hello there.' }])
    const agent = new Agent({ name: 'a', model })

    const events = await collectEvents(agent.stream('go'))
    const types = events.map((e) => e.type)

    expect(types[0]).toBe('run.start')
    expect(types[1]).toBe('model.request')
    expect(types.at(-1)).toBe('run.finish')
    // Every delta lands between the request and the response.
    const first = types.indexOf('text.delta')
    expect(first).toBeGreaterThan(types.indexOf('model.request'))
    expect(types.lastIndexOf('text.delta')).toBeLessThan(types.indexOf('model.response'))
  })

  it('resolves to a RunResult when awaited without iterating', async () => {
    const model = mockProvider([{ text: 'No one is watching.' }])
    const agent = new Agent({ name: 'a', model })

    const result = await agent.stream('go')

    expect(result.text).toBe('No one is watching.')
    expect(result.stopReason).toBe('finish')
  })

  it('supports iterating and awaiting the same run', async () => {
    const model = mockProvider([{ text: 'Both at once.' }])
    const agent = new Agent({ name: 'a', model })

    const stream = agent.stream('go')
    const events = await collectEvents(stream)
    const result = await stream

    expect(events.some((e) => e.type === 'run.finish')).toBe(true)
    expect(result.text).toBe('Both at once.')
  })

  /**
   * A provider is not required to implement `stream()`. The consumer should not
   * have to care: the whole answer arrives as one delta, so a renderer written
   * against `text.delta` works against every provider.
   */
  it('falls back to generate() for a provider with no stream()', async () => {
    const model = mockProvider([{ text: 'Generated, not streamed.' }], {
      supportsStreaming: false,
    })
    const agent = new Agent({ name: 'a', model })

    const stream = agent.stream('go')
    const events = await collectEvents(stream)
    const streamed = await stream
    const direct = await agent.run('go')

    const deltas = events.filter((e) => e.type === 'text.delta')
    expect(deltas).toHaveLength(1)
    expect(deltas[0]?.delta).toBe('Generated, not streamed.')
    expect(model.streamCallCount).toBe(0)
    expect(streamed.text).toBe(direct.text)
  })

  it('never exposes a partial tool-call argument', async () => {
    const model = mockProvider([
      { toolCalls: [{ toolName: 'get_weather', input: { city: 'Paris' } }] },
      { text: 'It is mild.' },
    ])

    const weather = tool({
      name: 'get_weather',
      description: 'Get weather.',
      inputSchema: z.object({ city: z.string() }),
      execute: ({ city }) => `${city}: 18C`,
    })

    const agent = new Agent({ name: 'a', model, tools: [weather] })
    const events = await collectEvents(agent.stream('go'))

    const started = events.filter((e) => e.type === 'tool.start')
    expect(started).toHaveLength(1)
    // Complete and already validated — not a fragment of JSON text.
    expect(started[0]?.input).toEqual({ city: 'Paris' })

    // No event type in the union carries argument fragments.
    expect(events.some((e) => 'inputDelta' in e)).toBe(false)
  })

  it('yields run.error last and then throws the same error', async () => {
    const boom = new Error('provider exploded')
    const model = mockProvider([{ error: boom }])
    const agent = new Agent({ name: 'a', model, maxRetries: 0 })

    const stream = agent.stream('go')
    const seen: AgentEvent[] = []
    let thrown: unknown

    try {
      for await (const event of stream) seen.push(event)
    } catch (error) {
      thrown = error
    }

    expect(seen.at(-1)?.type).toBe('run.error')
    expect(thrown).toMatchObject({ message: 'provider exploded' })
    await expect(stream.completed).rejects.toThrow('provider exploded')
  })

  /**
   * A consumer who only iterates never attaches a handler to the result promise.
   * Without an internal `.catch()`, every failing streamed run would print an
   * `unhandledRejection` warning — or crash a strict process.
   */
  it('does not produce an unhandled rejection when only iterated', async () => {
    const rejections: unknown[] = []
    const onRejection = (error: unknown) => rejections.push(error)
    process.on('unhandledRejection', onRejection)

    try {
      const model = mockProvider([{ error: new Error('boom') }])
      const agent = new Agent({ name: 'a', model, maxRetries: 0 })

      try {
        for await (const _event of agent.stream('go')) {
          // drain
        }
      } catch {
        // expected
      }

      // Unhandled rejections are reported on a later macrotask tick.
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  /**
   * `break` abandons the *iterator*, not the run. The work is already in flight
   * and billable, and because the stream doubles as a promise, cancelling here
   * would make the natural "read a bit, then await the result" pattern throw.
   */
  it('does not cancel the run when the consumer breaks early', async () => {
    const model = mockProvider([{ text: 'one two three four five' }])
    const agent = new Agent({ name: 'a', model })

    const stream = agent.stream('go')
    for await (const _event of stream) break

    const result = await stream
    expect(result.stopReason).toBe('finish')
    expect(result.text).toBe('one two three four five')
  })

  it('cancels the run on abort()', async () => {
    const model = mockProvider([{ text: 'too late', delayMs: 500 }])
    const agent = new Agent({ name: 'a', model })

    const stream = agent.stream('go')
    stream.abort()

    await expect(stream.completed).rejects.toMatchObject({ code: 'aborted' })
  })

  it('refuses a second iteration', async () => {
    const model = mockProvider([{ text: 'once' }])
    const agent = new Agent({ name: 'a', model })

    const stream = agent.stream('go')
    await collectEvents(stream)

    expect(() => stream[Symbol.asyncIterator]()).toThrow(/already been iterated/)
  })

  it('textStream() yields only the text, joining to the final answer', async () => {
    const model = mockProvider([{ text: 'A haiku about types.' }])
    const agent = new Agent({ name: 'a', model })

    const stream = agent.stream('go')
    let text = ''
    for await (const chunk of stream.textStream()) text += chunk

    const result = await stream
    expect(text).toBe(result.text)
  })

  /**
   * The queue buffers rather than applying backpressure, so a consumer slower
   * than the producer must still see every event, in order.
   */
  it('delivers every event in order to a slow consumer', async () => {
    const model = mockProvider([{ toolCalls: [{ toolName: 'noop', input: {} }] }, { text: 'done' }])
    const noop = tool({
      name: 'noop',
      description: 'Does nothing.',
      inputSchema: z.object({}),
      execute: () => 'ok',
    })

    const agent = new Agent({ name: 'a', model, tools: [noop] })

    const types: string[] = []
    for await (const event of agent.stream('go')) {
      await new Promise((resolve) => setTimeout(resolve, 5))
      types.push(event.type)
    }

    expect(types[0]).toBe('run.start')
    expect(types.at(-1)).toBe('run.finish')
    expect(types).toContain('tool.start')
    expect(types).toContain('tool.end')
  })

  it('still honours maxTurns and the caller’s own onEvent', async () => {
    const model = mockProvider([{ toolCalls: [{ toolName: 'noop', input: {} }] }])
    const noop = tool({
      name: 'noop',
      description: 'Does nothing.',
      inputSchema: z.object({}),
      execute: () => 'ok',
    })

    const observed: string[] = []
    const agent = new Agent({ name: 'a', model, tools: [noop] })

    const result = await agent.stream('go', {
      maxTurns: 2,
      onEvent: (event) => observed.push(event.type),
    })

    expect(result.stopReason).toBe('max_turns')
    expect(result.turns).toBe(2)
    expect(observed).toContain('run.finish')
  })
})
