import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import { Agent, tool } from '../src/index.js'
import { collectEvents, mockProvider } from '../src/testing/index.js'

/**
 * These tests pin the three invariants of the runtime documented in
 * `src/run/runner.ts`: it always terminates, a completed run does not throw, and
 * every turn is recorded. Everything runs against `mockProvider` — offline and
 * deterministic, no API key required.
 */

const weather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, tempC: 18, summary: 'clear' }),
})

describe('single-turn run', () => {
  it('returns the model text as the output', async () => {
    const model = mockProvider([{ text: 'Hello there.' }])
    const agent = new Agent({ name: 'assistant', model })

    const result = await agent.run('Hi')

    expect(result.output).toBe('Hello there.')
    expect(result.text).toBe('Hello there.')
    expect(result.stopReason).toBe('finish')
    expect(result.turns).toBe(1)
    expect(result.agentName).toBe('assistant')
    expect(result.runId).toMatch(/^run_/)
  })

  it('sends instructions as the system prompt, not as a chat turn', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, instructions: 'Be terse.' })

    await agent.run('Hi')

    expect(model.calls[0]?.system).toBe('Be terse.')
    expect(model.calls[0]?.messages.every((m) => m.role !== 'system')).toBe(true)
  })

  it('resolves function instructions once per run', async () => {
    const instructions = vi.fn(() => 'Dynamic prompt.')
    const model = mockProvider([
      { toolCalls: [{ toolName: 'get_weather', input: { city: 'Paris' } }] },
      { text: 'done' },
    ])

    await new Agent({ name: 'a', model, instructions, tools: [weather] }).run('Hi')

    expect(instructions).toHaveBeenCalledTimes(1)
  })

  it('omits the tools field entirely when the agent has none', async () => {
    const model = mockProvider([{ text: 'ok' }])

    // `builtins: false` is what makes an agent genuinely tool-less now that five
    // pure tools are automatic. The invariant under test is unchanged: some
    // providers reject an empty `tools: []`, so the field must be absent rather
    // than empty.
    await new Agent({ name: 'a', model, builtins: false }).run('Hi')

    expect(model.calls[0]?.tools).toBeUndefined()
  })
})

describe('tool calling', () => {
  it('executes a tool and feeds the result back to the model', async () => {
    const model = mockProvider([
      { toolCalls: [{ toolName: 'get_weather', input: { city: 'Paris' } }] },
      { text: 'It is 18°C and clear in Paris.' },
    ])
    const agent = new Agent({ name: 'a', model, tools: [weather] })

    const result = await agent.run('Weather in Paris?')

    expect(result.text).toBe('It is 18°C and clear in Paris.')
    expect(result.turns).toBe(2)
    expect(model.calls).toHaveLength(2)

    // The second request must carry the assistant tool-call turn *and* the result.
    const second = model.calls[1]?.messages ?? []
    expect(second.at(-2)?.role).toBe('assistant')
    expect(second.at(-1)?.role).toBe('tool')

    const step = result.steps[0]
    expect(step?.toolCalls).toHaveLength(1)
    expect(step?.toolResults[0]?.output).toEqual({
      city: 'Paris',
      tempC: 18,
      summary: 'clear',
    })
  })

  it('passes the validated (parsed) input to the handler', async () => {
    const execute = vi.fn(() => 'ok')
    const coercing = tool({
      name: 'count',
      description: 'Count something.',
      inputSchema: z.object({ n: z.coerce.number() }),
      execute,
    })

    const model = mockProvider([
      { toolCalls: [{ toolName: 'count', input: { n: '42' } }] },
      { text: 'done' },
    ])

    await new Agent({ name: 'a', model, tools: [coercing] }).run('go')

    // '42' in, 42 out — the handler sees post-validation values, not raw JSON.
    expect(execute).toHaveBeenCalledWith({ n: 42 }, expect.objectContaining({ turn: 1 }))
  })

  it('runs multiple tool calls from one turn concurrently', async () => {
    const order: string[] = []
    const slow = tool({
      name: 'slow',
      description: 'Slow tool.',
      execute: async () => {
        await new Promise((r) => setTimeout(r, 40))
        order.push('slow')
        return 'slow done'
      },
    })
    const fast = tool({
      name: 'fast',
      description: 'Fast tool.',
      execute: () => {
        order.push('fast')
        return 'fast done'
      },
    })

    const model = mockProvider([
      { toolCalls: [{ toolName: 'slow' }, { toolName: 'fast' }] },
      { text: 'both done' },
    ])

    const result = await new Agent({ name: 'a', model, tools: [slow, fast] }).run('go')

    // Concurrent: the fast tool finished first despite being requested second…
    expect(order).toEqual(['fast', 'slow'])
    // …but results keep the model's original call order, so the conversation is
    // deterministic regardless of timing.
    const results = result.steps[0]?.toolResults ?? []
    expect(results.map((r) => r.toolName)).toEqual(['slow', 'fast'])
  })

  it('gives the tool handler a context with run metadata', async () => {
    let seen: unknown
    const probe = tool({
      name: 'probe',
      description: 'Records its context.',
      execute: (_input, context) => {
        seen = { runId: context.runId, agentName: context.agentName, turn: context.turn }
        return 'ok'
      },
    })

    const model = mockProvider([{ toolCalls: [{ toolName: 'probe' }] }, { text: 'done' }])
    const result = await new Agent({ name: 'prober', model, tools: [probe] }).run('go')

    expect(seen).toEqual({ runId: result.runId, agentName: 'prober', turn: 1 })
  })
})

describe('termination', () => {
  it('stops at maxTurns instead of looping forever', async () => {
    // A model that always calls a tool — the pathological case.
    const model = mockProvider([{ toolCalls: [{ toolName: 'get_weather', input: { city: 'X' } }] }])
    const agent = new Agent({ name: 'a', model, tools: [weather], maxTurns: 3 })

    const result = await agent.run('go')

    expect(result.stopReason).toBe('max_turns')
    expect(result.turns).toBe(3)
    expect(model.calls).toHaveLength(3)
  })

  it('lets a run option override the agent maxTurns', async () => {
    const model = mockProvider([{ toolCalls: [{ toolName: 'get_weather', input: { city: 'X' } }] }])
    const agent = new Agent({ name: 'a', model, tools: [weather], maxTurns: 10 })

    const result = await agent.run('go', { maxTurns: 2 })

    expect(result.turns).toBe(2)
  })

  it('rejects a maxTurns below 1 at construction time', () => {
    const model = mockProvider([{ text: 'x' }])
    expect(() => new Agent({ name: 'a', model, maxTurns: 0 })).toThrow(/at least 1/)
  })
})

describe('accounting', () => {
  it('sums usage across every turn', async () => {
    const model = mockProvider([
      {
        toolCalls: [{ toolName: 'get_weather', input: { city: 'Paris' } }],
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      { text: 'done', usage: { inputTokens: 150, outputTokens: 30 } },
    ])

    const result = await new Agent({ name: 'a', model, tools: [weather] }).run('go')

    expect(result.usage.inputTokens).toBe(250)
    expect(result.usage.outputTokens).toBe(50)
    expect(result.usage.totalTokens).toBe(300)
  })

  it('records one step per turn with its own timing', async () => {
    const model = mockProvider([
      { toolCalls: [{ toolName: 'get_weather', input: { city: 'Paris' } }] },
      { text: 'done' },
    ])

    const result = await new Agent({ name: 'a', model, tools: [weather] }).run('go')

    expect(result.steps).toHaveLength(2)
    expect(result.steps.map((s) => s.turn)).toEqual([1, 2])
    expect(result.steps[1]?.toolCalls).toHaveLength(0)
    for (const step of result.steps) {
      expect(step.durationMs).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('conversation continuity', () => {
  it('round-trips messages so a follow-up run keeps context', async () => {
    const first = mockProvider([{ text: 'Nice to meet you, Ada.' }])
    const agent = new Agent({ name: 'a', model: first, instructions: 'Be nice.' })
    const one = await agent.run('My name is Ada.')

    // The system message is included, so the transcript is complete…
    expect(one.messages[0]).toEqual({ role: 'system', content: 'Be nice.' })

    const second = mockProvider([{ text: 'Your name is Ada.' }])
    const two = await agent.clone({ model: second }).run('What is my name?', {
      messages: one.messages,
    })

    // …but it is not re-sent as a chat turn on the next run.
    const sent = second.calls[0]?.messages ?? []
    expect(sent.every((m) => m.role !== 'system')).toBe(true)
    expect(sent).toHaveLength(3) // user, assistant, user
    expect(two.text).toBe('Your name is Ada.')
  })
})

describe('events', () => {
  it('emits a well-ordered event stream for a tool-using run', async () => {
    const collected = collectEvents()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'get_weather', input: { city: 'Paris' } }] },
      { text: 'done' },
    ])

    // Without builtins, so the assertion below stays about *this* agent's tool
    // rather than about which pure tools happen to ship.
    await new Agent({ name: 'a', model, tools: [weather], builtins: false }).run('go', {
      onEvent: collected.listener,
    })

    expect(collected.types()).toEqual([
      'run.start',
      'model.request',
      'model.response',
      'tool.start',
      'tool.end',
      'model.request',
      'model.response',
      'run.finish',
    ])

    expect(collected.first('run.start')?.toolNames).toEqual(['get_weather'])
    expect(collected.first('tool.end')?.isError).toBe(false)
    expect(collected.last('run.finish')?.stopReason).toBe('finish')
  })

  it('never lets a throwing listener break the run', async () => {
    const model = mockProvider([{ text: 'still fine' }])

    const result = await new Agent({ name: 'a', model }).run('go', {
      onEvent: () => {
        throw new Error('instrumentation blew up')
      },
    })

    expect(result.text).toBe('still fine')
  })

  it('stamps every event with an id, timestamp, and runId', async () => {
    const collected = collectEvents()
    const model = mockProvider([{ text: 'ok' }])

    const result = await new Agent({ name: 'a', model }).run('go', {
      onEvent: collected.listener,
    })

    for (const event of collected.events) {
      expect(event.id).toMatch(/^evt_/)
      expect(event.timestamp).toBeGreaterThan(0)
      expect(event.runId).toBe(result.runId)
      expect(event.agentName).toBe('a')
    }
  })
})
