# Delta

**Where the project stands, what is deliberately missing, and what happens next.**

|         |                                                          |
| ------- | -------------------------------------------------------- |
| Step    | 3.5 of 8 — streaming & memory, to parity and past it     |
| Date    | 2026-08-02                                               |
| Package | `just-another-sdk@0.1.0` — **not yet published**         |
| Size    | 49 source files, ~7.9k lines, **0 runtime dependencies** |
| Tests   | 348 — 336 offline (~2.1s) + 12 live                      |

This file is rewritten at the end of every step. It is the current state of the
project, not a changelog — release history will live in
`packages/core/CHANGELOG.md` once changesets generates it at first publish, and
product documentation lives in the [docs site](../apps/web/content/docs).

---

## What is built

Grouped by the seam it occupies. Step 1 built the loop, step 2 wrapped the model
call inside it, step 3 wrapped the loop itself — history in before it starts, new
messages out after it ends. Step 3.5 wrapped the _result_: a run is now something
you can hand to the web platform, record, and read again. **The loop body has not
changed since step 1.**

### Agent runtime

| File                                                          | Does                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`run/runner.ts`](../packages/core/src/run/runner.ts)         | The loop. Model call → tool execution → repeat, bounded by `maxTurns` |
| [`run/model-call.ts`](../packages/core/src/run/model-call.ts) | Stream-vs-generate dispatch, the retry loop, the fallback chain       |
| [`run/run-state.ts`](../packages/core/src/run/run-state.ts)   | The only mutable object in the hot path; created fresh per run        |
| [`run/result.ts`](../packages/core/src/run/result.ts)         | `RunResult`, `RunStep`, `StopReason`                                  |
| [`agent/agent.ts`](../packages/core/src/agent/agent.ts)       | `Agent` — `.run()`, `.stream()`, `.session()`, `.clone()`             |
| [`agent/types.ts`](../packages/core/src/agent/types.ts)       | `AgentConfig`, `RunOptions`, `AGENT_DEFAULTS`                         |

### Sessions

| File                                                                  | Does                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`sessions/store.ts`](../packages/core/src/sessions/store.ts)         | `SessionStore` — `load`, `append`, `clear`; the untrusted-id guard |
| [`sessions/trim.ts`](../packages/core/src/sessions/trim.ts)           | `ContextPolicy`, `trimHistory`, the default token estimator        |
| [`sessions/memory.ts`](../packages/core/src/sessions/memory.ts)       | LRU-bounded map; also the per-agent default store                  |
| [`sessions/file.ts`](../packages/core/src/sessions/file.ts)           | JSONL per session, tolerant of a torn final line                   |
| [`sessions/sqlite.ts`](../packages/core/src/sessions/sqlite.ts)       | `node:sqlite`, lazily imported — still zero dependencies           |
| [`sessions/redis.ts`](../packages/core/src/sessions/redis.ts)         | Injected client; `node-redis` and `ioredis` both detected          |
| [`sessions/postgres.ts`](../packages/core/src/sessions/postgres.ts)   | Injected client; `pg` · `postgres.js` · any query function         |
| [`sessions/summarize.ts`](../packages/core/src/sessions/summarize.ts) | Folding aged-out history into a recap, with an explicit watermark  |

### Streaming

| File                                                              | Does                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [`run/stream.ts`](../packages/core/src/run/stream.ts)             | `StreamedRun` — iterable, thenable, and now `toResponse()` / `toEventResponse()` |
| [`run/async-queue.ts`](../packages/core/src/run/async-queue.ts)   | Bridges the synchronous event bus to a pulling consumer                          |
| [`providers/sse.ts`](../packages/core/src/providers/sse.ts)       | Vendor-neutral `text/event-stream` framer — now used in both directions          |
| [`http/to-stream.ts`](../packages/core/src/http/to-stream.ts)     | Run → `ReadableStream` / SSE, redacted before it leaves the process              |
| [`http/read-stream.ts`](../packages/core/src/http/read-stream.ts) | `readEventStream()` — the client half, anywhere `fetch` runs                     |

### Resumable streams

| File                                                                | Does                                                  |
| ------------------------------------------------------------------- | ----------------------------------------------------- |
| [`streams/store.ts`](../packages/core/src/streams/store.ts)         | `StreamStore` — `append`, `read`, `finish`, `status`  |
| [`streams/resumable.ts`](../packages/core/src/streams/resumable.ts) | Record a run; replay-then-follow, with give-up bounds |
| [`streams/memory.ts`](../packages/core/src/streams/memory.ts)       | LRU-bounded recordings; the per-agent default         |
| [`streams/redis.ts`](../packages/core/src/streams/redis.ts)         | Injected client, TTL'd — the multi-instance answer    |

### Reliability

| File                                                          | Does                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`run/retry.ts`](../packages/core/src/run/retry.ts)           | Full-jitter backoff, `Retry-After` handling, abortable sleep            |
| [`errors/errors.ts`](../packages/core/src/errors/errors.ts)   | One `AgentError` hierarchy, 11 machine-readable codes, `retryable` flag |
| [`util/redact.ts`](../packages/core/src/util/redact.ts)       | Secret redaction for errors, events, and traces                         |
| [`util/stringify.ts`](../packages/core/src/util/stringify.ts) | Safe `unknown` → string, so tool output never becomes `[object Object]` |

### Tools

| File                                                                          | Does                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`tools/tool.ts`](../packages/core/src/tools/tool.ts)                         | `tool()` — handler input inferred from the schema; memoized JSON Schema        |
| [`tools/execute.ts`](../packages/core/src/tools/execute.ts)                   | Validate → deadline → invoke → wrap failures as recoverable results            |
| [`tools/registry.ts`](../packages/core/src/tools/registry.ts)                 | Name-indexed lookup; duplicate names rejected at construction                  |
| [`schema/standard-schema.ts`](../packages/core/src/schema/standard-schema.ts) | Any Standard Schema validator; lazy `import('zod')` for JSON Schema derivation |

### Providers

| File                                                                                    | Does                                                               |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`providers/provider.ts`](../packages/core/src/providers/provider.ts)                   | The contract: `generate()` required, `stream()` optional           |
| [`providers/openai-compatible.ts`](../packages/core/src/providers/openai-compatible.ts) | `fetch`-based transport with SSE streaming. All vendor-shaped code |
| [`providers/openrouter.ts`](../packages/core/src/providers/openrouter.ts)               | `openrouter('anthropic/claude-opus-5')`                            |
| [`providers/openai.ts`](../packages/core/src/providers/openai.ts)                       | `openai('gpt-5')` and `compatible()` for Groq, Ollama, vLLM, …     |

### Observability

| File                                                                        | Does                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`events/events.ts`](../packages/core/src/events/events.ts)                 | The typed event union — **13** members                            |
| [`events/emitter.ts`](../packages/core/src/events/emitter.ts)               | Synchronous bus; a throwing listener cannot break a run           |
| [`events/console-tracer.ts`](../packages/core/src/events/console-tracer.ts) | Ready-made readable trace, with redaction applied before printing |

### Testing (shipped to consumers)

| File                                                                            | Does                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`testing/mock-provider.ts`](../packages/core/src/testing/mock-provider.ts)     | Scripted offline provider, streaming too — no key, no network |
| [`testing/event-collector.ts`](../packages/core/src/testing/event-collector.ts) | Records a run's events for ordering assertions                |

The suite is split by what it can prove:

| Suite                                                                                                                                                            | Count | Needs a key                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------- |
| [`agent-loop`](../packages/core/test/agent-loop.test.ts) · [`tools`](../packages/core/test/tools.test.ts) · [`provider`](../packages/core/test/provider.test.ts) | 51    | no                                      |
| [`sse`](../packages/core/test/sse.test.ts) · [`streaming`](../packages/core/test/streaming.test.ts) · [`reliability`](../packages/core/test/reliability.test.ts) | 52    | no                                      |
| [`sessions`](../packages/core/test/sessions.test.ts) · [`trim`](../packages/core/test/trim.test.ts) · [`summarize`](../packages/core/test/summarize.test.ts)     | 174   | no                                      |
| [`http-stream`](../packages/core/test/http-stream.test.ts) · [`resumable`](../packages/core/test/resumable.test.ts)                                              | 45    | no                                      |
| [`secrets`](../packages/core/test/secrets.test.ts)                                                                                                               | 16    | no                                      |
| [`live`](../packages/core/test/live.test.ts)                                                                                                                     | 12    | yes — skipped automatically without one |

The session count is large because the store contract is **one test body run
against seven adapter configurations**, and the stream-store contract against
two. Adding a backend is a row in an array, and it is either correct against the
same assertions or visibly not.

---

## The four invariants

These are the design. Every future step must preserve them, and each has tests.

1. **The loop always terminates.** Every exit path sets a `stopReason`. A model
   that calls tools forever costs `maxTurns` requests, not an afternoon.
2. **A completed run never throws.** Tool failures become tool results the model
   reads and recovers from. Only cancellation, provider failure, or an explicit
   `onToolError: 'throw'` rejects.
3. **Every turn is recorded.** `steps`, `usage`, and `messages` are complete even
   when a run stops early — so tracing is a formatter over existing data.
4. **A streamed run and a normal run are the same run** (step 2). Same loop, same
   ordering, same `RunResult`. Only the source of the text differs.

Step 3 adds a fifth: **only a completed run is persisted.** A run that throws
mid-turn can leave an assistant message holding tool calls whose results never
arrived; every provider rejects that on the next request. Saving it would poison
the session rather than preserve it. `max_turns` is a completion and does save.

---

## Decisions made in step 3.5

The step began as an OpenAI-parity pass and grew three features. Each choice
below was forced by something that did not work.

| Question                           | Answer                                | Why                                                                                                                                                                                                                                               |
| ---------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Node `Readable` or web stream?** | Web `ReadableStream`                  | OpenAI ships `toTextStream({ compatibleWithNodeStreams: true })`, but matching it means importing `node:stream` into the package root, which ends the edge-runtime guarantee. A web stream works in Node too; the bridge is one line of user code |
| **Method names**                   | Kept `load` / `append` / `clear`      | Clearer than `getItems` / `addItems`, already shipped and documented. Capability was the gap, not vocabulary — the docs carry a mapping table                                                                                                     |
| **Where does `limit` bind?**       | A hint, not a guarantee               | A store that ignores it is slower, never wrong, because the context policy still runs. That is what makes it safe to add to an interface people have already implemented                                                                          |
| **Summary: message or metadata?**  | A message, with an explicit watermark | Metadata needs a second place to persist and a schema change in every adapter. A message round-trips through all five for free                                                                                                                    |
| **Following: pub/sub or polling?** | Polling, 200 ms                       | Pub/sub is lower-latency but puts a subscription in an interface that in-memory and SQL stores cannot honour. The interval is far below the gap between tokens, and Redis can special-case it later                                               |

Five things the plan did not anticipate, each found by a failing test:

- **A windowed read broke `droppedCount`.** Asking the store for exactly
  `maxMessages` made a truncated read indistinguishable from a complete one, so
  the event reported `0` for a conversation whose beginning had just been cut
  off — precisely the silent loss it exists to expose. The fix is to ask for one
  _more_ than the budget and report `truncated`.
- **A windowed read also broke summarization outright.** A summary records how
  many messages from the start of the log it replaces; computed against a window
  that number is wrong, and the next run replays everything in between, growing
  without bound. Summarizing now reads the full log, and says so.
- **Folding to the budget re-summarizes every turn.** With no headroom the very
  next turn is over the limit again and buys another model call, forever. Folds
  now compact to half the budget (`keepRecent`).
- **Following an unknown stream polled forever**, holding a client connection
  open on a mistyped or expired id. Two bounds now end it — and they cover a
  second case the store cannot report at all: a writer process that died.
- **`memorySession` was the one adapter that threw instead of rejecting.**
  Dropping `async` to satisfy a lint rule made a bad session id fail
  synchronously there and asynchronously everywhere else. The rule got the
  exemption; the contract did not.

### Adapters trimmed

`drizzleSession` and `prismaSession` are gone. Both were thin wrappers, and
Drizzle's `db.execute()` takes no parameter array — a real adapter would have had
to interpolate values into SQL. Each is now one documented line through the same
tested path:

```ts
postgresSession(db.$client) // Drizzle
postgresSession((sql, p) => prisma.$queryRawUnsafe(sql, ...p)) // Prisma
```

Both are still covered by the contract suite, so dropping the exports did not
quietly drop the support.

### Zero dependencies held

`pg`, `postgres.js`, `redis`, and `ioredis` are **structural types only** — not
imports, not optional peers. `node:sqlite` and `node:fs` stay behind their own
entry points, and everything added this step (`ReadableStream`, `Response`,
`TextEncoder`, `TextDecoder`) is a web standard available in Node 20+, Bun, Deno,
and Workers alike. The package still installs nothing.

## Verified vs unverified

| Claim                                           | How it was checked                                        | Result         |
| ----------------------------------------------- | --------------------------------------------------------- | -------------- |
| Lint, format, typecheck, test, build            | `pnpm check` across 9 workspaces                          | pass           |
| The step-3 tests still pass                     | unmodified, minus the deleted Drizzle/Prisma cases        | pass           |
| Store contract across 7 adapter configurations  | one shared test body, 12 assertions each                  | pass           |
| Stream-store contract across 2 stores           | one shared test body                                      | pass           |
| A conversation survives the process exiting     | ran the example twice, different pids, read the JSONL     | pass           |
| A chat server streams, remembers, and undoes    | ran it; `curl`ed `/chat`, `/events`, `/history`, `/undo`  | pass           |
| A disconnected client reconnects mid-answer     | ran it; text continuous across the seam, nothing repeated | pass           |
| Text stream equals `result.text`, byte for byte | collected the `ReadableStream` and compared               | pass           |
| Cancelling a response body aborts the run       | asserted `code: 'aborted'`                                | pass           |
| Secrets do not reach the browser                | tool handed `sk-live-…`; absent from the SSE body         | pass           |
| `id:` is monotonic, and survives a resume       | resumed from 3, first id was 3                            | pass           |
| A run outlives its reader, and still saves      | reader cancelled; session held both messages              | pass           |
| Two readers follow one run independently        | identical text from both                                  | pass           |
| Following gives up on an unknown or dead stream | bounded, returned empty rather than hanging               | pass           |
| A failed summary leaves the run succeeding      | summarizer threw; run answered, event carried the error   | pass           |
| Summaries compound without ever sending two     | two folds; second built on the first                      | pass           |
| **Real Postgres and real Redis**                | not run — adapters tested against fakes                   | **unverified** |
| **Real streaming against a real model**         | still not run — needs a key                               | **unverified** |

> **What the fakes do and do not prove.**
>
> The Postgres and Redis fakes implement the client interfaces the adapters
> accept, and answer the exact statements the adapters emit. They prove the
> adapter's own logic: command shapes, SQL shape, multi-row insert parameter
> numbering, `{ rows }`-vs-array normalisation, jsonb parsed or not, windowed
> reads, `pop`, and client detection. They prove nothing about either server.

**Everything runnable without a key has been run**, including both new examples
against the mock provider — the chat server end to end over real HTTP, and the
resumable demo through an actual disconnect and reconnect. What remains needs a
key:

- **`pnpm example:stream`** — carried over from step 2. `examples/.env` exists but
  the key line is commented out. Step 1's live run found a bug all 66 offline
  tests missed.
- **`pnpm example:sessions`, `pnpm example:server`, `pnpm example:resumable`** —
  the mechanics are verified; what a live run adds is that a real model actually
  uses the recalled context.

---

## Progress against the brief

Mapped to the 12 graded categories in [`CLAUDE.md`](../CLAUDE.md).

| #   | Category                      | Marks | State       | What's missing                                                                             |
| --- | ----------------------------- | ----- | ----------- | ------------------------------------------------------------------------------------------ |
| 1   | Agent runtime                 | 15    | **done**    | —                                                                                          |
| 2   | Tools                         | 10    | **done**    | Built-in tool pack (step 6) is additive                                                    |
| 3   | Handoffs                      | 10    | not started | Step 5                                                                                     |
| 4   | Guardrails                    | 10    | **partial** | Schema validation + `onToolError` cover tool safety; no declarative guardrails or approval |
| 5   | Memory & sessions             | 10    | **done**    | 5 adapters, windowed reads, undo, trimming, summarization, events                          |
| 6   | Structured output + streaming | 10    | **partial** | **Streaming done** — HTTP, SSE, resumable. No `outputSchema` yet — step 4                  |
| 7   | Reliability                   | 10    | **done**    | Timeouts, cancellation, loop bounds, typed errors, retries, fallback, secret safety        |
| 8   | Tracing                       | 5     | **partial** | `steps[]` + 13 events + console tracer + an SSE feed; no JSON/OTel exporters               |
| 9   | Developer experience          | 10    | **done**    | Typed API, zero-config install, actionable errors, shipped test helpers                    |
| 10  | Docs & examples               | 10    | **partial** | 12 pages + 6 runnable examples; 3 pages stubbed; **not yet hosted**                        |
| 11  | Product thinking              | 10    | **done**    | Differentiation is real and demonstrable                                                   |
| 12  | Demo & pitch                  | 10    | not started | Landing page done; **no video**                                                            |

**Roughly 95–105 of 120 addressable today.** The cheapest remaining marks, in
order: hosting the docs (category 10), the video (12), structured output (6).

---

## Next step — 4 of 8: structured output

The other half of category 6, and the last thing standing between this SDK and
"typed end to end". Today `RunResult<TOutput>` carries a generic that nothing
fills in — `output` is the text, cast.

- [ ] **`outputSchema` on `AgentConfig`** — any Standard Schema validator, the
      same interop `tool()` already uses. `result.output` becomes `TOutput`,
      inferred, with no cast anywhere in the call site.
- [ ] **Provider-native JSON Schema** where the vendor supports it
      (`response_format: { type: 'json_schema' }`), and a documented prompt-based
      fallback where it does not.
- [ ] **Repair-retry** — an invalid response is handed back to the model with the
      validation errors, bounded by its own attempt ceiling and separate from the
      transport retry in `run/retry.ts`. These must not multiply.
- [ ] **`InvalidOutputError`** carrying `SchemaIssue[]`, so a caller sees which
      field failed rather than "the model returned bad JSON".
- [ ] **Streaming and structured output together** — decide whether a partial
      object is exposed or withheld. The precedent set twice now (withhold partial
      tool arguments; withhold `model.request` from a browser) suggests
      withholding.
- [ ] **Un-stub** [`structured-output.mdx`](../apps/web/content/docs/structured-output.mdx).

### Acceptance

`pnpm check` green · a new `examples/07-structured` extracts a typed record from
prose and survives a deliberately malformed first response · the existing 348
tests pass unmodified.

### Open design questions

1. **Does `outputSchema` suppress tools, or compose with them?** A run that both
   calls tools and returns a typed object is the useful case, but the final turn
   has to be forced into the schema somehow.
2. **Where does the repair budget live** — its own `maxOutputRetries`, or folded
   into `maxTurns`?
3. **Is a repair attempt a `RunStep`?** It is a model call, so invariant 3 says
   yes; but it makes `turns` mean two different things.

---

## Later steps

| Step | Scope                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5    | **Guardrails & handoffs** — input/output/tool guardrails, approval gates, delegation with cycle detection                                                 |
| 6    | **Built-in tool pack** — HTTP fetch, sandboxed filesystem, calculator, web search                                                                         |
| 7    | **Native providers** — Anthropic Messages API and Gemini `generateContent` as siblings to the OpenAI transport (both can reuse `sse.ts`); trace exporters |
| 8    | **Launch** — host the docs, publish, record the demo video, write the pitch                                                                               |

---

## Outstanding manual setup

Only you can do these.

- [ ] **Uncomment `OPENROUTER_API_KEY` in `examples/.env`**, then run
      `pnpm example:stream`, `example:sessions`, `example:server`, and
      `example:resumable`. Everything runnable without a key has already been run;
      these are what a key adds.
- [ ] **Publish to lock the npm name.** `just-another-sdk` is free today, but
      `zero-sdk` being taken while `zerosdk` was free shows how fast that changes.
- [ ] **Add `NPM_TOKEN`** to GitHub → Settings → Secrets → Actions, or the release
      workflow cannot publish.
- [ ] **Point Vercel at `apps/web`** — [`vercel.json`](../apps/web/vercel.json) has
      the monorepo build command already. Then put the URL in
      [`README.md`](../README.md) and
      [`packages/core/package.json`](../packages/core/package.json) `homepage`.
- [ ] **Optional: verify Postgres and Redis against real servers.** A
      `docker compose` with both, and a `live`-style suite that skips without
      them, would close the last unverified row — it now covers `redisStreamStore`
      as well as the session adapters.

---

## Maintaining this file

Rewrite it at the end of each step. Keep it **current state** — what is true
right now — and let git history carry the past. It is not a changelog
(`packages/core/CHANGELOG.md`) and not product documentation
(`apps/web/content/docs/`). If a claim here cannot be checked against the repo in
under a minute, it does not belong.
