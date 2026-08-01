import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { Agent, isAgentError, tool } from '../src/index.js'
import { openrouter } from '../src/providers/index.js'
import { collectEvents } from '../src/testing/index.js'

/**
 * Live integration tests — the only tests in this repo that touch the network.
 *
 * They exist because a mock provider can prove the *loop* is correct but not that
 * the wire format is: request translation, SSE-less response parsing, tool-call
 * round-tripping, and provider error mapping are all only really verified against
 * a real model.
 *
 * The whole suite is skipped unless an OpenRouter key is available, so CI stays
 * fast, offline, and deterministic. To run them:
 *
 *   echo "OPENROUTER_API_KEY=sk-or-v1-..." > examples/.env
 *   pnpm --filter just-another-sdk test
 *
 * Cost is a fraction of a cent — every call uses the cheapest tool-capable model
 * and a tight `maxOutputTokens`.
 */

/** Reads the key from the environment, falling back to `examples/.env`. */
function readApiKey(): string | undefined {
  const fromEnv = process.env['OPENROUTER_API_KEY']
  if (fromEnv) return fromEnv

  try {
    const envFile = readFileSync(new URL('../../../examples/.env', import.meta.url), 'utf8')
    return /^OPENROUTER_API_KEY\s*=\s*(.+)$/m.exec(envFile)?.[1]?.trim()
  } catch {
    return undefined
  }
}

const apiKey = readApiKey()

/** Cheapest model on OpenRouter that still supports tool calling. */
const MODEL = process.env['OPENROUTER_MODEL'] ?? 'openai/gpt-4o-mini'

/** Real calls are slow and occasionally slower. */
const TIMEOUT = 60_000

const model = () => openrouter(MODEL, { apiKey: apiKey ?? '' })

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city. Call this for any weather question.',
  inputSchema: z.object({ city: z.string().describe('City name') }),
  execute: ({ city }) => ({ city, tempC: 18, summary: 'clear' }),
})

const getTime = tool({
  name: 'get_time',
  description: 'Get the current local time in a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, localTime: '14:32', timezone: 'Europe/Paris' }),
})

describe.skipIf(!apiKey)(`live · ${MODEL}`, () => {
  describe('the basics', () => {
    it(
      'completes a plain request and reports real usage',
      async () => {
        const agent = new Agent({
          name: 'live-basic',
          instructions: 'Answer in one short sentence.',
          model: model(),
          maxOutputTokens: 64,
        })

        const result = await agent.run('What is the capital of France?')

        expect(result.text.toLowerCase()).toContain('paris')
        expect(result.stopReason).toBe('finish')
        expect(result.turns).toBe(1)

        // Usage must be real, not the mock provider's defaults.
        expect(result.usage.inputTokens).toBeGreaterThan(0)
        expect(result.usage.outputTokens).toBeGreaterThan(0)
        expect(result.usage.totalTokens).toBeGreaterThan(0)
        expect(result.modelId).toContain('gpt-4o-mini')
        expect(result.durationMs).toBeGreaterThan(0)
      },
      TIMEOUT,
    )

    it(
      'sends instructions as a system prompt the model actually obeys',
      async () => {
        const agent = new Agent({
          name: 'live-instructions',
          instructions: 'You always reply with exactly the single word: ACKNOWLEDGED',
          model: model(),
          maxOutputTokens: 16,
        })

        const result = await agent.run('Hello there.')
        expect(result.text.toUpperCase()).toContain('ACKNOWLEDGED')
      },
      TIMEOUT,
    )
  })

  describe('tool calling', () => {
    it(
      'round-trips a tool call and grounds the answer in its result',
      async () => {
        const collected = collectEvents()
        const agent = new Agent({
          name: 'live-tools',
          instructions: 'Use your tools rather than guessing. Be brief.',
          model: model(),
          tools: [getWeather],
          maxOutputTokens: 128,
        })

        const result = await agent.run('What is the weather in Paris?', {
          onEvent: collected.listener,
        })

        expect(result.stopReason).toBe('finish')
        expect(result.turns).toBe(2) // one call to decide, one to answer

        // The model chose the tool and passed a validated argument.
        const call = collected.first('tool.start')
        expect(call?.toolName).toBe('get_weather')
        expect(call?.input).toMatchObject({ city: expect.stringContaining('Paris') })

        // The tool's value reached the answer.
        expect(result.text).toMatch(/18/)
        expect(collected.first('tool.end')?.isError).toBe(false)
      },
      TIMEOUT,
    )

    it(
      'requests several tools in one turn and runs them concurrently',
      async () => {
        const collected = collectEvents()
        const agent = new Agent({
          name: 'live-parallel',
          instructions: 'Use your tools. Answer in one sentence.',
          model: model(),
          tools: [getWeather, getTime],
          maxOutputTokens: 128,
        })

        const result = await agent.run('What is the weather AND the local time in Paris?', {
          onEvent: collected.listener,
        })

        expect(result.stopReason).toBe('finish')

        // Both tools ran. (A model is free to serialise them across two turns, so
        // assert on the set of tools used rather than on the turn count.)
        const used = collected.ofType('tool.end').map((event) => event.toolName)
        expect(new Set(used)).toEqual(new Set(['get_weather', 'get_time']))
      },
      TIMEOUT,
    )

    it(
      'recovers from a tool that throws instead of failing the run',
      async () => {
        const broken = tool({
          name: 'get_air_quality',
          description: 'Get the air-quality index for a city.',
          inputSchema: z.object({ city: z.string() }),
          execute: () => {
            throw new Error('upstream returned 503')
          },
        })

        const agent = new Agent({
          name: 'live-recovery',
          instructions: 'Use your tools. If one fails, say so plainly and continue.',
          model: model(),
          tools: [getWeather, broken],
          maxOutputTokens: 160,
        })

        const result = await agent.run('Give me the weather and the air quality for Paris.')

        // The invariant that matters most: a tool blew up and the run still
        // produced an answer.
        expect(result.stopReason).toBe('finish')
        expect(result.text.length).toBeGreaterThan(0)

        const failures = result.steps.flatMap((step) =>
          step.toolResults.filter((toolResult) => toolResult.isError),
        )
        expect(failures.length).toBeGreaterThanOrEqual(1)
        expect(failures[0]?.output).toMatchObject({ code: 'tool_execution_error' })
      },
      TIMEOUT,
    )

    it(
      'honours a forced tool choice',
      async () => {
        const collected = collectEvents()
        const agent = new Agent({
          name: 'live-forced',
          model: model(),
          tools: [getWeather, getTime],
          maxOutputTokens: 128,
        })

        // The prompt is about time, but the weather tool is forced.
        await agent.run('Tell me anything about Paris.', {
          toolChoice: { type: 'tool', name: 'get_weather' },
          onEvent: collected.listener,
        })

        expect(collected.first('tool.start')?.toolName).toBe('get_weather')
      },
      TIMEOUT,
    )
  })

  describe('limits and failures', () => {
    it(
      'stops at maxTurns against a real model rather than looping',
      async () => {
        // A tool whose result always demands another call — the pathological case.
        const insatiable = tool({
          name: 'get_next_clue',
          description: 'Get the next clue. Always call this again with the clue you receive.',
          inputSchema: z.object({ previous: z.string().optional() }),
          execute: () => ({ clue: 'call get_next_clue again to continue', done: false }),
        })

        const agent = new Agent({
          name: 'live-maxturns',
          instructions: 'Follow the clues using the tool until it says done.',
          model: model(),
          tools: [insatiable],
          maxTurns: 3,
          maxOutputTokens: 64,
        })

        const result = await agent.run('Start following the clues.')

        expect(result.stopReason).toBe('max_turns')
        expect(result.turns).toBe(3)
      },
      TIMEOUT,
    )

    it(
      'maps a bad key to AuthenticationError without leaking it',
      async () => {
        /**
         * Deliberately *not* shaped like a real credential.
         *
         * A literal `sk-or-v1-` followed by 64 hex characters — even one that is
         * obviously fake, like all zeroes — matches OpenRouter's key format
         * exactly, and GitHub's push protection cannot tell a test fixture from a
         * live key. It blocks the push.
         *
         * OpenRouter returns 401 for any unrecognised bearer token regardless of
         * its shape (verified), so dropping the prefix costs the test nothing —
         * and it arguably strengthens it: because redaction does not recognise
         * this string as a secret, the assertion below proves the provider never
         * echoes credentials at all, rather than proving redaction masked them.
         */
        const SECRET = 'invalid-test-credential-do-not-use'

        const agent = new Agent({
          name: 'live-auth',
          model: openrouter(MODEL, { apiKey: SECRET }),
        })

        const error = await agent.run('hello').catch((caught: unknown) => caught)

        expect(isAgentError(error)).toBe(true)
        expect(error).toMatchObject({ code: 'authentication_error', retryable: false })

        // The promise made in the docs, verified against a real 401.
        for (const surface of [
          String(error),
          (error as Error).message,
          (error as Error).stack ?? '',
          JSON.stringify((error as { toJSON: () => unknown }).toJSON()),
        ]) {
          expect(surface).not.toContain(SECRET)
        }
      },
      TIMEOUT,
    )

    it(
      'surfaces an unknown model as a provider error naming the problem',
      async () => {
        const agent = new Agent({
          name: 'live-badmodel',
          model: openrouter('definitely/not-a-real-model', { apiKey: apiKey ?? '' }),
        })

        const error = await agent.run('hello').catch((caught: unknown) => caught)

        expect(isAgentError(error)).toBe(true)
        expect((error as { code?: string }).code).toBe('provider_error')
      },
      TIMEOUT,
    )

    it(
      'aborts an in-flight request when the caller cancels',
      async () => {
        const controller = new AbortController()
        const agent = new Agent({
          name: 'live-abort',
          model: model(),
          maxOutputTokens: 512,
        })

        const promise = agent.run('Write a long essay about the history of Paris.', {
          signal: controller.signal,
        })
        setTimeout(() => controller.abort(), 150)

        const error = await promise.catch((caught: unknown) => caught)
        expect(isAgentError(error)).toBe(true)
        expect((error as { code?: string }).code).toBe('aborted')
      },
      TIMEOUT,
    )

    it(
      'enforces a whole-run timeout',
      async () => {
        const agent = new Agent({ name: 'live-timeout', model: model(), maxOutputTokens: 512 })

        const error = await agent
          .run('Write a detailed 500-word history of France.', { timeoutMs: 200 })
          .catch((caught: unknown) => caught)

        expect(isAgentError(error)).toBe(true)
        // Either the run deadline fired, or the abort it triggered surfaced first.
        expect(['timeout_error', 'aborted']).toContain((error as { code?: string }).code)
      },
      TIMEOUT,
    )
  })

  describe('multi-turn', () => {
    it(
      'retains context when previous messages are passed back',
      async () => {
        const agent = new Agent({
          name: 'live-memory',
          instructions: 'Answer in as few words as possible.',
          model: model(),
          maxOutputTokens: 32,
        })

        const first = await agent.run('My name is Ada Lovelace. Acknowledge briefly.')
        const second = await agent.run('What is my first name?', { messages: first.messages })

        expect(second.text).toMatch(/ada/i)
        // The second request carried the first exchange.
        expect(second.messages.length).toBeGreaterThan(first.messages.length)
      },
      TIMEOUT,
    )
  })
})

// Make the skip visible rather than silent — a suite that quietly runs zero tests
// is indistinguishable from one that passes.
describe.runIf(!apiKey)('live tests', () => {
  it('are skipped because no OPENROUTER_API_KEY was found', () => {
    expect(apiKey).toBeUndefined()
  })
})
