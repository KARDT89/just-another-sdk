import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { Agent, tool } from '../src/index.js'
import { compatible, openrouter } from '../src/providers/index.js'

/**
 * Provider tests use an injected `fetch`, so they exercise the real translation
 * and error-mapping code without a network call or an API key.
 */

const SECRET = 'sk-or-v1-super-secret-key-value-1234567890'

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function completion(overrides: Record<string, unknown> = {}) {
  return {
    model: 'anthropic/claude-opus-5',
    choices: [{ finish_reason: 'stop', message: { content: 'Hello from the model.' } }],
    usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
    ...overrides,
  }
}

describe('request translation', () => {
  it('builds an OpenAI-shaped body with system, tools, and messages', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const fetchMock: typeof fetch = async (url, init) => {
      captured = { url: String(url), init: init ?? {} }
      return jsonResponse(completion())
    }

    const model = openrouter('anthropic/claude-opus-5', { apiKey: SECRET, fetch: fetchMock })
    const weather = tool({
      name: 'get_weather',
      description: 'Get weather.',
      inputSchema: z.object({ city: z.string() }),
      execute: () => 'ok',
    })

    await new Agent({
      name: 'a',
      model,
      instructions: 'Be brief.',
      tools: [weather],
      maxOutputTokens: 512,
      temperature: 0.2,
    }).run('Hi')

    expect(captured?.url).toBe('https://openrouter.ai/api/v1/chat/completions')

    const body = JSON.parse(String(captured?.init.body)) as Record<string, unknown>
    expect(body['model']).toBe('anthropic/claude-opus-5')
    expect(body['max_tokens']).toBe(512)
    expect(body['temperature']).toBe(0.2)
    expect(body['messages']).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hi' },
    ])
    expect(body['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather.',
          parameters: expect.objectContaining({ type: 'object' }),
        },
      },
    ])
  })

  it('serializes an assistant tool call and its result in the wire format', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse(
        bodies.length === 1
          ? completion({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'call_abc',
                        type: 'function',
                        function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
                      },
                    ],
                  },
                },
              ],
            })
          : completion(),
      )
    }

    const weather = tool({
      name: 'get_weather',
      description: 'Get weather.',
      inputSchema: z.object({ city: z.string() }),
      execute: ({ city }) => ({ city, tempC: 18 }),
    })

    await new Agent({
      name: 'a',
      model: openrouter('anthropic/claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
      tools: [weather],
    }).run('Weather in Paris?')

    const second = bodies[1]?.['messages'] as Record<string, unknown>[]

    expect(second[1]).toEqual({
      role: 'assistant',
      // `null`, not `''` — some vendors reject an empty string alongside tool calls.
      content: null,
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        },
      ],
    })
    expect(second[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_abc',
      content: '{"city":"Paris","tempC":18}',
    })
  })
})

describe('response translation', () => {
  it('maps text, usage, and the serving model id', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse(
        completion({
          model: 'anthropic/claude-opus-5-actual',
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            prompt_tokens_details: { cached_tokens: 80 },
          },
        }),
      )

    const result = await new Agent({
      name: 'a',
      model: openrouter('anthropic/claude-opus-5', { apiKey: SECRET, fetch: fetchMock }),
    }).run('Hi')

    expect(result.text).toBe('Hello from the model.')
    expect(result.modelId).toBe('anthropic/claude-opus-5-actual')
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 80,
    })
  })

  it("treats tool calls as tool_calls even when the vendor reports finish_reason 'stop'", async () => {
    let calls = 0
    const fetchMock: typeof fetch = async () => {
      calls += 1
      return jsonResponse(
        calls === 1
          ? completion({
              choices: [
                {
                  // Deliberately inconsistent: several gateways do exactly this.
                  finish_reason: 'stop',
                  message: {
                    content: null,
                    tool_calls: [
                      {
                        id: 'c1',
                        type: 'function',
                        function: { name: 'ping', arguments: '{}' },
                      },
                    ],
                  },
                },
              ],
            })
          : completion({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] }),
      )
    }

    const ping = tool({ name: 'ping', description: 'Ping.', execute: () => 'pong' })
    const result = await new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
      tools: [ping],
    }).run('go')

    // The loop continued rather than ending on the misleading flag.
    expect(calls).toBe(2)
    expect(result.text).toBe('done')
  })

  it('surfaces a 200-with-error-body as a provider error', async () => {
    const fetchMock: typeof fetch = async () =>
      jsonResponse({ error: { message: 'no credits remaining', code: 'insufficient_quota' } })

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
    })

    await expect(agent.run('go')).rejects.toMatchObject({
      code: 'provider_error',
      message: expect.stringContaining('no credits remaining'),
    })
  })
})

describe('error mapping', () => {
  const cases = [
    { status: 401, code: 'authentication_error', retryable: false },
    { status: 403, code: 'authentication_error', retryable: false },
    { status: 429, code: 'rate_limit_error', retryable: true },
    { status: 500, code: 'provider_error', retryable: true },
    { status: 400, code: 'provider_error', retryable: false },
  ] as const

  for (const { status, code, retryable } of cases) {
    it(`maps HTTP ${status} to ${code} (retryable: ${retryable})`, async () => {
      const fetchMock: typeof fetch = async () =>
        jsonResponse({ error: { message: 'nope' } }, { status })

      const agent = new Agent({
        name: 'a',
        model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
      })

      await expect(agent.run('go')).rejects.toMatchObject({ code, retryable })
    })
  }

  it('parses retry-after into milliseconds on a 429', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response('{}', { status: 429, headers: { 'retry-after': '30' } })

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
    })

    await expect(agent.run('go')).rejects.toMatchObject({ retryAfterMs: 30_000 })
  })

  it('maps a transport failure to a retryable network error', async () => {
    const fetchMock: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
    })

    await expect(agent.run('go')).rejects.toMatchObject({
      code: 'network_error',
      retryable: true,
    })
  })

  /**
   * Regression: a whole-run `timeoutMs` used to surface as `network_error`.
   *
   * The runner aborts its signal with a `TimeoutError` as the reason, and real
   * `fetch` rejects with that reason object rather than a generic `AbortError`.
   * Because its `name` is `'TimeoutError'`, the abort-shape check missed it and
   * the caller was told to check their network connection.
   *
   * This `fetch` double reproduces the real semantics — reject with
   * `signal.reason` — which is what makes the test meaningful.
   */
  it('reports a run-level timeout as timeout_error, not network_error', async () => {
    const fetchMock: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return
        signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
      })

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
    })

    await expect(agent.run('go', { timeoutMs: 50 })).rejects.toMatchObject({
      code: 'timeout_error',
    })
  })

  it('reports caller cancellation as aborted, not network_error', async () => {
    const fetchMock: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) return
        signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true })
      })

    const controller = new AbortController()
    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
    })

    const promise = agent.run('go', { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)

    await expect(promise).rejects.toMatchObject({ code: 'aborted' })
  })
})

describe('configuration', () => {
  it('fails with an actionable message when no API key is available', () => {
    const previous = process.env['OPENROUTER_API_KEY']
    delete process.env['OPENROUTER_API_KEY']
    try {
      expect(() => openrouter('m')).toThrow(/OPENROUTER_API_KEY/)
    } finally {
      if (previous !== undefined) process.env['OPENROUTER_API_KEY'] = previous
    }
  })

  it('sends OpenRouter attribution headers when configured', async () => {
    let headers: Record<string, string> = {}
    const fetchMock: typeof fetch = async (_url, init) => {
      headers = init?.headers as Record<string, string>
      return jsonResponse(completion())
    }

    await new Agent({
      name: 'a',
      model: openrouter('m', {
        apiKey: SECRET,
        fetch: fetchMock,
        referer: 'https://example.com',
        title: 'My App',
      }),
    }).run('go')

    expect(headers['http-referer']).toBe('https://example.com')
    expect(headers['x-title']).toBe('My App')
    expect(headers['authorization']).toBe(`Bearer ${SECRET}`)
  })

  it('points the compatible() helper at any OpenAI-shaped endpoint', async () => {
    let url = ''
    const fetchMock: typeof fetch = async (requestUrl) => {
      url = String(requestUrl)
      return jsonResponse(completion())
    }

    const local = compatible('llama3.1', {
      baseUrl: 'http://localhost:11434/v1/',
      fetch: fetchMock,
      providerId: 'ollama',
    })

    expect(local.providerId).toBe('ollama')
    await new Agent({ name: 'a', model: local }).run('go')
    // The trailing slash on baseUrl must not produce a double slash.
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
  })
})
