import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { Agent, tool } from '../src/index.js'
import { gemini, google } from '../src/providers/index.js'

/**
 * The native Gemini provider, exercised through a real `Agent` with an injected
 * `fetch`.
 */

const SECRET = 'AIzaSyD-super-secret-key-value-1234567890'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function generateContent(overrides: Record<string, unknown> = {}) {
  return {
    modelVersion: 'gemini-2.5-pro',
    candidates: [
      { finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Hello from Gemini.' }] } },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4, totalTokenCount: 16 },
    ...overrides,
  }
}

/** Gemini's `?alt=sse` frames are plain `data:` lines with no event name. */
function sseResponse(...frames: readonly Record<string, unknown>[]): Response {
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

describe('google request translation', () => {
  it('sends the key as a header and never puts it in the URL', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchMock: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} }
      return jsonResponse(generateContent())
    }

    await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
    }).run('Hi')

    expect(captured?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
    )
    // The one design choice in this provider that could leak a credential.
    expect(captured?.url).not.toContain(SECRET)

    const headers = captured?.init.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe(SECRET)
  })

  it('does not double the models/ prefix when the id already carries one', async () => {
    let url: string | undefined
    const fetchMock: typeof fetch = async (target) => {
      url = String(target)
      return jsonResponse(generateContent())
    }

    await new Agent({
      name: 'a',
      model: google('models/gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
    }).run('Hi')

    expect(url).toContain('/models/gemini-2.5-pro:generateContent')
    expect(url).not.toContain('models/models')
  })

  /** Without `?alt=sse` the endpoint returns a JSON array and the framer sees nothing. */
  it('requests SSE explicitly when streaming', async () => {
    let url: string | undefined
    const fetchMock: typeof fetch = async (target) => {
      url = String(target)
      return sseResponse(generateContent())
    }

    await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
    }).stream('Hi')

    expect(url).toContain(':streamGenerateContent?alt=sse')
  })

  it('hoists the system prompt to systemInstruction and uses the user role', async () => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(generateContent())
    }

    await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
      instructions: 'Be brief.',
    }).run('Hi')

    expect(body?.['systemInstruction']).toEqual({ parts: [{ text: 'Be brief.' }] })
    expect(body?.['contents']).toEqual([{ role: 'user', parts: [{ text: 'Hi' }] }])
  })

  it('wraps every declaration in a single tools entry and sanitizes the schema', async () => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(generateContent())
    }

    await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
    }).run('Hi')

    const tools = body?.['tools'] as { functionDeclarations: Record<string, unknown>[] }[]
    // One wrapper object, not one per tool.
    expect(tools).toHaveLength(1)
    expect(tools[0]?.functionDeclarations).toHaveLength(1)

    const parameters = tools[0]?.functionDeclarations[0]?.['parameters'] as Record<string, unknown>
    // The sanitizer ran: Zod emits both of these, and Gemini rejects both.
    expect(parameters).not.toHaveProperty('$schema')
    expect(parameters).not.toHaveProperty('additionalProperties')
    expect(parameters['type']).toBe('object')
  })

  it.each([
    ['auto', undefined],
    ['required', { functionCallingConfig: { mode: 'ANY' } }],
    ['none', { functionCallingConfig: { mode: 'NONE' } }],
  ] as const)('maps toolChoice %s', async (choice, expected) => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(generateContent())
    }

    await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
      toolChoice: choice,
    }).run('Hi')

    expect(body?.['toolConfig']).toEqual(expected)
  })

  it('maps a named toolChoice to ANY plus allowedFunctionNames', async () => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(
        generateContent({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }],
              },
            },
          ],
        }),
      )
    }

    await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
      toolChoice: { type: 'tool', name: 'get_weather' },
      maxTurns: 1,
    })
      .run('Hi')
      .catch(() => undefined)

    expect(body?.['toolConfig']).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    })
  })

  it('serializes a tool call as functionCall and its results as one user turn', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse(
        bodies.length === 1
          ? generateContent({
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    role: 'model',
                    parts: [
                      { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
                      { functionCall: { name: 'get_weather', args: { city: 'Rome' } } },
                    ],
                  },
                },
              ],
            })
          : generateContent(),
      )
    }

    await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
    }).run('Weather in Paris and Rome?')

    const contents = bodies[1]?.['contents'] as { role: string; parts: Record<string, unknown>[] }[]

    // The assistant turn is `model`, and args are objects.
    expect(contents[1]?.role).toBe('model')
    expect(contents[1]?.parts[0]).toEqual({
      functionCall: { name: 'get_weather', args: { city: 'Paris' } },
    })

    // Both results in ONE user turn — Gemini has no tool role.
    expect(contents).toHaveLength(3)
    expect(contents[2]?.role).toBe('user')
    expect(contents[2]?.parts).toHaveLength(2)
    // `response` must be a JSON object, so output is always wrapped.
    expect(contents[2]?.parts[0]).toMatchObject({
      functionResponse: { name: 'get_weather', response: { result: { city: 'Paris', tempC: 18 } } },
    })
  })

  it('passes generation settings through generationConfig', async () => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(generateContent())
    }

    await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
      maxOutputTokens: 512,
      temperature: 0.2,
    }).run('Hi')

    expect(body?.['generationConfig']).toMatchObject({
      maxOutputTokens: 512,
      temperature: 0.2,
    })
  })

  it('never forwards metadata, which Gemini has no field for', async () => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(generateContent())
    }

    await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
      metadata: { userId: 'u1' },
    }).run('Hi')

    expect(JSON.stringify(body)).not.toContain('u1')
  })

  it('shallow-merges defaultBody.generationConfig rather than replacing it', async () => {
    let body: Record<string, unknown> | undefined
    const fetchMock: typeof fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return jsonResponse(generateContent())
    }

    await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', {
        apiKey: SECRET,
        fetch: fetchMock,
        defaultBody: {
          safetySettings: [{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' }],
          generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
        },
      }),
      maxOutputTokens: 512,
    }).run('Hi')

    expect(body?.['safetySettings']).toHaveLength(1)
    expect(body?.['generationConfig']).toEqual({
      maxOutputTokens: 512,
      thinkingConfig: { thinkingBudget: 0 },
    })
  })

  /**
   * Gemini does not reliably support `responseSchema` alongside
   * `functionDeclarations` — it 400s or silently stops calling functions. An
   * agent with tools *and* an `outputSchema` is an ordinary configuration here,
   * so this asserts an absence.
   */
  it('emits responseSchema only when the agent has no tools', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse(
        generateContent({
          candidates: [
            {
              finishReason: 'STOP',
              content: { role: 'model', parts: [{ text: '{"answer":"yes"}' }] },
            },
          ],
        }),
      )
    }

    const outputSchema = z.object({ answer: z.string() })

    await new Agent({
      name: 'no-tools',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
      builtins: false,
      outputSchema,
    }).run('Hi')

    await new Agent({
      name: 'with-tools',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
      outputSchema,
    }).run('Hi')

    const first = bodies[0]?.['generationConfig'] as Record<string, unknown>
    expect(first['responseMimeType']).toBe('application/json')
    expect(first['responseSchema']).toMatchObject({ type: 'object' })
    // Sanitized on the way out, like every other schema.
    expect(JSON.stringify(first['responseSchema'])).not.toContain('additionalProperties')

    const second = (bodies[1]?.['generationConfig'] ?? {}) as Record<string, unknown>
    expect(second).not.toHaveProperty('responseSchema')
    expect(second).not.toHaveProperty('responseMimeType')
  })
})

/* ------------------------------------------------------------------------- */
/* Response translation                                                      */
/* ------------------------------------------------------------------------- */

describe('google response translation', () => {
  /**
   * `thoughtsTokenCount` is billed as output but excluded from
   * `candidatesTokenCount`, so it has to be folded in — the mirror image of the
   * Anthropic cache mistake, and just as easy to get backwards.
   */
  it('folds thinking tokens into outputTokens and reports them separately', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse(
        generateContent({
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            totalTokenCount: 150,
            cachedContentTokenCount: 80,
            thoughtsTokenCount: 30,
          },
        }),
      )

    const result = await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
    }).run('Hi')

    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedInputTokens: 80,
      reasoningTokens: 30,
    })
  })

  /** Gemini sends no call id, so two calls to the same function must not collide. */
  it('synthesizes distinct, stable ids for parallel calls to one function', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse(
        bodies.length === 1
          ? generateContent({
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    role: 'model',
                    parts: [
                      { functionCall: { name: 'get_weather', args: { city: 'Paris' } } },
                      { functionCall: { name: 'get_weather', args: { city: 'Rome' } } },
                    ],
                  },
                },
              ],
            })
          : generateContent(),
      )
    }

    const result = await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
    }).run('Weather?')

    const ids = result.steps[0]?.toolCalls.map((call) => call.toolCallId)
    expect(ids).toEqual(['get_weather_0', 'get_weather_1'])
  })

  it('prefers a vendor-supplied id when one is present', async () => {
    let calls = 0
    const fetchMock: typeof fetch = async () => {
      calls += 1
      return jsonResponse(
        calls === 1
          ? generateContent({
              candidates: [
                {
                  finishReason: 'STOP',
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: {
                          id: 'fc_real',
                          name: 'get_weather',
                          args: { city: 'Paris' },
                        },
                      },
                    ],
                  },
                },
              ],
            })
          : generateContent(),
      )
    }

    const result = await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
    }).run('Weather?')

    expect(result.steps[0]?.toolCalls[0]?.toolCallId).toBe('fc_real')
  })

  it('excludes thought parts from the answer', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse(
        generateContent({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                role: 'model',
                parts: [
                  { text: 'internal reasoning that must not leak', thought: true },
                  { text: 'The answer is 4.' },
                ],
              },
            },
          ],
        }),
      )

    const result = await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
    }).run('2+2?')

    expect(result.output).toBe('The answer is 4.')
  })

  /** No candidates at all — indexing `candidates[0]` here would be a TypeError. */
  it('reports a blocked prompt as a named provider error', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } })

    await expect(
      new Agent({
        name: 'a',
        model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).run('Hi'),
    ).rejects.toMatchObject({ code: 'provider_error', retryable: false })
  })

  it.each([
    ['MAX_TOKENS', 'length'],
    ['SAFETY', 'content_filter'],
    ['RECITATION', 'content_filter'],
    ['MALFORMED_FUNCTION_CALL', 'other'],
    ['STOP', 'stop'],
  ])('maps finishReason %s', async (reason, expected) => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse(
        generateContent({
          candidates: [
            { finishReason: reason, content: { role: 'model', parts: [{ text: 'ok' }] } },
          ],
        }),
      )

    const result = await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
    }).run('Hi')

    expect(result.steps[0]?.finishReason).toBe(expected)
  })

  it('reports modelVersion as the serving model', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse(generateContent({ modelVersion: 'gemini-2.5-pro-002' }))

    const result = await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
    }).run('Hi')

    expect(result.steps[0]?.modelId).toBe('gemini-2.5-pro-002')
  })
})

/* ------------------------------------------------------------------------- */
/* Streaming                                                                 */
/* ------------------------------------------------------------------------- */

describe('google streaming', () => {
  it('concatenates text across frames and takes usage from the last', async () => {
    const fetchMock: typeof fetch = async () =>
      sseResponse(
        {
          candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
        },
        {
          candidates: [
            { finishReason: 'STOP', content: { role: 'model', parts: [{ text: ' there' }] } },
          ],
          modelVersion: 'gemini-2.5-pro',
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 7, totalTokenCount: 17 },
        },
      )

    const result = await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
    }).stream('Hi')

    expect(result.output).toBe('Hello there')
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 7, totalTokens: 17 })
  })

  /**
   * Gemini never fragments argument JSON — a call arrives whole — so it is
   * emitted as one delta whose payload parses on its own.
   */
  it('executes a function call that arrives in a single frame', async () => {
    let calls = 0
    const fetchMock: typeof fetch = async () => {
      calls += 1
      if (calls > 1) {
        return sseResponse({
          candidates: [
            { finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Done.' }] } },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
        })
      }
      return sseResponse({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      })
    }

    const result = await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
      builtins: false,
    }).stream('Weather?')

    const executed = result.steps[0]?.toolCalls ?? []
    expect(executed).toHaveLength(1)
    expect(executed[0]?.input).toEqual({ city: 'Paris' })
    // The id agrees with the non-streamed path.
    expect(executed[0]?.toolCallId).toBe('get_weather_0')
  })

  it('maps a mid-stream socket failure to a retryable network error', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n',
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
        model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).stream('Hi'),
    ).rejects.toMatchObject({ code: 'network_error', retryable: true })
  })

  it('rejects a 200 that is not an event stream', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response('<html>gateway error</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })

    await expect(
      new Agent({
        name: 'a',
        model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).stream('Hi'),
    ).rejects.toMatchObject({ code: 'provider_error' })
  })
})

/* ------------------------------------------------------------------------- */
/* Error mapping and configuration                                           */
/* ------------------------------------------------------------------------- */

describe('google error mapping', () => {
  /** Gemini returns 400 for a bad key, not 401 — the most confusing first failure. */
  it('classifies a 400 API_KEY_INVALID as an authentication error', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
            details: [
              { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' },
            ],
          },
        },
        { status: 400 },
      )

    await expect(
      new Agent({
        name: 'a',
        model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).run('Hi'),
    ).rejects.toMatchObject({ code: 'authentication_error', retryable: false })
  })

  it('reads retryDelay out of RetryInfo on a 429', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: 429,
            message: 'Resource has been exhausted.',
            status: 'RESOURCE_EXHAUSTED',
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '27s' }],
          },
        },
        { status: 429 },
      )

    await expect(
      new Agent({
        name: 'a',
        model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).run('Hi'),
    ).rejects.toMatchObject({ code: 'rate_limit_error', retryable: true, retryAfterMs: 27_000 })
  })

  it.each([
    { status: 403, code: 'authentication_error', retryable: false },
    { status: 404, code: 'provider_error', retryable: false },
    { status: 429, code: 'rate_limit_error', retryable: true },
    { status: 500, code: 'provider_error', retryable: true },
    { status: 503, code: 'provider_error', retryable: true },
  ])('maps HTTP $status to $code', async ({ status, code, retryable }) => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse({ error: { code: status, message: 'nope', status: 'X' } }, { status })

    await expect(
      new Agent({
        name: 'a',
        model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).run('Hi'),
    ).rejects.toMatchObject({ code, retryable })
  })

  it('hints at the schema sanitizer when a 400 mentions a schema', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse(
        {
          error: {
            code: 400,
            message: 'Invalid JSON payload received. Unknown name "additionalProperties".',
          },
        },
        { status: 400 },
      )

    await expect(
      new Agent({
        name: 'a',
        model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
        maxRetries: 0,
      }).run('Hi'),
    ).rejects.toThrow(/google-schema\.ts/)
  })

  it('redacts the key from the error details', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse({ error: { message: 'no' } }, { status: 500 })

    let error: { details?: Record<string, unknown> } | undefined
    try {
      await new Agent({
        name: 'a',
        model: google('gemini-2.5-pro', { apiKey: SECRET, fetch: fetchMock }),
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

describe('google configuration', () => {
  it('falls back from GEMINI_API_KEY to GOOGLE_API_KEY', () => {
    const savedGemini = process.env['GEMINI_API_KEY']
    const savedGoogle = process.env['GOOGLE_API_KEY']
    delete process.env['GEMINI_API_KEY']
    delete process.env['GOOGLE_API_KEY']

    try {
      expect(() => google('gemini-2.5-pro')).toThrow(/GEMINI_API_KEY/)

      process.env['GOOGLE_API_KEY'] = SECRET
      expect(() => google('gemini-2.5-pro')).not.toThrow()
    } finally {
      delete process.env['GOOGLE_API_KEY']
      if (savedGemini !== undefined) process.env['GEMINI_API_KEY'] = savedGemini
      if (savedGoogle !== undefined) process.env['GOOGLE_API_KEY'] = savedGoogle
    }
  })

  it('normalizes a trailing slash on baseUrl', async () => {
    let url: string | undefined
    const fetchMock: typeof fetch = async (target) => {
      url = String(target)
      return jsonResponse(generateContent())
    }

    await new Agent({
      name: 'a',
      model: google('gemini-2.5-pro', {
        apiKey: SECRET,
        fetch: fetchMock,
        baseUrl: 'https://proxy.internal/v1beta/',
      }),
    }).run('Hi')

    expect(url).toBe('https://proxy.internal/v1beta/models/gemini-2.5-pro:generateContent')
  })

  it('exports gemini as an alias of google', () => {
    expect(gemini).toBe(google)
  })
})
