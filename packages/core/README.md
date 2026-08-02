# just-another-sdk

**A TypeScript agent SDK with zero runtime dependencies.**

Define an agent, give it tools, run the loop, get a typed result.

```bash
npm i just-another-sdk
```

```ts
import { Agent, tool } from 'just-another-sdk'
import { openrouter } from 'just-another-sdk/providers'
import * as z from 'zod'

const agent = new Agent({
  name: 'travel-assistant',
  instructions:
    'Use the tools available to you rather than guessing. Be concise.',
  model: openrouter('anthropic/claude-opus-5'),
  tools: [
    tool({
      name: 'get_weather',
      description:
        'Get the current weather for a city. Call this whenever the user asks about conditions.',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, tempC: 18, summary: 'clear' }),
      //                  ^^^^ string, inferred from the schema and already validated
    }),
  ],
})

const result = await agent.run('What is the weather in Paris?')

console.log(result.output) // "It's 18°C and clear in Paris."
console.log(result.usage) // { inputTokens: 412, outputTokens: 63, totalTokens: 475 }
console.log(result.stopReason) // 'finish'
```

## Why another one

Because the boring parts are the ones that bite you in production, and most SDKs
treat them as afterthoughts.

**Zero runtime dependencies.** `npm ls` shows one package. Providers are plain
`fetch` calls, so there is no vendor SDK to keep in sync, no transitive
dependency to audit, and the same build runs on Node, Bun, Deno, Cloudflare
Workers, and Vercel Edge.

**The loop cannot hang or crash.** Every exit sets a `stopReason`. A model that
calls tools forever costs you `maxTurns` requests, not your afternoon. A tool
that throws becomes a tool result the model can read and recover from — your run
finishes with an answer instead of a stack trace.

**Your validator, not ours.** Any [Standard Schema](https://standardschema.dev)
validator works — Zod, Valibot, ArkType. Handler inputs are typed from the
schema, and the JSON Schema the model sees is derived automatically.

**Secrets stay out of your logs.** An API key never appears in a thrown error, an
emitted event, or a printed trace. There is a test suite asserting exactly that.

**Everything is observable.** Tracing, streaming, and progress UIs are all
consumers of one event stream, so you can see what your agent did without a
debugger.

## Core concepts

Three things are kept deliberately separate, because conflating them is what
makes agent code impossible to scale:

|            | What it holds                      | Lifetime                                  |
| ---------- | ---------------------------------- | ----------------------------------------- |
| `Agent`    | name, instructions, model, tools   | Created once, shared across every request |
| `RunState` | messages, turn count, usage, steps | One run                                   |
| `Session`  | persisted conversation             | Across runs                               |

An `Agent` is immutable configuration, so a single instance is safe to create at
module scope and share across concurrent users.

## Tools

```ts
const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: z.object({
    city: z.string().describe('City name, e.g. "Paris"'),
    unit: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  timeoutMs: 5_000,
  execute: async ({ city, unit }, context) => {
    const response = await fetch(
      `https://api.example.com/weather?city=${city}`,
      {
        signal: context.signal, // cancelled with the run, or on timeout
      },
    )
    return response.json()
  },
})
```

- **Input is validated before your handler runs.** Invalid arguments never reach
  your code; the model gets a per-field error message and a chance to fix its own
  call.
- **Multiple calls in one turn run concurrently**, because the model emitted them
  together precisely because they are independent. Results keep the original
  order so the conversation stays deterministic.
- **Failures are recoverable by default.** Set `onToolError: 'throw'` on the
  agent when a tool failure should void the whole task.

## Tools in the box

Seventeen tools ship with the package, tiered by how much damage they could do.
Five pure ones are on **every agent** with nothing imported and nothing
configured:

```ts
new Agent({ name: 'assistant', model }).toolNames
// ['calculate', 'current_time', 'date_math', 'unit_convert', 'think']
```

`calculate` is a real expression parser — **no `eval`, no `Function`** — because
the three-line version hands a model a code execution primitive.

Real data with no API key is one line, hitting fixed endpoints the model cannot
redirect:

```ts
import { webTools } from 'just-another-sdk/tools'

tools: [...webTools()] // get_weather, geocode, wikipedia, currency_convert
```

Anything that lets the model choose a host or a path has to be configured, and is
locked down when it is:

```ts
import { httpFetch } from 'just-another-sdk/tools'
import { fileTools } from 'just-another-sdk/tools/fs'

httpFetch({ allow: ['api.example.com'] }) // private + metadata IPs refused even with '*'
fileTools({ root: './workspace' }) // `..`, absolute paths, and symlinks out all refused
```

See [Built-in tools](https://github.com/KARDT89/just-another-sdk/blob/main/apps/web/content/docs/built-in-tools.mdx)
for the full list, the security model, and the ~732 tokens per request the
automatic five cost.

## Handoffs

One agent that knows everything is a prompt that knows nothing well. Give a cheap
router some specialists and let it delegate:

```ts
const triage = new Agent({
  name: 'triage',
  instructions:
    'Route the user to the right specialist. Do not answer directly.',
  model,
  handoffs: [billing, technical],
})

const result = await triage.run('I was charged twice for March.')

result.output // the billing agent's answer
result.agentPath // ['triage', 'billing']
```

A handoff is a **tool** — `transfer_to_billing` — so it inherits tool guardrails,
human approval, timeouts, and tracing with no handoff-specific code. It is also
**one run**: one `runId`, one usage total, one session save, and a `maxTurns`
budget shared across the whole chain.

Three limits stop a routing graph becoming a loop, and none of them ends the run:
`maxHandoffs` (default 5), cycle detection for `A → B → A`, and that shared turn
budget. A refused transfer is an error result the model reads, so the agent
holding the conversation simply answers it.

## Handling failure

Every error is an `AgentError` with a machine-readable `code`, a `retryable`
flag, and — where one exists — a concrete next step:

```ts
import { isAgentError } from 'just-another-sdk'

try {
  await agent.run(prompt)
} catch (error) {
  if (isAgentError(error)) {
    console.error(error.code) // 'rate_limit_error'
    console.error(error.retryable) // true
  }
}
```

`configuration_error` · `authentication_error` · `rate_limit_error` ·
`provider_error` · `network_error` · `timeout_error` · `aborted` ·
`invalid_tool_input` · `tool_execution_error` · `tool_not_found` ·
`invalid_schema`

## Observability

```ts
import { consoleTracer } from 'just-another-sdk'

await agent.run('What is the weather in Paris?', { onEvent: consoleTracer() })
```

```text
▶ run_m9x2k1p  travel-assistant · anthropic/claude-opus-5
  ↳ get_weather {"city":"Paris"}
    → {"city":"Paris","tempC":18,"summary":"clear"} 118ms
✔ finish · 2 turns · 412 in / 63 out · 1.9s
```

Or handle events yourself — `run.start`, `model.request`, `model.response`,
`text.delta`, `tool.start`, `tool.end`, `session.*`, `run.finish`, `run.error`:

```ts
await agent.run(prompt, {
  onEvent: (event) => {
    if (event.type === 'tool.end')
      metrics.record(event.toolName, event.durationMs)
  },
})
```

A throwing listener can never break a run.

## Multi-turn conversations

Give a run a `sessionId` and history loads and saves itself:

```ts
await agent.run('My name is Ada.', { sessionId: 'user_123' })
await agent.run('What is my name?', { sessionId: 'user_123' }) // "Ada"
```

With no store configured that uses a bounded in-memory one. Persist it with a
single line — the adapter takes the client you already have:

```ts
import { fileSession } from 'just-another-sdk/sessions/file'
import { sqliteSession } from 'just-another-sdk/sessions/sqlite'
import { postgresSession, redisSession } from 'just-another-sdk/sessions'

new Agent({
  name: 'support',
  model,
  session: fileSession('./.sessions'),
  //       sqliteSession('./chat.db')
  //       postgresSession(pool)     — pg · postgres.js · any query function
  //       redisSession(redis)       — node-redis · ioredis

  // Bound what is sent, and fold what ages out into a recap instead of losing it
  context: { maxTokens: 30_000, summarize: true },
})
```

Bind a conversation for a chat UI — read a window, or undo the last turn:

```ts
const chat = agent.session('user_123')

await chat.messages({ limit: 20 })
await chat.pop() // "edit my message and regenerate"
```

Or manage the transcript yourself, as before:

```ts
const first = await agent.run('My name is Ada.')
const second = await agent.run('What is my name?', { messages: first.messages })
```

## Streaming to a browser

```ts title="app/api/chat/route.ts"
export async function POST(req: Request) {
  const { message, userId } = await req.json()
  return agent.stream(message, { sessionId: userId }).toResponse()
}
```

`toTextStream()` is a standard web `ReadableStream`, so that works in Next.js,
Hono, Bun, Deno, and Workers. `toEventResponse()` sends every event instead —
tool calls, retries, usage — and `readEventStream(response)` reads it back on the
client. Payloads are redacted on the way out.

A run can also outlive the client that started it:

```ts
const run = agent.resumable(message, { sessionId: userId })
return run.toEventResponse() // reconnect later with agent.resume(run.streamId)
```

## Models

```ts
import { openrouter, openai, compatible } from 'just-another-sdk/providers'

openrouter('anthropic/claude-opus-5') // OPENROUTER_API_KEY — hundreds of models, one key
openai('gpt-5') // OPENAI_API_KEY
compatible('llama3.1', { baseUrl: 'http://localhost:11434/v1' }) // Ollama, vLLM, Groq, …
```

Writing a provider means implementing one method:

```ts
import type { ModelProvider } from 'just-another-sdk'

const myProvider: ModelProvider = {
  providerId: 'mine',
  modelId: 'my-model',
  async generate(request, options) {
    /* translate → fetch → translate back */
  },
}
```

## Testing your agents

Ship tests that never touch the network:

```ts
import { mockProvider, collectEvents } from 'just-another-sdk/testing'

const model = mockProvider([
  { toolCalls: [{ toolName: 'get_weather', input: { city: 'Paris' } }] },
  { text: 'It is 18°C and clear.' },
])

const result = await new Agent({
  name: 'test',
  model,
  tools: [getWeather],
}).run('...')

expect(result.text).toBe('It is 18°C and clear.')
expect(model.calls).toHaveLength(2)
```

## Reliability defaults

| Setting          | Default    | Purpose                                                     |
| ---------------- | ---------- | ----------------------------------------------------------- |
| `maxTurns`       | `10`       | Bounds the loop — the model cannot spend your money forever |
| `maxHandoffs`    | `5`        | Bounds delegation; the transfer is refused, not the run     |
| `toolTimeoutMs`  | `30_000`   | Per tool call                                               |
| `modelTimeoutMs` | `120_000`  | Per model call                                              |
| `onToolError`    | `'return'` | Feed failures back to the model instead of throwing         |

Cancel any run with a standard `AbortSignal`:

```ts
const controller = new AbortController()
setTimeout(() => controller.abort(), 5_000)
await agent.run(prompt, { signal: controller.signal })
```

## Requirements

Node ≥ 20.19, or any runtime with `fetch` and `AbortSignal`. TypeScript is
optional but the whole thing is designed around it.

## Roadmap

Native Anthropic and Gemini providers · trace exporters for JSON and
OpenTelemetry · a sandboxed `run_command`.

## License

MIT
