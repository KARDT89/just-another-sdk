import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import { Agent, ConfigurationError, tool, type StandardSchemaV1 } from '../src/index.js'
import { mockProvider } from '../src/testing/index.js'

describe('tool definition', () => {
  it('derives a JSON Schema from a Zod schema with no configuration', async () => {
    const weather = tool({
      name: 'get_weather',
      description: 'Get the weather.',
      inputSchema: z.object({
        city: z.string().describe('City name'),
        unit: z.enum(['c', 'f']).optional(),
      }),
      execute: () => 'ok',
    })

    const definition = await weather.toDefinition()

    expect(definition.name).toBe('get_weather')
    expect(definition.parameters.type).toBe('object')
    expect(Object.keys(definition.parameters.properties)).toEqual(['city', 'unit'])
    expect(definition.parameters.required).toEqual(['city'])
    expect(definition.parameters.properties['city']?.description).toBe('City name')
    // `$schema` is stripped: some providers reject it on tool parameters.
    expect(definition.parameters['$schema']).toBeUndefined()
  })

  it('memoizes the derived definition', async () => {
    const t = tool({
      name: 'memo',
      description: 'x',
      inputSchema: z.object({ a: z.string() }),
      execute: () => 'ok',
    })

    const [first, second] = await Promise.all([t.toDefinition(), t.toDefinition()])
    expect(first).toBe(second)
  })

  it('accepts an explicit JSON Schema override', async () => {
    const t = tool({
      name: 'manual',
      description: 'x',
      inputSchema: z.object({ a: z.string() }),
      parameters: {
        type: 'object',
        properties: { a: { type: 'string', description: 'hand written' } },
        required: ['a'],
      },
      execute: () => 'ok',
    })

    const definition = await t.toDefinition()
    expect(definition.parameters.properties['a']?.description).toBe('hand written')
  })

  it('produces an empty object schema for a no-argument tool', async () => {
    const ping = tool({ name: 'ping', description: 'Ping.', execute: () => 'pong' })
    const definition = await ping.toDefinition()

    expect(definition.parameters).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })
  })

  it('rejects an invalid tool name at definition time', () => {
    expect(() => tool({ name: 'has spaces', description: 'x', execute: () => 'ok' })).toThrow(
      ConfigurationError,
    )
  })

  it('rejects a missing description, because the model needs it', () => {
    expect(() => tool({ name: 'x', description: '  ', execute: () => 'ok' })).toThrow(
      /description/i,
    )
  })

  it('rejects a non-Standard-Schema validator with an actionable message', () => {
    // A plain `{ parse }` object — what someone hand-rolling a validator, or
    // passing a Zod v2 schema, would supply. Cast so the runtime guard is what
    // gets tested rather than the compile-time one.
    const notStandardSchema = { parse: (value: unknown) => value } as unknown as StandardSchemaV1

    expect(() =>
      tool({ name: 'x', description: 'x', inputSchema: notStandardSchema, execute: () => 'ok' }),
    ).toThrow(/Standard Schema/)
  })

  it('rejects a non-object schema, since providers require object parameters', async () => {
    const t = tool({
      name: 'scalar',
      description: 'x',
      inputSchema: z.string(),
      execute: () => 'ok',
    })

    await expect(t.toDefinition()).rejects.toThrow(/must accept an object/)
  })

  it('rejects duplicate tool names when the agent is constructed', () => {
    const a = tool({ name: 'dup', description: 'x', execute: () => 1 })
    const b = tool({ name: 'dup', description: 'y', execute: () => 2 })
    const model = mockProvider([{ text: 'x' }])

    expect(() => new Agent({ name: 'agent', model, tools: [a, b] })).toThrow(/both named "dup"/)
  })
})

describe('input validation', () => {
  it('never invokes the handler when validation fails', async () => {
    const execute = vi.fn(() => 'should not run')
    const strict = tool({
      name: 'strict',
      description: 'x',
      inputSchema: z.object({ city: z.string() }),
      execute,
    })

    const model = mockProvider([
      { toolCalls: [{ toolName: 'strict', input: { city: 123 } }] },
      { text: 'recovered' },
    ])

    const result = await new Agent({ name: 'a', model, tools: [strict] }).run('go')

    expect(execute).not.toHaveBeenCalled()
    expect(result.stopReason).toBe('finish')

    const toolResult = result.steps[0]?.toolResults[0]
    expect(toolResult?.isError).toBe(true)
    expect(toolResult?.output).toMatchObject({ code: 'invalid_tool_input' })
  })

  it('reports the failing property path so the model can fix its own call', async () => {
    const nested = tool({
      name: 'nested',
      description: 'x',
      inputSchema: z.object({ location: z.object({ city: z.string() }) }),
      execute: () => 'ok',
    })

    const model = mockProvider([
      { toolCalls: [{ toolName: 'nested', input: { location: {} } }] },
      { text: 'done' },
    ])

    const result = await new Agent({ name: 'a', model, tools: [nested] }).run('go')
    const output = result.steps[0]?.toolResults[0]?.output as { error: string }

    expect(output.error).toContain('location.city')
  })

  it('turns unparsable model JSON into a validation error, not a crash', async () => {
    const t = tool({
      name: 'strict',
      description: 'x',
      inputSchema: z.object({ city: z.string() }),
      execute: () => 'ok',
    })

    // A provider hands through malformed arguments verbatim under this key.
    const model = mockProvider([
      { toolCalls: [{ toolName: 'strict', input: { __unparsedArguments: '{"city":' } }] },
      { text: 'recovered' },
    ])

    const result = await new Agent({ name: 'a', model, tools: [t] }).run('go')

    expect(result.stopReason).toBe('finish')
    expect(result.steps[0]?.toolResults[0]?.isError).toBe(true)
  })
})

describe('tool failure handling', () => {
  it('feeds a thrown error back to the model by default so it can recover', async () => {
    const broken = tool({
      name: 'broken',
      description: 'x',
      execute: () => {
        throw new Error('upstream is down')
      },
    })

    const model = mockProvider([
      { toolCalls: [{ toolName: 'broken' }] },
      { text: 'Sorry, that service is unavailable.' },
    ])

    const result = await new Agent({ name: 'a', model, tools: [broken] }).run('go')

    // The run completed rather than throwing — invariant 2.
    expect(result.stopReason).toBe('finish')
    expect(result.text).toBe('Sorry, that service is unavailable.')

    const output = result.steps[0]?.toolResults[0]?.output as { error: string; code: string }
    expect(output.code).toBe('tool_execution_error')
    expect(output.error).toContain('upstream is down')
  })

  it("throws when onToolError is 'throw'", async () => {
    const broken = tool({
      name: 'broken',
      description: 'x',
      execute: () => {
        throw new Error('fatal')
      },
    })

    const model = mockProvider([{ toolCalls: [{ toolName: 'broken' }] }, { text: 'unused' }])
    const agent = new Agent({ name: 'a', model, tools: [broken], onToolError: 'throw' })

    await expect(agent.run('go')).rejects.toThrow(/fatal/)
  })

  it('reports an unknown tool back to the model with the available names', async () => {
    const known = tool({ name: 'known', description: 'x', execute: () => 'ok' })
    const model = mockProvider([{ toolCalls: [{ toolName: 'ghost' }] }, { text: 'done' }])

    const result = await new Agent({ name: 'a', model, tools: [known] }).run('go')
    const output = result.steps[0]?.toolResults[0]?.output as { error: string; code: string }

    expect(output.code).toBe('tool_not_found')
  })

  it('times out a slow tool without killing the run', async () => {
    const slow = tool({
      name: 'slow',
      description: 'x',
      timeoutMs: 20,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 500))
        return 'too late'
      },
    })

    const model = mockProvider([{ toolCalls: [{ toolName: 'slow' }] }, { text: 'moved on' }])
    const result = await new Agent({ name: 'a', model, tools: [slow] }).run('go')

    expect(result.text).toBe('moved on')
    const output = result.steps[0]?.toolResults[0]?.output as { code: string }
    expect(output.code).toBe('timeout_error')
  })

  it('aborts an in-flight tool when the run is cancelled', async () => {
    const controller = new AbortController()
    const hanging = tool({
      name: 'hang',
      description: 'x',
      execute: async (_input, context) => {
        // A well-behaved handler forwards the signal it is given.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000)
          context.signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted by signal'))
          })
        })
        return 'never'
      },
    })

    const model = mockProvider([{ toolCalls: [{ toolName: 'hang' }] }, { text: 'unused' }])
    const agent = new Agent({ name: 'a', model, tools: [hanging] })

    const promise = agent.run('go', { signal: controller.signal })
    setTimeout(() => controller.abort(), 30)

    await expect(promise).rejects.toMatchObject({ code: 'aborted' })
  })
})
