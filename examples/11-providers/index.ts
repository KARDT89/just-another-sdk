/**
 * Example 11 — Providers.
 *
 * Three vendors have native transports in this SDK: Claude over the Messages
 * API, Gemini over `generateContent`, and OpenAI over Chat Completions. Each is
 * a direct `fetch` call, which is why the package still installs with an empty
 * dependency tree.
 *
 * This example is about the part that matters in production: what happens when
 * one of them is having a bad day.
 *
 *   pnpm example:providers
 *
 * **This whole example runs offline.** Act 1 stubs the Anthropic transport so
 * you can see the real request the provider builds without spending anything.
 * Act 2 makes that transport fail the way Anthropic actually fails — a 529
 * overload — and lets the fallback chain do its job. Act 3 shows the same for
 * Gemini's schema translation. Nothing here needs an API key.
 *
 * Swap the stubs for real keys and the code is unchanged:
 *
 *   const agent = new Agent({
 *     name: 'assistant',
 *     model: anthropic('claude-opus-5'),
 *     fallbacks: [google('gemini-2.5-pro')],
 *   })
 */

import { Agent, consoleTracer, tool } from 'just-another-sdk'
import { anthropic, google } from 'just-another-sdk/providers'
import { mockProvider } from 'just-another-sdk/testing'
import * as z from 'zod'

const weather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, tempC: 18, summary: 'clear' }),
})

/** Captures the request a provider builds, then answers it. */
function stub(reply: unknown): { fetch: typeof fetch; body: () => unknown } {
  let captured: unknown
  return {
    fetch: async (_url, init) => {
      captured = JSON.parse(String(init?.body))
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    body: () => captured,
  }
}

function heading(text: string): void {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`)
}

/* ── Act 1: what the Anthropic provider actually sends ────────────────────── */

heading('1 · The Messages API request the provider builds')

const anthropicStub = stub({
  type: 'message',
  model: 'claude-opus-5',
  content: [{ type: 'text', text: 'It is 18°C and clear in Paris.' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 412, output_tokens: 63 },
})

const claude = new Agent({
  name: 'assistant',
  instructions: 'Be concise.',
  model: anthropic('claude-opus-5', {
    apiKey: 'sk-ant-offline-placeholder',
    fetch: anthropicStub.fetch,
  }),
  tools: [weather],
  builtins: false,
})

const claudeResult = await claude.run('Weather in Paris?')

console.log(JSON.stringify(anthropicStub.body(), null, 2))
console.log('\nanswer:', claudeResult.output)

// Three details worth noticing above:
//   • `system` is a top-level field, not a message — Anthropic has no system role.
//   • `max_tokens` is present even though the agent never set it. The API
//     requires it; the provider supplies 4096 rather than letting the request 400.
//   • tools use `input_schema`, not `parameters`.

/* ── Act 2: a vendor goes down, and the run does not ──────────────────────── */

heading('2 · Anthropic returns 529, and the run continues on Gemini')

// Exactly what an overloaded Anthropic sends back.
const overloaded: typeof fetch = async () =>
  new Response(
    JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    { status: 529, headers: { 'content-type': 'application/json' } },
  )

const resilient = new Agent({
  name: 'assistant',
  instructions: 'Help the user. Use your tools.',
  model: anthropic('claude-opus-5', {
    apiKey: 'sk-ant-offline-placeholder',
    fetch: overloaded,
  }),
  // In a real app this is `google('gemini-2.5-pro')`. A scripted provider keeps
  // the example offline while exercising the identical fallback path.
  fallbacks: [
    mockProvider(
      [
        { toolCalls: [{ toolName: 'get_weather', input: { city: 'Paris' } }] },
        { text: "It's 18°C in Paris — clear." },
      ],
      { providerId: 'google', modelId: 'gemini-2.5-pro' },
    ),
  ],
  tools: [weather],
  builtins: false,
  maxRetries: 1,
})

const failover = await resilient.run('Weather in Paris?', { onEvent: consoleTracer() })

console.log('\nanswer:', failover.output)
console.log('one run, one usage total:', JSON.stringify(failover.usage))

// A 529 is retryable, so the policy backs off first and only then moves on. A
// 401 would not be: retrying a bad key against another vendor wastes time, so
// the run fails immediately instead.

/* ── Act 3: the translation Gemini needs to accept your tools ─────────────── */

heading('3 · Gemini rewrites tool schemas, because it has to')

const geminiStub = stub({
  modelVersion: 'gemini-2.5-pro',
  candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Ready.' }] } }],
  usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 3, totalTokenCount: 33 },
})

await new Agent({
  name: 'assistant',
  model: google('gemini-2.5-pro', {
    apiKey: 'AIza-offline-placeholder',
    fetch: geminiStub.fetch,
  }),
  tools: [weather],
  builtins: false,
}).run('Hello')

const geminiBody = geminiStub.body() as { tools: { functionDeclarations: unknown[] }[] }

console.log(JSON.stringify(geminiBody.tools, null, 2))

// Gemini accepts only an OpenAPI 3.0 subset of JSON Schema. Zod emits `$schema`
// and this SDK's own empty-object schema emits `additionalProperties`, and
// Gemini rejects both — so every tool schema is rewritten on the way out.
// Without that pass, every tool call here would be a 400.
const serialized = JSON.stringify(geminiBody.tools)
console.log('\ncontains $schema:            ', serialized.includes('$schema'))
console.log('contains additionalProperties:', serialized.includes('additionalProperties'))

console.log('\nDone. Every act above ran offline, with no API key.\n')
