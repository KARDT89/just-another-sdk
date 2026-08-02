import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'

import { Agent, InvalidOutputError, InvalidSchemaError, memorySession, tool } from '../src/index.js'
import { extractJson } from '../src/run/output.js'
import { collectEvents, mockProvider } from '../src/testing/index.js'

/**
 * Structured output: `outputSchema` turns `result.output` from a string into a
 * validated object, and a model that answers badly gets one bounded chance to
 * fix it.
 *
 * The two assertions worth reading twice are "repairs do not multiply with
 * transport retries" and "a run that never validated persists nothing" — those
 * are the properties the design is built around, not incidental behaviour.
 */

const Ticket = z.object({
  category: z.enum(['bug', 'feature', 'question']),
  severity: z.number().int().min(1).max(5),
  summary: z.string(),
})

/** The answer a well-behaved model gives. */
const VALID = '{"category":"bug","severity":3,"summary":"Login fails"}'

/** Same object, but `severity` is a string — one field wrong, the common case. */
const WRONG_FIELD = '{"category":"bug","severity":"high","summary":"Login fails"}'

const lookup = tool({
  name: 'lookup_customer',
  description: 'Look up a customer by email.',
  inputSchema: z.object({ email: z.string() }),
  execute: ({ email }) => ({ email, plan: 'enterprise' }),
})

describe('extracting JSON', () => {
  it('takes a bare object or array', () => {
    expect(extractJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(extractJson('  [1,2]  ')).toEqual({ ok: true, value: [1, 2] })
  })

  it('finds an object wrapped in prose', () => {
    const result = extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.')
    expect(result).toEqual({ ok: true, value: { a: 1 } })
  })

  it('finds an object inside a fenced block, labelled or not', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } })
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('is not fooled by a closing brace inside a string', () => {
    // The case a greedy or lazy regex gets wrong: lazy truncates at the `}`
    // inside the string, greedy swallows the trailing prose.
    const text = 'Here is the result: {"note":"use } sparingly","a":1} — done.'
    expect(extractJson(text)).toEqual({ ok: true, value: { note: 'use } sparingly', a: 1 } })
  })

  it('is not fooled by escaped quotes', () => {
    const text = 'Result: {"quote":"she said \\"hi\\"","a":1}'
    expect(extractJson(text)).toEqual({ ok: true, value: { quote: 'she said "hi"', a: 1 } })
  })

  it('does not stitch two separate objects together', () => {
    expect(extractJson('first {"a":1} then {"b":2}')).toEqual({ ok: true, value: { a: 1 } })
  })

  it('reports failure rather than guessing', () => {
    expect(extractJson('I am afraid I cannot do that.')).toEqual({ ok: false })
    expect(extractJson('')).toEqual({ ok: false })
    expect(extractJson('{ not json }')).toEqual({ ok: false })
  })

  it('distinguishes a parsed null from a parse failure', () => {
    // `{ ok: true, value: null }` and `{ ok: false }` must not collapse into one
    // another — that is the whole reason for the discriminated result.
    expect(extractJson('[null]')).toEqual({ ok: true, value: [null] })
  })
})

describe('deriving the schema', () => {
  it('sends a JSON Schema derived from the validator', async () => {
    const model = mockProvider([{ text: VALID }])
    await new Agent({ name: 'triage', model, outputSchema: Ticket }).run('x')

    const format = model.calls[0]?.responseFormat
    expect(format?.type).toBe('json')
    expect(format?.schema?.type).toBe('object')
    expect(Object.keys(format?.schema?.properties ?? {})).toEqual([
      'category',
      'severity',
      'summary',
    ])
  })

  it('leaves strict mode off unless asked', async () => {
    // On by default would 400 against OpenAI for any schema with an optional
    // field, which is most of them.
    const model = mockProvider([{ text: VALID }])
    await new Agent({ name: 'triage', model, outputSchema: Ticket }).run('x')

    expect(model.calls[0]?.responseFormat?.strict).toBeUndefined()
  })

  it('prefers an explicit outputJsonSchema', async () => {
    const explicit = {
      type: 'object' as const,
      properties: { summary: { type: 'string' as const } },
      required: ['summary'],
      additionalProperties: false,
    }
    const model = mockProvider([{ text: VALID }])

    await new Agent({
      name: 'triage',
      model,
      outputSchema: Ticket,
      outputJsonSchema: explicit,
    }).run('x')

    expect(model.calls[0]?.responseFormat?.schema).toEqual(explicit)
  })

  it('names the outputSchema, not a tool, when it cannot be converted', async () => {
    // The reason `resolveJsonSchema` takes a subject: a hint telling you to fix
    // your `tool()` call is useless when you never wrote one.
    const opaque = {
      '~standard': {
        version: 1 as const,
        vendor: 'mystery',
        validate: (v: unknown) => ({ value: v }),
      },
    }
    const model = mockProvider([{ text: VALID }])
    const agent = new Agent({ name: 'triage', model, outputSchema: opaque })

    await expect(agent.run('x')).rejects.toThrow(InvalidSchemaError)
    await expect(agent.run('x')).rejects.toThrow(/outputSchema/)
  })

  it('rejects a non-object schema with advice aimed at the agent', async () => {
    const model = mockProvider([{ text: '"hello"' }])
    const agent = new Agent({ name: 'triage', model, outputSchema: z.string() })

    await expect(agent.run('x')).rejects.toThrow(/must describe an object/)
  })
})

describe('the happy path', () => {
  it('returns a validated object as the output', async () => {
    const model = mockProvider([{ text: VALID }])
    const result = await new Agent({ name: 'triage', model, outputSchema: Ticket }).run('x')

    expect(result.output).toEqual({ category: 'bug', severity: 3, summary: 'Login fails' })
    expect(result.text).toBe(VALID)
    expect(result.stopReason).toBe('finish')
    expect(result.turns).toBe(1)
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0]?.kind).toBe('turn')
  })

  it('infers the output type from the schema', async () => {
    const model = mockProvider([{ text: VALID }])
    const agent = new Agent({ name: 'triage', model, outputSchema: Ticket })
    const result = await agent.run('x')

    expectTypeOf(result.output).toEqualTypeOf<z.infer<typeof Ticket>>()
    expectTypeOf(result.output.severity).toEqualTypeOf<number>()

    // A schemaless agent is still a string, and an explicit parameter still wins.
    const plain = new Agent({ name: 'plain', model })
    expectTypeOf((await plain.run('x')).output).toEqualTypeOf<string>()
    expectTypeOf((await plain.run<number>('x')).output).toEqualTypeOf<number>()

    // clone/session/stream all carry the schema's type through.
    expectTypeOf((await agent.clone({ name: 'c' }).run('x')).output).toEqualTypeOf<
      z.infer<typeof Ticket>
    >()
    expectTypeOf((await agent.session('s').run('x')).output).toEqualTypeOf<z.infer<typeof Ticket>>()
    expectTypeOf((await plain.clone({ outputSchema: Ticket }).run('x')).output).toEqualTypeOf<
      z.infer<typeof Ticket>
    >()
  })

  it('appends the schema instruction to the system prompt on every call', async () => {
    const model = mockProvider([
      { toolCalls: [{ toolName: 'lookup_customer', input: { email: 'a@b.c' } }] },
      { text: VALID },
    ])

    await new Agent({
      name: 'triage',
      model,
      instructions: 'Be terse.',
      tools: [lookup],
      outputSchema: Ticket,
    }).run('x')

    for (const call of model.calls) {
      expect(call.system).toContain('Be terse.')
      expect(call.system).toContain('conforms to this JSON Schema')
      expect(call.responseFormat?.type).toBe('json')
    }
  })

  it('still sends the schema instruction when the agent has no instructions', async () => {
    const model = mockProvider([{ text: VALID }])
    await new Agent({ name: 'triage', model, outputSchema: Ticket }).run('x')

    expect(model.calls[0]?.system).toContain('conforms to this JSON Schema')
  })

  it('changes nothing for an agent without a schema', async () => {
    // The regression guard for the whole step.
    const model = mockProvider([{ text: 'Hello there.' }])
    const result = await new Agent({ name: 'plain', model }).run('x')

    expect(result.output).toBe('Hello there.')
    expect(result.output).toBe(result.text)
    expect(result.steps[0]?.kind).toBe('turn')
    expect(model.calls[0]?.responseFormat).toBeUndefined()
    expect(model.calls[0]?.system).toBeUndefined()
  })
})

describe('repair', () => {
  it('re-asks once and returns the corrected object', async () => {
    const model = mockProvider([{ text: WRONG_FIELD }, { text: VALID }], {
      onExhausted: 'throw',
    })
    const result = await new Agent({ name: 'triage', model, outputSchema: Ticket }).run('x')

    expect(result.output.severity).toBe(3)
    expect(model.calls).toHaveLength(2)
  })

  it('records the repair as a step but not as a turn', async () => {
    const model = mockProvider([{ text: WRONG_FIELD }, { text: VALID }])
    const result = await new Agent({ name: 'triage', model, outputSchema: Ticket }).run('x')

    expect(result.turns).toBe(1)
    expect(result.steps.map((step) => step.kind)).toEqual(['turn', 'repair'])
    // The repair carries the turn it is repairing, so steps group by exchange.
    expect(result.steps[1]?.turn).toBe(1)
    // Both model calls are billed.
    expect(result.usage.outputTokens).toBe(10)
  })

  it('shows the model which field failed', async () => {
    const model = mockProvider([{ text: WRONG_FIELD }, { text: VALID }])
    await new Agent({ name: 'triage', model, outputSchema: Ticket }).run('x')

    const last = model.calls[1]?.messages.at(-1)
    expect(last?.role).toBe('user')
    expect(JSON.stringify(last?.content)).toContain('severity')
  })

  it('sends no tools on a repair, even when the agent has them', async () => {
    // A tool call at this point could not be executed — we are outside the loop.
    const model = mockProvider([
      { toolCalls: [{ toolName: 'lookup_customer', input: { email: 'a@b.c' } }] },
      { text: WRONG_FIELD },
      { text: VALID },
    ])

    await new Agent({ name: 'triage', model, tools: [lookup], outputSchema: Ticket }).run('x')

    expect(model.calls[0]?.tools).toHaveLength(1)
    expect(model.calls[2]?.tools).toBeUndefined()
  })

  it('throws once the budget is spent', async () => {
    const model = mockProvider([{ text: WRONG_FIELD }], { onExhausted: 'repeat-last' })
    const agent = new Agent({ name: 'triage', model, outputSchema: Ticket })

    const error = await agent.run('x').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(InvalidOutputError)
    const invalid = error as InvalidOutputError
    expect(invalid.code).toBe('invalid_output')
    expect(invalid.retryable).toBe(false)
    expect(invalid.issues[0]?.path).toEqual(['severity'])
    expect(invalid.rawText).toBe(WRONG_FIELD)
    expect(invalid.attempts).toBe(1)
    expect(model.calls).toHaveLength(2)
  })

  it('reports no issues when the model returned no JSON at all', async () => {
    const model = mockProvider([{ text: 'I would rather not.' }])
    const agent = new Agent({ name: 'triage', model, outputSchema: Ticket, maxOutputRetries: 0 })

    const error = (await agent.run('x').catch((e: unknown) => e)) as InvalidOutputError

    expect(error.issues).toEqual([])
    expect(error.message).toContain('did not return JSON')
    expect(error.rawText).toBe('I would rather not.')
  })

  it('fails on the first bad answer when maxOutputRetries is 0', async () => {
    const model = mockProvider([{ text: WRONG_FIELD }])
    const agent = new Agent({ name: 'triage', model, outputSchema: Ticket, maxOutputRetries: 0 })

    await expect(agent.run('x')).rejects.toThrow(InvalidOutputError)
    expect(model.calls).toHaveLength(1)
  })

  it('honours a per-run maxOutputRetries override', async () => {
    const model = mockProvider([{ text: WRONG_FIELD }])
    const agent = new Agent({ name: 'triage', model, outputSchema: Ticket })

    await expect(agent.run('x', { maxOutputRetries: 2 })).rejects.toThrow(InvalidOutputError)
    expect(model.calls).toHaveLength(3)
  })

  it('does not multiply with the transport retry budget', async () => {
    // The property the two-budget design exists to guarantee. Every call here
    // succeeds at the transport layer and fails at the schema, so `maxRetries`
    // must contribute nothing: 1 + maxOutputRetries, never (1 + 3) × (1 + 2).
    const model = mockProvider([{ text: WRONG_FIELD }], { onExhausted: 'repeat-last' })
    const agent = new Agent({
      name: 'triage',
      model,
      outputSchema: Ticket,
      maxRetries: 3,
      maxOutputRetries: 2,
    })

    await expect(agent.run('x')).rejects.toThrow(InvalidOutputError)
    expect(model.calls).toHaveLength(3)
  })

  it('keeps the raw text out of the log-safe form', async () => {
    const model = mockProvider([{ text: WRONG_FIELD }])
    const agent = new Agent({ name: 'triage', model, outputSchema: Ticket, maxOutputRetries: 0 })

    const error = (await agent.run('x').catch((e: unknown) => e)) as InvalidOutputError
    const json = JSON.stringify(error.toJSON())

    expect(json).toContain('issues')
    expect(json).toContain('attempts')
    expect(json).not.toContain('Login fails')
  })
})

describe('composing with the rest of the runtime', () => {
  it('runs tools and still returns a typed object', async () => {
    const model = mockProvider([
      { toolCalls: [{ toolName: 'lookup_customer', input: { email: 'a@b.c' } }] },
      { text: VALID },
    ])

    const result = await new Agent({
      name: 'triage',
      model,
      tools: [lookup],
      outputSchema: Ticket,
    }).run('x')

    expect(result.output.category).toBe('bug')
    expect(result.turns).toBe(2)
    expect(result.steps[0]?.toolCalls).toHaveLength(1)
    expect(result.steps.map((step) => step.kind)).toEqual(['turn', 'turn'])
  })

  it('validates a run that stopped at max_turns', async () => {
    const model = mockProvider([
      { toolCalls: [{ toolName: 'lookup_customer', input: { email: 'a@b.c' } }], text: VALID },
    ])

    const result = await new Agent({
      name: 'triage',
      model,
      tools: [lookup],
      outputSchema: Ticket,
      maxTurns: 1,
    }).run('x')

    expect(result.stopReason).toBe('max_turns')
    expect(result.output.severity).toBe(3)
  })

  it('works against a provider that ignores responseFormat', async () => {
    // The prompt instruction and the extractor carrying it alone — which is the
    // situation on Ollama, older vLLM, and some OpenRouter upstreams.
    const model = mockProvider([{ text: `Here you go:\n\`\`\`json\n${VALID}\n\`\`\`` }], {
      supportsStreaming: false,
    })

    const result = await new Agent({ name: 'triage', model, outputSchema: Ticket }).run('x')

    expect(result.output.summary).toBe('Login fails')
  })

  it('persists nothing when the output never validated', async () => {
    // Invariant 5, held by ordering alone: validation runs before the save.
    const store = memorySession()
    const model = mockProvider([{ text: WRONG_FIELD }])
    const agent = new Agent({
      name: 'triage',
      model,
      outputSchema: Ticket,
      session: store,
      maxOutputRetries: 0,
    })

    await expect(agent.run('x', { sessionId: 'u1' })).rejects.toThrow(InvalidOutputError)
    expect(await store.load('u1')).toEqual([])
  })

  it('persists a repaired run in full', async () => {
    const store = memorySession()
    const model = mockProvider([{ text: WRONG_FIELD }, { text: VALID }])
    const agent = new Agent({ name: 'triage', model, outputSchema: Ticket, session: store })

    await agent.run('x', { sessionId: 'u1' })

    // user, bad assistant, repair request, good assistant.
    expect(await store.load('u1')).toHaveLength(4)
  })
})

describe('events', () => {
  it('reports each failed attempt, including the one it gives up on', async () => {
    const collected = collectEvents()
    const model = mockProvider([{ text: WRONG_FIELD }], { onExhausted: 'repeat-last' })
    const agent = new Agent({ name: 'triage', model, outputSchema: Ticket })

    await expect(agent.run('x', { onEvent: collected.listener })).rejects.toThrow(
      InvalidOutputError,
    )

    const invalid = collected.ofType('output.invalid')
    expect(invalid.map((event) => event.repairing)).toEqual([true, false])
    expect(invalid[0]?.attempt).toBe(1)
    expect(invalid[0]?.maxAttempts).toBe(2)
    expect(invalid[0]?.issues[0]?.path).toEqual(['severity'])
    expect(collected.types().at(-1)).toBe('run.error')
  })

  it('says nothing when the first answer validates', async () => {
    const collected = collectEvents()
    const model = mockProvider([{ text: VALID }])

    await new Agent({ name: 'triage', model, outputSchema: Ticket }).run('x', {
      onEvent: collected.listener,
    })

    expect(collected.count('output.invalid')).toBe(0)
  })
})

describe('streaming', () => {
  it('withholds text deltas but still resolves to the typed result', async () => {
    const collected = collectEvents()
    const model = mockProvider([{ text: VALID }])

    const stream = new Agent({ name: 'triage', model, outputSchema: Ticket }).stream('x', {
      onEvent: collected.listener,
    })
    const result = await stream

    expect(collected.count('text.delta')).toBe(0)
    expect(result.output.severity).toBe(3)
    // The transport still streamed — only the event was withheld.
    expect(model.streamCallCount).toBe(1)
  })

  it('still emits deltas without a schema', async () => {
    const collected = collectEvents()
    const model = mockProvider([{ text: 'Hello there.' }])

    await new Agent({ name: 'plain', model }).stream('x', { onEvent: collected.listener })

    expect(collected.count('text.delta')).toBeGreaterThan(0)
  })
})
