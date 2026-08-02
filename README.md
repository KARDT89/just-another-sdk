# just-another-sdk

**A TypeScript agent SDK with zero runtime dependencies.**
Define an agent, give it tools, run a loop that cannot hang, get a typed result.

```bash
npm i just-another-sdk
```

```ts
import { Agent } from 'just-another-sdk'
import { openrouter } from 'just-another-sdk/providers'
import { webTools } from 'just-another-sdk/tools'

const agent = new Agent({
  name: 'assistant',
  instructions: 'Use your tools rather than guessing.',
  model: openrouter('anthropic/claude-opus-5'),
  tools: [...webTools()], // weather, wikipedia, geocoding, currency — no API key
})

const result = await agent.run('What is the weather in Paris, in Fahrenheit?')

result.output // "It's 18.2°C in Paris — about 65°F, and clear."
result.usage // { inputTokens: 412, outputTokens: 63, … }
result.stopReason // 'finish'
```

That agent also has `calculate`, `current_time`, `date_math`, `unit_convert`, and
`think` — **every agent does**, with nothing imported and nothing configured.

## Why

Agent frameworks demo well. Then you ship one, and the problems that cost you
time turn out to be the unglamorous ones — a model that loops until your bill
spikes, a tool exception that takes down a request, an API key in a CI log, a
dependency tree you cannot audit, and no way to see what your agent did.

- **Zero runtime dependencies.** Providers are plain `fetch` calls. Runs on Node,
  Bun, Deno, and edge runtimes unchanged.
- **A loop that cannot hang.** Every exit path sets a `stopReason` — and that
  budget is shared across a whole chain of agents, not handed out per agent.
- **Failures stay recoverable.** A tool that throws becomes a tool result the
  model reads and works around.
- **Seventeen tools in the box.** Five automatic, four that need no API key, and
  the rest locked down by default.
- **Dangerous things refused.** Filesystem tools cannot leave their root, not
  even through a symlink; HTTP refuses cloud-metadata and private addresses even
  when you allow every host.
- **Your validator, not ours.** Any [Standard Schema](https://standardschema.dev)
  validator — Zod, Valibot, ArkType.
- **Secrets never reach your logs.** Asserted by a dedicated test suite.
- **Observable by construction.** One stream of 19 typed events feeds tracing,
  metrics, and progress UIs.

Full documentation: **[the docs site](https://just-another-sdk.vercel.app)** ·
package README: [`packages/core`](./packages/core/README.md)

## What it does

| Capability            | Shape                                                                   |
| --------------------- | ----------------------------------------------------------------------- |
| **Agent runtime**     | Multi-turn loop, parallel tool calls, bounded by `maxTurns`             |
| **Tools**             | Typed handlers, schema validation, timeouts, recoverable failures       |
| **Built-in tools**    | 17, tiered by blast radius — see [`tools`](./packages/core/src/tools)   |
| **Handoffs**          | Delegate to a specialist; one run, cycle detection, route in the result |
| **Guardrails**        | Input, output, and per-tool checks, plus human approval gates           |
| **Sessions**          | Memory, file, SQLite, Redis, Postgres, or your own adapter              |
| **Structured output** | `outputSchema` with typed inference and automatic repair                |
| **Streaming**         | Async-iterable runs, SSE over HTTP, and resumable streams               |
| **Reliability**       | Retries with jitter, model fallback chains, timeouts, cancellation      |
| **Tracing**           | 19 typed events, a console tracer, per-turn `steps[]`                   |

## Repository layout

```
packages/core/     the SDK, published as `just-another-sdk`
apps/web/          landing page + documentation (Next.js, Fumadocs, shadcn/ui)
examples/          ten runnable example projects
docs/DELTA.md      what is built, what is not, and what happens next
```

New here? [`docs/DELTA.md`](./docs/DELTA.md) is the fastest way to see the current
state of the project and where it is going. It is deliberately honest about what
is unverified.

## Development

Requires Node ≥ 20.19 and pnpm 11.

```bash
pnpm install
pnpm check            # format:check + lint + typecheck + test + build
```

| Command           | Does                                  |
| ----------------- | ------------------------------------- |
| `pnpm build`      | Build every package                   |
| `pnpm test`       | Run the test suite (offline, ~2.5s)   |
| `pnpm test:watch` | Watch mode                            |
| `pnpm typecheck`  | Typecheck every workspace             |
| `pnpm lint`       | Lint every workspace                  |
| `pnpm format`     | Format with Prettier                  |
| `pnpm web`        | Run the docs site at `localhost:3000` |
| `pnpm changeset`  | Record a change for the next release  |

### Running the examples

Three of them need no API key at all.

```bash
echo "OPENROUTER_API_KEY=sk-or-v1-..." > examples/.env

pnpm example:hello          # a minimal agent
pnpm example:tools          # tools, parallel calls, failure recovery, tracing
pnpm example:stream         # token streaming, cancellation, model fallback
pnpm example:sessions       # a conversation that survives the process exiting
pnpm example:server         # a streaming chat backend with sessions and undo
pnpm example:resumable      # a run that outlives a disconnected client
pnpm example:structured     # typed output, and repairing an invalid answer
pnpm example:guardrails     # three places to refuse, one to ask a person — no key
pnpm example:handoffs       # routing to specialists, loop prevention — no key
pnpm example:builtin-tools  # the built-in tool pack — no key
```

### Testing

The suite is fully offline — it uses the `mockProvider` that ships in
`just-another-sdk/testing`, so it needs no API key and is deterministic.

```bash
pnpm test                                     # 567 offline, ~2.5s
pnpm --filter just-another-sdk test:coverage
```

Two suites are worth reading if you are evaluating the project:
[`test/tool-sandbox.test.ts`](./packages/core/test/tool-sandbox.test.ts), whose
entire job is proving the dangerous paths **fail**, and
[`test/secrets.test.ts`](./packages/core/test/secrets.test.ts), which asserts an
API key cannot reach an error, an event, or a trace.

## Contributing

1. Branch from `main`.
2. Make the change, and add a test — especially for anything in the run loop.
3. `pnpm check` must pass.
4. `pnpm changeset` to describe the change for the changelog.
5. Open a PR.

## Roadmap

Native Anthropic and Gemini providers · trace exporters for JSON and
OpenTelemetry · a sandboxed `run_command`.

## License

MIT © Tamal Sarkar
