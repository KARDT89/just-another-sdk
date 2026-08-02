# Delta

**Where the project stands, what is deliberately missing, and what happens next.**

|         |                                                          |
| ------- | -------------------------------------------------------- |
| Step    | 2 of 8 — streaming & reliability                         |
| Date    | 2026-08-02                                               |
| Package | `just-another-sdk@0.1.0` — **not yet published**         |
| Size    | 33 source files, ~5.0k lines, **0 runtime dependencies** |
| Tests   | 132 — 120 offline (~1.6s) + 12 live                      |

This file is rewritten at the end of every step. It is the current state of the
project, not a changelog — release history will live in
`packages/core/CHANGELOG.md` once changesets generates it at first publish, and
product documentation lives in the [docs site](../apps/web/content/docs).

---

## What is built

Grouped by the seam it occupies. Step 1 built the loop; step 2 wrapped the model
call inside it without touching the loop's structure.

### Agent runtime

| File                                                          | Does                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`run/runner.ts`](../packages/core/src/run/runner.ts)         | The loop. Model call → tool execution → repeat, bounded by `maxTurns` |
| [`run/model-call.ts`](../packages/core/src/run/model-call.ts) | Stream-vs-generate dispatch, the retry loop, the fallback chain       |
| [`run/run-state.ts`](../packages/core/src/run/run-state.ts)   | The only mutable object in the hot path; created fresh per run        |
| [`run/result.ts`](../packages/core/src/run/result.ts)         | `RunResult`, `RunStep`, `StopReason`                                  |
| [`agent/agent.ts`](../packages/core/src/agent/agent.ts)       | `Agent` — immutable config, `.run()`, `.stream()`, `.clone()`         |
| [`agent/types.ts`](../packages/core/src/agent/types.ts)       | `AgentConfig`, `RunOptions`, `AGENT_DEFAULTS`                         |

`runAgent` is now a thin wrapper over an internal `executeRun`, which takes one
extra argument the public API does not expose: whether to prefer `stream()`.
**There is exactly one loop** — `agent.stream()` is a consumer of it, not a
parallel implementation.

### Streaming

| File                                                            | Does                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [`run/stream.ts`](../packages/core/src/run/stream.ts)           | `StreamedRun` — async-iterable **and** thenable; `textStream()`, `abort()` |
| [`run/async-queue.ts`](../packages/core/src/run/async-queue.ts) | Bridges the synchronous event bus to a pulling consumer                    |
| [`providers/sse.ts`](../packages/core/src/providers/sse.ts)     | Vendor-neutral `text/event-stream` framer                                  |

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

| File                                                                                    | Does                                                                    |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`providers/provider.ts`](../packages/core/src/providers/provider.ts)                   | The contract: `generate()` required, `stream()` optional                |
| [`providers/openai-compatible.ts`](../packages/core/src/providers/openai-compatible.ts) | `fetch`-based transport, now with SSE streaming. All vendor-shaped code |
| [`providers/openrouter.ts`](../packages/core/src/providers/openrouter.ts)               | `openrouter('anthropic/claude-opus-5')`                                 |
| [`providers/openai.ts`](../packages/core/src/providers/openai.ts)                       | `openai('gpt-5')` and `compatible()` for Groq, Ollama, vLLM, …          |

### Observability

| File                                                                        | Does                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`events/events.ts`](../packages/core/src/events/events.ts)                 | The typed event union — **10** members                            |
| [`events/emitter.ts`](../packages/core/src/events/emitter.ts)               | Synchronous bus; a throwing listener cannot break a run           |
| [`events/console-tracer.ts`](../packages/core/src/events/console-tracer.ts) | Ready-made readable trace, with redaction applied before printing |

### Testing (shipped to consumers)

| File                                                                            | Does                                                              |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`testing/mock-provider.ts`](../packages/core/src/testing/mock-provider.ts)     | Scripted offline provider, now streaming too — no key, no network |
| [`testing/event-collector.ts`](../packages/core/src/testing/event-collector.ts) | Records a run's events for ordering assertions                    |

The suite is split by what it can prove:

| Suite                                                                                                                                                            | Count | Needs a key                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------- |
| [`agent-loop`](../packages/core/test/agent-loop.test.ts) · [`tools`](../packages/core/test/tools.test.ts) · [`provider`](../packages/core/test/provider.test.ts) | 51    | no                                      |
| [`sse`](../packages/core/test/sse.test.ts) · [`streaming`](../packages/core/test/streaming.test.ts) · [`reliability`](../packages/core/test/reliability.test.ts) | 52    | no                                      |
| [`secrets`](../packages/core/test/secrets.test.ts)                                                                                                               | 16    | no                                      |
| [`live`](../packages/core/test/live.test.ts)                                                                                                                     | 12    | yes — skipped automatically without one |

**Suite time went from ~300ms to ~1.6s** and the cause is worth recording:
retries are on by default, so the three existing tests that assert a rejection on
a retryable status (429, 500, transport failure) now make three attempts each and
sleep two jittered backoffs. The assertions are on the final error, so they pass
unmodified — this is the honest cost of retrying by default, not a regression.

---

## The three invariants

These are the design. Every future step must preserve them, and each has tests.

1. **The loop always terminates.** Every exit path sets a `stopReason`. A model
   that calls tools forever costs `maxTurns` requests, not an afternoon.
2. **A completed run never throws.** Tool failures become tool results the model
   reads and recovers from. Only cancellation, provider failure, or an explicit
   `onToolError: 'throw'` rejects.
3. **Every turn is recorded.** `steps`, `usage`, and `messages` are complete even
   when a run stops early — so tracing is a formatter over existing data.

Step 2 added a fourth, specific to streaming: **a streamed run and a normal run
are the same run.** Same loop, same ordering, same `RunResult`, same invariants.
The only difference is where the text comes from.

---

## Open questions from step 1, now answered

The step-1 plan left four questions deliberately open. Each is now settled, in
code and in [`streaming.mdx`](../apps/web/content/docs/streaming.mdx).

| Question              | Answer                   | Why                                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Backpressure**      | Unbounded buffering      | The event bus is synchronous by contract, so blocking the producer would break every `onEvent` consumer and deadlock any handler that awaits. Real backpressure cannot reach the model anyway — you would stall a TCP window and keep paying. The buffer is already bounded by `maxTurns × maxOutputTokens` |
| **Tool interleaving** | Tools never overlap text | Not a policy — a consequence. The stream must reach its `finish` chunk before tool calls are known, so there is no text left to stream when a tool starts                                                                                                                                                   |
| **Partial arguments** | Withheld                 | Fragments are reassembled inside the runtime; `tool.start` fires once per call with validated input. No consumer is ever handed half a JSON object                                                                                                                                                          |
| **Retry scope**       | Per model call           | A failed attempt is replayed with the identical request — no state to unwind, no replay machinery                                                                                                                                                                                                           |

Two further decisions the plan did not anticipate:

- **`Retry-After` is a floor, and one longer than `maxRetryDelayMs` is refused.**
  Sleeping exactly what a server asks guarantees a thundering herd; blocking an
  `await` for five minutes because a gateway said so is worse than an actionable
  error, which still carries `retryAfterMs` so the caller can schedule it.
- **Fallback fires on non-retryable failures too.** A 401 or an unknown model on
  the primary is precisely when a second vendor should serve. Cancellation is the
  one exception.

---

## Verified vs unverified

| Claim                                                  | How it was checked                                 | Result         |
| ------------------------------------------------------ | -------------------------------------------------- | -------------- |
| Lint, format, typecheck, test, build                   | `pnpm check` across 6 workspaces                   | pass           |
| The 78 step-1 tests still pass unmodified              | ran them with no edits                             | pass           |
| SSE framing under adversarial chunking                 | byte-at-a-time feed, `\r` on a chunk boundary      | pass           |
| Streaming falls back for a provider without `stream()` | asserted identical result to `.run()`              | pass           |
| No partial tool arguments escape                       | asserted no event carries a fragment               | pass           |
| No unhandled rejection when only iterating             | `process.on('unhandledRejection')` probe           | pass           |
| Backoff curve                                          | stubbed `random`, exact values asserted            | pass           |
| Cancellation during a backoff                          | elapsed ≪ the scheduled 5s delay                   | pass           |
| Secrets survive the retry path                         | key absent from `model.retry` event and trace line | pass           |
| **Real streaming against a real model**                | not yet — needs a key                              | **unverified** |

> **A defect the offline tests found, and one they nearly missed.**
>
> Wiring retries revealed that a mid-flight cancellation was surfacing as
> `provider_error` rather than `aborted`: a provider aborted by the run signal
> may reject with its own transport-shaped error, which then got wrapped as an
> unclassified provider failure. `callModel` now checks the _signal_ rather than
> trusting the error's code, so a cancelled run is reported as cancelled whatever
> the provider threw on its way down.
>
> Separately, the documented escape hatch for `stream_options` — which older vLLM
> and some Ollama builds reject with a 400 — turned out not to be reachable:
> `compatible()` did not accept `defaultBody`. Writing the test for the documented
> behaviour is what surfaced it. It does now.

The one thing still unverified is the thing a mock structurally cannot prove:
real SSE framing against a real gateway, with real keep-alives and real chunk
boundaries. **Run `pnpm example:stream` with a key before trusting this step.**
Step 1's live run found a bug that all 66 offline tests missed; there is no
reason to assume step 2 is different.

---

## Progress against the brief

Mapped to the 12 graded categories in [`CLAUDE.md`](../CLAUDE.md).

| #   | Category                      | Marks | State       | What's missing                                                                             |
| --- | ----------------------------- | ----- | ----------- | ------------------------------------------------------------------------------------------ |
| 1   | Agent runtime                 | 15    | **done**    | —                                                                                          |
| 2   | Tools                         | 10    | **done**    | Built-in tool pack (step 6) is additive                                                    |
| 3   | Handoffs                      | 10    | not started | Step 5                                                                                     |
| 4   | Guardrails                    | 10    | **partial** | Schema validation + `onToolError` cover tool safety; no declarative guardrails or approval |
| 5   | Memory & sessions             | 10    | **partial** | Multi-turn works via `messages`; no persistence, no storage adapters                       |
| 6   | Structured output + streaming | 10    | **partial** | **Streaming done.** No `outputSchema` yet — step 4                                         |
| 7   | Reliability                   | 10    | **done**    | Timeouts, cancellation, loop bounds, typed errors, retries, fallback, secret safety        |
| 8   | Tracing                       | 5     | **partial** | `steps[]` + 10 events + console tracer; no JSON/OTel exporters                             |
| 9   | Developer experience          | 10    | **done**    | Typed API, zero-config install, actionable errors, shipped test helpers                    |
| 10  | Docs & examples               | 10    | **partial** | 11 pages + 3 runnable examples; 4 pages stubbed; **not yet hosted**                        |
| 11  | Product thinking              | 10    | **done**    | Differentiation is real and demonstrable                                                   |
| 12  | Demo & pitch                  | 10    | not started | Landing page done; **no video**                                                            |

**Roughly 80–90 of 120 addressable today.** The cheapest remaining marks, in
order: hosting the docs (category 10), the video (12), sessions (5).

---

## Next step — 3 of 8: sessions & memory

The first step that adds a genuinely new concept rather than deepening an
existing one. `Agent` is configuration and `RunState` is one run; `Session` is
the third thing — state that outlives both.

- [ ] **`SessionStore` interface** — `get`, `append`, `clear`, keyed by session
      id. Small enough that a custom adapter is a class with three methods.
- [ ] **Adapters** — in-memory (default), file (JSONL), SQLite (`node:sqlite`,
      so still zero dependencies), Redis (via an injected client, not a driver
      dependency).
- [ ] **`session` on `RunOptions`** — history loads before the run and the new
      turns append after it, so multi-turn stops being the caller's problem.
- [ ] **Context-window management** — trimming by turn count and by token
      budget, then summarization of what was trimmed. This is where a long
      conversation stops silently costing more every turn.
- [ ] **Tests** — a conversation surviving a process restart through the file
      adapter; concurrent runs against one session not corrupting it; trimming
      preserving the system message and the most recent turns.
- [ ] **Un-stub** [`sessions.mdx`](../apps/web/content/docs/sessions.mdx).

### Acceptance

`pnpm check` green · a new `examples/04-sessions` holds a conversation across two
separate process invocations · the existing 132 tests pass unmodified.

### Open design questions

1. **Where does trimming happen** — at load, or continuously during the run?
2. **Is a summary a message or metadata?** A message is simpler and survives a
   round-trip; metadata is cleaner but needs its own persistence.
3. **Concurrency** — two runs on one session: last-write-wins, optimistic
   locking, or an explicit lock in the store contract?

---

## Later steps

| Step | Scope                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4    | **Structured output** — `outputSchema` on `AgentConfig`, provider-native JSON Schema where available, repair-retry, `InvalidOutputError`                  |
| 5    | **Guardrails & handoffs** — input/output/tool guardrails, approval gates (needs serializable run state from step 3), delegation with cycle detection      |
| 6    | **Built-in tool pack** — HTTP fetch, sandboxed filesystem, calculator, web search                                                                         |
| 7    | **Native providers** — Anthropic Messages API and Gemini `generateContent` as siblings to the OpenAI transport (both can reuse `sse.ts`); trace exporters |
| 8    | **Launch** — host the docs, publish, record the demo video, write the pitch                                                                               |

---

## Outstanding manual setup

Only you can do these.

- [ ] **Run `pnpm example:stream` with a real key.** The highest-value unchecked
      box in this file — see "Verified vs unverified" above.
- [ ] **Publish to lock the npm name.** `just-another-sdk` is free today, but
      `zero-sdk` being taken while `zerosdk` was free shows how fast that changes.
- [ ] **Add `NPM_TOKEN`** to GitHub → Settings → Secrets → Actions, or the release
      workflow cannot publish.
- [ ] **Point Vercel at `apps/web`** — [`vercel.json`](../apps/web/vercel.json) has
      the monorepo build command already. Then put the URL in
      [`README.md`](../README.md) and
      [`packages/core/package.json`](../packages/core/package.json) `homepage`.

---

## Maintaining this file

Rewrite it at the end of each step. Keep it **current state** — what is true
right now — and let git history carry the past. It is not a changelog
(`packages/core/CHANGELOG.md`) and not product documentation
(`apps/web/content/docs/`). If a claim here cannot be checked against the repo in
under a minute, it does not belong.
