import { describe, expect, it } from 'vitest'

import { Agent, consoleTracer, redact, redactHeaders, redactString, tool } from '../src/index.js'
import { openrouter } from '../src/providers/index.js'
import { collectEvents } from '../src/testing/index.js'

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
})
