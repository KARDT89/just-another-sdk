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
  instructions: 'Use the tools available to you rather than guessing.',
  model: openrouter('anthropic/claude-opus-5'),
  tools: [
    tool({
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => ({ city, tempC: 18, summary: 'clear' }),
    }),
  ],
})

const result = await agent.run('What is the weather in Paris?')
console.log(result.output) // "It's 18°C and clear in Paris."
```

## Why

Agent frameworks demo well. Then you ship one, and the problems that cost you
time turn out to be the unglamorous ones — a model that loops until your bill
spikes, a tool exception that takes down a request, an API key in a CI log, a
dependency tree you cannot audit, and no way to see what your agent did.

- **Zero runtime dependencies.** Providers are plain `fetch` calls. Runs on Node,
  Bun, Deno, and edge runtimes unchanged.
- **A loop that cannot hang.** Every exit path sets a `stopReason`.
- **Failures stay recoverable.** A tool that throws becomes a tool result the
  model reads and works around.
- **Your validator, not ours.** Any [Standard Schema](https://standardschema.dev)
  validator — Zod, Valibot, ArkType.
- **Secrets never reach your logs.** Asserted by a dedicated test suite.
- **Observable by construction.** One event stream feeds tracing, metrics, and
  progress UIs.

Full documentation: **[the docs site](https://just-another-sdk.vercel.app)** ·
package README: [`packages/core`](./packages/core/README.md)

## Repository layout

```
packages/core/     the SDK, published as `just-another-sdk`
apps/web/          landing page + documentation (Next.js, Fumadocs, shadcn/ui)
examples/          runnable example projects
docs/DELTA.md      what is built, what is not, and what happens next
```

New here? [`docs/DELTA.md`](./docs/DELTA.md) is the fastest way to see the current
state of the project and where it is going.

## Development

Requires Node ≥ 20.19 and pnpm 11.

```bash
pnpm install
pnpm check            # format:check + lint + typecheck + test + build
```

| Command           | Does                                  |
| ----------------- | ------------------------------------- |
| `pnpm build`      | Build every package                   |
| `pnpm test`       | Run the test suite (offline, ~250ms)  |
| `pnpm test:watch` | Watch mode                            |
| `pnpm typecheck`  | Typecheck every workspace             |
| `pnpm lint`       | Lint every workspace                  |
| `pnpm format`     | Format with Prettier                  |
| `pnpm web`        | Run the docs site at `localhost:3000` |
| `pnpm changeset`  | Record a change for the next release  |

### Running the examples

```bash
echo "OPENROUTER_API_KEY=sk-or-v1-..." > examples/.env
pnpm example:hello     # a minimal agent
pnpm example:tools     # tools, parallel calls, failure recovery, tracing
pnpm example:stream    # token streaming, cancellation, model fallback
pnpm example:sessions  # a conversation that survives the process exiting
pnpm example:server    # a streaming chat backend with sessions and undo
pnpm example:resumable # a run that outlives a disconnected client
```

### Testing

The suite is fully offline — it uses the `mockProvider` that ships in
`just-another-sdk/testing`, so it needs no API key and is deterministic.

```bash
pnpm test
pnpm --filter just-another-sdk test:coverage
```

## Contributing

1. Branch from `main`.
2. Make the change, and add a test — especially for anything in the run loop.
3. `pnpm check` must pass.
4. `pnpm changeset` to describe the change for the changelog.
5. Open a PR.

## Roadmap

Guardrails and approval gates · multi-agent handoffs · built-in tool pack ·
native Anthropic and Gemini providers.

Each is designed and documented under **Coming next** in the docs, so the intended
API is visible before it ships.

## License

MIT © Tamal Sarkar
