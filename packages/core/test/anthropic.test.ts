import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { Agent, tool } from '../src/index.js'
import { anthropic } from '../src/providers/index.js'
import { mockProvider } from '../src/testing/index.js'

/**
 * The native Anthropic provider, exercised through a real `Agent` with an
 * injected `fetch` — no network, no key, no mocking of our own modules.
 */

const SECRET = 'sk-ant-api03-super-secret-key-value-1234567890'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    model: 'claude-opus-5',
    content: [{ type: 'text', text: 'Hello from Claude.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 12, output_tokens: 4 },
    ...overrides,
  }
}

/**
 * Anthropic frames carry a named `event:` alongside the JSON payload. Deriving
 * the name from `payload.type` is exactly what the real API does, which keeps
 * the fixture honest.
 */
function anthropicStream(...frames: readonly Record<string, unknown>[]): Response {
  const body = frames
    .map((frame) => `event: ${String(frame['type'])}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** The same frames with the `event:` lines stripped. */
function dataOnlyStream(...frames: readonly Record<string, unknown>[]): Response {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const weather = tool({
  name: 'get_weather',
  description: 'Get weather.',
  inputSchema: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, tempC: 18 }),
})

/* ------------------------------------------------------------------------- */
/* Request translation                                                       */
/* ------------------------------------------------------------------------- */

describe('anthropic request translation', () => {
  it('posts to the Messages endpoint with x-api-key, not a bearer token', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchMock: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} }
      return jsonResponse(message())
    }

    await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
    }).run('Hi')

    expect(captured?.url).toBe('https://api.anthropic.com/v1/messages')

    const headers = captured?.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe(SECRET)
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['authorization']).toBeUndefined()
  })

  it('hoists the system prompt to a top-level field', async () => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(message())
    }

    await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
      instructions: 'Be brief.',
    }).run('Hi')

    expect(body?.['system']).toBe('Be brief.')
    expect(body?.['messages']).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }])
  })

  /** Anthropic 400s without `max_tokens`, but `ModelRequest` treats it as optional. */
  it('supplies a max_tokens default, and lets the request and the option override it', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse(message())
    }

    await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
    }).run('Hi')

    await new Agent({
      name: 'b',
      model: anthropic('claude-opus-5', {
        apiKey: SECRET,
        fetch: fetchMock,
        maxOutputTokens: 1000,
      }),
    }).run('Hi')

    await new Agent({
      name: 'c',
      model: anthropic('claude-opus-5', {
        apiKey: SECRET,
        fetch: fetchMock,
        maxOutputTokens: 1000,
      }),
      maxOutputTokens: 512,
    }).run('Hi')

    expect(bodies[0]?.['max_tokens']).toBe(4096)
    expect(bodies[1]?.['max_tokens']).toBe(1000)
    expect(bodies[2]?.['max_tokens']).toBe(512)
  })

  it('serializes tools with input_schema, not parameters', async () => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(message())
    }

    await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
    }).run('Hi')

    expect(body?.['tools']).toEqual([
      {
        name: 'get_weather',
        description: 'Get weather.',
        input_schema: expect.objectContaining({ type: 'object' }),
      },
    ])
  })

  it.each([
    ['auto', undefined],
    ['required', { type: 'any' }],
    ['none', { type: 'none' }],
  ] as const)('maps toolChoice %s', async (choice, expected) => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(message())
    }

    await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
      toolChoice: choice,
    }).run('Hi')

    expect(body?.['tool_choice']).toEqual(expected)
  })

  it('omits tool_choice entirely when the agent has no tools', async () => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(message())
    }

    await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
      builtins: false,
      toolChoice: 'required',
    }).run('Hi')

    expect(body).not.toHaveProperty('tool_choice')
    expect(body).not.toHaveProperty('tools')
  })

  /**
   * The single biggest divergence from the OpenAI provider, which fans one
   * `ToolMessage` out into N `role: 'tool'` messages.
   */
  it('collapses a turn of tool results into one user message of tool_result blocks', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse(
        bodies.length === 1
          ? message({
              stop_reason: 'tool_use',
              content: [
                { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
                { type: 'tool_use', id: 'toolu_2', name: 'get_weather', input: { city: 'Rome' } },
              ],
            })
          : message(),
      )
    }

    await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
    }).run('Weather in Paris and Rome?')

    const second = bodies[1]?.['messages'] as Record<string, unknown>[]
    const assistant = second[1] as { role: string; content: Record<string, unknown>[] }
    const results = second[2] as { role: string; content: Record<string, unknown>[] }

    // Tool input arrives back as an object, never a JSON string.
    expect(assistant.role).toBe('assistant')
    expect(assistant.content).toHaveLength(2)
    expect(assistant.content[0]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_1',
      input: { city: 'Paris' },
    })

    // Both results in ONE user message, not two messages.
    expect(second).toHaveLength(3)
    expect(results.role).toBe('user')
    expect(results.content).toHaveLength(2)
    expect(results.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
    expect(results.content[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_2' })
  })

  /** Anthropic's `metadata` accepts only `user_id`; anything else is a 400. */
  it('narrows metadata to user_id and drops the rest', async () => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(message())
    }

    await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
      metadata: { userId: 'u1', team: 'growth' },
    }).run('Hi')

    expect(body?.['metadata']).toEqual({ user_id: 'u1' })
  })

  /**
   * The contract says an unsupported `responseFormat` must be ignored, never
   * turned into a failed request — `run/output.ts` handles it regardless.
   */
  it('ignores responseFormat by default and emits output_config when opted in', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse(message({ content: [{ type: 'text', text: '{"answer":"yes"}' }] }))
    }

    const outputSchema = z.object({ answer: z.string() })

    await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
      outputSchema,
    }).run('Hi')

    await new Agent({
      name: 'b',
      model: anthropic('claude-opus-5', {
        apiKey: SECRET,
        fetch: fetchMock,
        structuredOutputs: true,
      }),
      outputSchema,
    }).run('Hi')

    expect(bodies[0]).not.toHaveProperty('output_config')
    expect(bodies[1]?.['output_config']).toMatchObject({ format: { type: 'json_schema' } })
  })

  /**
   * Newer Claude models reject `temperature` with a 400, so removing a field
   * the SDK would otherwise send has to be reachable — not just overriding one.
   */
  it('lets defaultBody add a field and remove one the SDK set', async () => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(message())
    }

    await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', {
        apiKey: SECRET,
        fetch: fetchMock,
        defaultBody: { temperature: undefined, thinking: { type: 'adaptive' } },
      }),
      temperature: 0.7,
    }).run('Hi')

    expect(body).not.toHaveProperty('temperature')
    expect(body?.['thinking']).toEqual({ type: 'adaptive' })
  })

  it('normalizes a trailing slash on baseUrl', async () => {
    let url: string | undefined
    const fetchMock: typeof fetch = async (target) => {
      url = String(target)
      return jsonResponse(message())
    }

    await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', {
        apiKey: SECRET,
        fetch: fetchMock,
        baseUrl: 'https://proxy.internal/v1/',
      }),
    }).run('Hi')

    expect(url).toBe('https://proxy.internal/v1/messages')
  })
})

/* ------------------------------------------------------------------------- */
/* Response translation                                                      */
/* ------------------------------------------------------------------------- */

describe('anthropic response translation', () => {
  /**
   * `input_tokens` excludes both cache figures and there is no total, so the
   * OpenAI usage mapper cannot be reused. Getting this wrong under-reports
   * every cached run by the whole prefix.
   */
  it('folds cache tokens into inputTokens and computes the total', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse(
        message({
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 0,
          },
        }),
      )

    const result = await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
    }).run('Hi')

    expect(result.usage).toMatchObject({
      inputTokens: 90,
      outputTokens: 5,
      totalTokens: 95,
      cachedInputTokens: 80,
    })
  })

  it('reports the serving model rather than the requested one', async () => {
    const fetchMock: typeof fetch = async () => jsonResponse(message({ model: 'claude-opus-5-x' }))

    const result = await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
    }).run('Hi')

    expect(result.steps[0]?.modelId).toBe('claude-opus-5-x')
  })

  /** Content beats flag: a turn with tool_use blocks is a tool turn regardless. */
  it('treats end_turn with tool_use blocks as a tool call', async () => {
    let calls = 0
    const fetchMock: typeof fetch = async () => {
      calls += 1
      return jsonResponse(
        calls === 1
          ? message({
              stop_reason: 'end_turn',
              content: [
                { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
              ],
            })
          : message(),
      )
    }

    const result = await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
    }).run('Weather?')

    expect(calls).toBe(2)
    expect(result.steps[0]?.toolCalls).toHaveLength(1)
  })

  it('skips thinking blocks so reasoning never reaches the answer', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse(
        message({
          content: [
            { type: 'thinking', thinking: 'Let me work through this…', signature: 'sig' },
            { type: 'text', text: 'The answer is 4.' },
          ],
        }),
      )

    const result = await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
    }).run('2+2?')

    expect(result.output).toBe('The answer is 4.')
  })

  it.each([
    ['max_tokens', 'length'],
    ['refusal', 'content_filter'],
    ['stop_sequence', 'stop'],
  ])('maps stop_reason %s', async (reason, expected) => {
    const fetchMock: typeof fetch = async () => jsonResponse(message({ stop_reason: reason }))

    const result = await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
    }).run('Hi')

    expect(result.steps[0]?.finishReason).toBe(expected)
  })
})

/* ------------------------------------------------------------------------- */
/* Streaming                                                                 */
/* ------------------------------------------------------------------------- */

const TEXT_STREAM: readonly Record<string, unknown>[] = [
  { type: 'message_start', message: { model: 'claude-opus-5', usage: { input_tokens: 25 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'ping' },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
]

describe('anthropic streaming', () => {
  it('reassembles text and usage from the named events', async () => {
    const fetchMock: typeof fetch = async () => anthropicStream(...TEXT_STREAM)

    const result = await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
    }).stream('Hi')

    expect(result.output).toBe('Hello there')
    // Input from `message_start`, output from `message_delta` — always emitted
    // as a `finish` chunk, or the runner would report zero usage for the turn.
    expect(result.usage).toMatchObject({ inputTokens: 25, outputTokens: 7, totalTokens: 32 })
  })

  /**
   * The provider switches on the payload's own `type`, not the SSE `event:`
   * name. They always agree, and proxies have been known to drop the name —
   * this test is the justification for that choice.
   */
  it('produces an identical result when the event: lines are stripped', async () => {
    const named: typeof fetch = async () => anthropicStream(...TEXT_STREAM)
    const bare: typeof fetch = async () => dataOnlyStream(...TEXT_STREAM)

    const a = await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: named }),
    }).stream('Hi')
    const b = await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: bare }),
    }).stream('Hi')

    expect(b.output).toBe(a.output)
    expect(b.usage).toEqual(a.usage)
  })

  it('accumulates two parallel tool calls from interleaved input_json_delta frames', async () => {
    let calls = 0
    const fetchMock: typeof fetch = async () => {
      calls += 1
      if (calls > 1) return anthropicStream(...TEXT_STREAM)
      return anthropicStream(
        { type: 'message_start', message: { model: 'claude-opus-5', usage: { input_tokens: 10 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' },
        },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_2', name: 'get_weather' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"city":' },
        },
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"city":"Rome"}' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"Paris"}' },
        },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
        { type: 'message_stop' },
      )
    }

    const result = await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
    }).stream('Weather?')

    const executed = result.steps[0]?.toolCalls ?? []
    expect(executed).toHaveLength(2)
    expect(executed.map((call) => call.input)).toEqual([{ city: 'Paris' }, { city: 'Rome' }])
  })

  it('executes a tool_use block that never receives arguments with an empty input', async () => {
    let calls = 0
    const noArgs = tool({
      name: 'current_status',
      description: 'Status.',
      inputSchema: z.object({}),
      execute: () => 'ok',
    })

    const fetchMock: typeof fetch = async () => {
      calls += 1
      if (calls > 1) return anthropicStream(...TEXT_STREAM)
      return anthropicStream(
        { type: 'message_start', message: { model: 'claude-opus-5', usage: { input_tokens: 10 } } },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'current_status' },
        },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      )
    }

    const result = await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
      tools: [noArgs],
      builtins: false,
    }).stream('Status?')

    expect(result.steps[0]?.toolCalls[0]?.input).toEqual({})
  })

  it('never surfaces thinking_delta frames as text', async () => {
    const fetchMock: typeof fetch = async () =>
      anthropicStream(
        { type: 'message_start', message: { model: 'claude-opus-5', usage: { input_tokens: 5 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'reasoning that must not leak' },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Done.' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      )

    const result = await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
    }).stream('Hi')

    expect(result.output).toBe('Done.')
    expect(result.output).not.toContain('reasoning')
  })

  it('classifies a mid-stream overloaded_error as retryable', async () => {
    const fetchMock: typeof fetch = async () =>
      anthropicStream(
        { type: 'message_start', message: { model: 'claude-opus-5', usage: { input_tokens: 5 } } },
        { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      )

    await expect(
      new Agent({
        name: 'a',
        model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).stream('Hi'),
    ).rejects.toMatchObject({ code: 'provider_error', retryable: true })
  })

  /** The retry canary: a bare TypeError here would be non-retryable. */
  it('maps a mid-stream socket failure to a retryable network error', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
              ),
            )
            controller.error(new TypeError('connection reset'))
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )

    await expect(
      new Agent({
        name: 'a',
        model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).stream('Hi'),
    ).rejects.toMatchObject({ code: 'network_error', retryable: true })
  })

  it('rejects a 200 that is not an event stream at all', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response('<html>gateway error</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })

    await expect(
      new Agent({
        name: 'a',
        model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).stream('Hi'),
    ).rejects.toMatchObject({ code: 'provider_error' })
  })
})

/* ------------------------------------------------------------------------- */
/* Error mapping and configuration                                           */
/* ------------------------------------------------------------------------- */

describe('anthropic error mapping', () => {
  it.each([
    { status: 401, code: 'authentication_error', retryable: false },
    { status: 403, code: 'authentication_error', retryable: false },
    { status: 400, code: 'provider_error', retryable: false },
    { status: 404, code: 'provider_error', retryable: false },
    { status: 429, code: 'rate_limit_error', retryable: true },
    { status: 500, code: 'provider_error', retryable: true },
    // Anthropic's overload status. It is only retryable because `status` is
    // passed to ProviderError — the most common transient failure there is.
    { status: 529, code: 'provider_error', retryable: true },
  ])('maps HTTP $status to $code', async ({ status, code, retryable }) => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse({ type: 'error', error: { type: 'x', message: 'nope' } }, { status })

    await expect(
      new Agent({
        name: 'a',
        model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).run('Hi'),
    ).rejects.toMatchObject({ code, retryable })
  })

  it('reads retry-after into retryAfterMs', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '30' },
      })

    await expect(
      new Agent({
        name: 'a',
        model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).run('Hi'),
    ).rejects.toMatchObject({ retryAfterMs: 30_000 })
  })

  /** A 529 must fall through to the next provider, not fail the run. */
  it('falls over to the fallback chain when Anthropic is overloaded', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse({ error: { type: 'overloaded_error', message: 'Overloaded' } }, { status: 529 })

    const result = await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
      fallbacks: [mockProvider([{ text: 'Served by the fallback.' }])],
      maxRetries: 0,
    }).run('Hi')

    expect(result.output).toBe('Served by the fallback.')
  })

  it('surfaces the vendor error message', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse(
        {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'max_tokens too large' },
        },
        { status: 400 },
      )

    await expect(
      new Agent({
        name: 'a',
        model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).run('Hi'),
    ).rejects.toThrow(/max_tokens too large/)
  })

  it('redacts the key from the error details', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse({ error: { message: 'no' } }, { status: 400 })

    let error: { details?: Record<string, unknown> } | undefined
    try {
      await new Agent({
        name: 'a',
        model: anthropic('claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).run('Hi')
    } catch (cause) {
      error = cause as { details?: Record<string, unknown> }
    }

    const serialized = JSON.stringify(error?.details)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).toContain('[redacted]')
  })
})

describe('anthropic configuration', () => {
  it('names the environment variable when no key is available', () => {
    const saved = process.env['ANTHROPIC_API_KEY']
    delete process.env['ANTHROPIC_API_KEY']
    try {
      expect(() => anthropic('claude-opus-5')).toThrow(/ANTHROPIC_API_KEY/)
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved
    }
  })

  it('sends anthropic-beta when betas are configured', async () => {
    let headers: Record<string, string> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      headers = init?.headers as Record<string, string>
      return jsonResponse(message())
    }

    await new Agent({
      name: 'a',
      model: anthropic('claude-opus-5', {
        apiKey: SECRET,
        fetch: fetchMock,
        betas: ['fine-grained-tool-streaming-2025-05-14'],
      }),
    }).run('Hi')

    expect(headers?.['anthropic-beta']).toBe('fine-grained-tool-streaming-2025-05-14')
  })
})
