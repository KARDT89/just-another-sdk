import { describe, expect, it } from 'vitest'

import * as z from 'zod'

import {
  Agent,
  consoleTracer,
  type InvalidOutputError,
  redact,
  redactHeaders,
  redactString,
  tool,
} from '../src/index.js'
import { anthropic, google, openrouter } from '../src/providers/index.js'
import { collectEvents, mockProvider } from '../src/testing/index.js'

/**
 * The SDK makes a specific promise: an API key never appears in a thrown error,
 * an emitted event, or a printed trace. These tests are that promise, enforced.
 *
 * They matter because the failure mode is silent and severe — a key pasted into a
 * CI log or an error-tracking service is a key that has to be rotated.
 */

const SECRET = 'sk-or-v1-abcdef0123456789abcdef0123456789'

describe('redactString', () => {
  it.each([
    ['OpenAI / OpenRouter', 'sk-or-v1-abcdef0123456789abcdef'],
    ['Anthropic', 'sk-ant-api03-abcdef0123456789'],
    ['Google', 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ12345'],
    ['GitHub', 'ghp_abcdefghijklmnopqrstuvwxyz0123'],
    ['Slack', 'xoxb-1234567890-abcdefghijkl'],
  ])('redacts a %s key found in free text', (_label, key) => {
    const redacted = redactString(`Request failed with key ${key} attached`)
    expect(redacted).not.toContain(key)
    expect(redacted).toContain('[redacted]')
  })

  it('redacts a bearer token', () => {
    expect(redactString(`Authorization: Bearer ${SECRET}`)).not.toContain(SECRET)
  })

  it('leaves innocuous text untouched', () => {
    expect(redactString('The weather in Paris is 18°C.')).toBe('The weather in Paris is 18°C.')
  })
})

describe('redactHeaders', () => {
  it('masks authorization and api-key headers', () => {
    const redacted = redactHeaders({
      authorization: `Bearer ${SECRET}`,
      'x-api-key': SECRET,
      'content-type': 'application/json',
    })

    expect(redacted['authorization']).toBe('[redacted]')
    expect(redacted['x-api-key']).toBe('[redacted]')
    expect(redacted['content-type']).toBe('application/json')
  })

  it('accepts a Headers instance', () => {
    const redacted = redactHeaders(new Headers({ authorization: `Bearer ${SECRET}` }))
    expect(JSON.stringify(redacted)).not.toContain(SECRET)
  })
})

describe('redact', () => {
  it('masks sensitive keys at any depth', () => {
    const redacted = redact({
      config: { apiKey: SECRET, nested: { access_token: SECRET, model: 'gpt-5' } },
    })
    expect(JSON.stringify(redacted)).not.toContain(SECRET)
    expect(JSON.stringify(redacted)).toContain('gpt-5')
  })

  it('survives a circular reference', () => {
    const circular: Record<string, unknown> = { name: 'root' }
    circular['self'] = circular

    expect(() => redact(circular)).not.toThrow()
    expect(JSON.stringify(redact(circular))).toContain('[circular]')
  })

  it('caps traversal depth rather than recursing without bound', () => {
    let deep: Record<string, unknown> = { value: 'bottom' }
    for (let i = 0; i < 50; i += 1) deep = { nested: deep }

    expect(JSON.stringify(redact(deep))).toContain('[truncated]')
  })
})

describe('end-to-end guarantees', () => {
  it('keeps the key out of a provider error, including its details and cause chain', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'invalid api key' } }), { status: 401 })

    const agent = new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
    })

    const error = await agent.run('go').catch((caught: unknown) => caught)

    // Everything a developer or an error tracker might read.
    const surfaces = [
      String(error),
      (error as Error).message,
      (error as Error).stack ?? '',
      JSON.stringify((error as { toJSON: () => unknown }).toJSON()),
      JSON.stringify((error as { details?: unknown }).details ?? {}),
    ]

    for (const surface of surfaces) {
      expect(surface).not.toContain(SECRET)
    }
    // The failure is still diagnosable.
    expect((error as Error).message).toContain('invalid api key')
  })

  /**
   * The same promise, for the two vendors that authenticate with their own
   * header rather than `Authorization: Bearer`. Gemini is the sharper case: its
   * key would be trivial to put in the query string, where it would land in
   * every error message and proxy log — so this also asserts the URL is clean.
   */
  it.each([
    {
      vendor: 'anthropic',
      key: 'sk-ant-api03-abcdef0123456789abcdef0123456789',
      build: (key: string, fetchMock: typeof fetch) =>
        anthropic('claude-opus-5', { apiKey: key, fetch: fetchMock }),
    },
    {
      vendor: 'google',
      key: 'AIzaSyD-abcdef0123456789abcdef0123456789',
      build: (key: string, fetchMock: typeof fetch) =>
        google('gemini-2.5-pro', { apiKey: key, fetch: fetchMock }),
    },
  ])('keeps a $vendor key out of the error and out of the URL', async ({ key, build }) => {
    let requestedUrl = ''
    const fetchMock: typeof fetch = async (url) => {
      requestedUrl = String(url)
      return new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
        status: 401,
      })
    }

    const error = await new Agent({ name: 'a', model: build(key, fetchMock), maxRetries: 0 })
      .run('go')
      .catch((caught: unknown) => caught)

    const surfaces = [
      requestedUrl,
      String(error),
      (error as Error).message,
      (error as Error).stack ?? '',
      JSON.stringify((error as { toJSON: () => unknown }).toJSON()),
      JSON.stringify((error as { details?: unknown }).details ?? {}),
    ]

    for (const surface of surfaces) {
      expect(surface).not.toContain(key)
    }
    expect((error as Error).message).toContain('invalid api key')
  })

  it('keeps the key out of every emitted event', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )

    const collected = collectEvents()
    await new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
    }).run('go', { onEvent: collected.listener })

    expect(JSON.stringify(collected.events)).not.toContain(SECRET)
  })

  /**
   * A retried call carries its error into a `model.retry` event, which a tracer
   * or a log pipeline will happily serialize. The redaction that protects a
   * thrown error has to protect the survivable one too.
   */
  it('keeps the key out of a retry event and the trace line it produces', async () => {
    let attempt = 0
    const fetchMock: typeof fetch = async () => {
      attempt += 1
      if (attempt === 1) {
        return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
          status: 429,
          headers: { 'retry-after': '0' },
        })
      }
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }

    const lines: string[] = []
    const collected = collectEvents()

    const result = await new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
      retryDelayMs: 1,
    }).run('go', {
      onEvent: (event) => {
        collected.listener(event)
        consoleTracer({ color: false, write: (line) => lines.push(line) })(event)
      },
    })

    expect(result.text).toBe('ok')
    expect(collected.events.some((event) => event.type === 'model.retry')).toBe(true)

    // The event payload, everything the tracer printed, and the error inside it.
    expect(JSON.stringify(collected.events)).not.toContain(SECRET)
    expect(lines.join('\n')).not.toContain(SECRET)
    expect(lines.join('\n')).toContain('rate_limit_error')
  })

  it('redacts a credential that a tool returns, before the tracer prints it', async () => {
    const lines: string[] = []
    const leaky = tool({
      name: 'leaky',
      description: 'Returns a credential it should not.',
      execute: () => ({ apiKey: SECRET, status: 'ok' }),
    })

    let call = 0
    const fetchMock: typeof fetch = async () => {
      call += 1
      const body =
        call === 1
          ? {
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: null,
                    tool_calls: [
                      { id: 'c1', type: 'function', function: { name: 'leaky', arguments: '{}' } },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }
          : {
              choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    await new Agent({
      name: 'a',
      model: openrouter('m', { apiKey: SECRET, fetch: fetchMock }),
      tools: [leaky],
    }).run('go', {
      onEvent: consoleTracer({ color: false, write: (line) => lines.push(line) }),
    })

    const printed = lines.join('\n')
    expect(printed).not.toContain(SECRET)
    expect(printed).toContain('[redacted]')
  })

  /**
   * A model that fails `outputSchema` can be echoing back anything the user
   * pasted in, including a credential. That text has to reach the developer
   * debugging the failure and nothing else — which is why it lives on the error
   * instance rather than in `details`, the log-safe form the tracer and the SSE
   * serializer both read.
   *
   * `model.response.text` is a separate matter and deliberately untouched: it
   * has always carried the model's answer verbatim, the tracer only prints it
   * under `verbose`, and `redact()` catches key-shaped substrings on the way out
   * to a browser. The assertion below is about what *this* feature added.
   */
  it('keeps invalid model output out of the failure it reports', async () => {
    const lines: string[] = []
    const collected = collectEvents()
    const model = mockProvider([{ text: `{"answer": "${SECRET}"}` }])

    const agent = new Agent({
      name: 'a',
      model,
      outputSchema: z.object({ answer: z.number() }),
      maxOutputRetries: 0,
    })

    const error = (await agent
      .run('go', {
        onEvent: (event) => {
          collected.listener(event)
          consoleTracer({ color: false, write: (line) => lines.push(line) })(event)
        },
      })
      .catch((caught: unknown) => caught)) as InvalidOutputError

    const invalid = collected.ofType('output.invalid')
    expect(invalid).toHaveLength(1)
    expect(JSON.stringify(invalid)).not.toContain(SECRET)

    // The error's log-safe form, and everything the tracer printed.
    expect(JSON.stringify(error.toJSON())).not.toContain(SECRET)
    expect(error.message).not.toContain(SECRET)
    expect(lines.join('\n')).not.toContain(SECRET)
    expect(lines.join('\n')).toContain('output invalid')

    // The developer holding the error can still see what the model actually said.
    expect(error.rawText).toContain(SECRET)

    // And redaction still covers the one event that does carry model text, which
    // is what the SSE serializer applies before anything reaches a browser.
    expect(JSON.stringify(redact(collected.events))).not.toContain(SECRET)
  })
})
