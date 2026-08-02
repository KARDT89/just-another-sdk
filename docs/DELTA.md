# Delta

**Where the project stands, what is deliberately missing, and what happens next.**

|         |                                                          |
| ------- | -------------------------------------------------------- |
| Step    | 4 of 8 — structured output                               |
| Date    | 2026-08-02                                               |
| Package | `just-another-sdk@0.1.0` — **published**; 0.2.0 pending  |
| Size    | 50 source files, ~8.9k lines, **0 runtime dependencies** |
| Tests   | 386 — 373 offline (~2.1s) + 13 live                      |

This file is rewritten at the end of every step. It is the current state of the
project, not a changelog — release history lives in
`packages/core/CHANGELOG.md`, and product documentation lives in the
[docs site](../apps/web/content/docs).

---

## What is built

Grouped by the seam it occupies. Step 1 built the loop, step 2 wrapped the model
call inside it, step 3 wrapped the loop itself, step 3.5 wrapped the result so it
could reach a browser. Step 4 wrapped the _answer_: it is no longer a string you
parse but a value the compiler knows the shape of. **The loop body has not
changed since step 1** — this step touched three lines inside it, none of them
control flow.

### Agent runtime

| File                                                          | Does                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| [`run/runner.ts`](../packages/core/src/run/runner.ts)         | The loop. Model call → tool execution → repeat, bounded by `maxTurns` |
| [`run/model-call.ts`](../packages/core/src/run/model-call.ts) | Stream-vs-generate dispatch, the retry loop, the fallback chain       |
| [`run/run-state.ts`](../packages/core/src/run/run-state.ts)   | The only mutable object in the hot path; created fresh per run        |
| [`run/result.ts`](../packages/core/src/run/result.ts)         | `RunResult`, `RunStep`, `StopReason`                                  |
| [`agent/agent.ts`](../packages/core/src/agent/agent.ts)       | `Agent` — `.run()`, `.stream()`, `.session()`, `.clone()`             |
| [`agent/types.ts`](../packages/core/src/agent/types.ts)       | `AgentConfig`, `RunOptions`, `AGENT_DEFAULTS`                         |

### Structured output

| File                                                                          | Does                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`run/output.ts`](../packages/core/src/run/output.ts)                         | Pure: schema resolution, the prompt instruction, JSON extraction, repair prompt |
| [`run/runner.ts`](../packages/core/src/run/runner.ts) · `finalizeOutput`      | Validate the final answer, emit, repair, throw — all _outside_ the loop         |
| [`schema/standard-schema.ts`](../packages/core/src/schema/standard-schema.ts) | `SchemaSubject`, so a conversion failure names the right thing                  |

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

| File                                                              | Does                                                                   |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`run/stream.ts`](../packages/core/src/run/stream.ts)             | `StreamedRun` — iterable, thenable, `toResponse()`/`toEventResponse()` |
| [`run/async-queue.ts`](../packages/core/src/run/async-queue.ts)   | Bridges the synchronous event bus to a pulling consumer                |
| [`providers/sse.ts`](../packages/core/src/providers/sse.ts)       | Vendor-neutral `text/event-stream` framer — used in both directions    |
| [`http/to-stream.ts`](../packages/core/src/http/to-stream.ts)     | Run → `ReadableStream` / SSE, redacted before it leaves the process    |
| [`http/read-stream.ts`](../packages/core/src/http/read-stream.ts) | `readEventStream()` — the client half, anywhere `fetch` runs           |

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
| [`errors/errors.ts`](../packages/core/src/errors/errors.ts)   | One `AgentError` hierarchy, 12 machine-readable codes, `retryable` flag |
| [`util/redact.ts`](../packages/core/src/util/redact.ts)       | Secret redaction for errors, events, and traces                         |
| [`util/stringify.ts`](../packages/core/src/util/stringify.ts) | Safe `unknown` → string, so tool output never becomes `[object Object]` |

### Tools

| File                                                          | Does                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`tools/tool.ts`](../packages/core/src/tools/tool.ts)         | `tool()` — handler input inferred from the schema; memoized JSON Schema |
| [`tools/execute.ts`](../packages/core/src/tools/execute.ts)   | Validate → deadline → invoke → wrap failures as recoverable results     |
| [`tools/registry.ts`](../packages/core/src/tools/registry.ts) | Name-indexed lookup; duplicate names rejected at construction           |

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
| [`events/events.ts`](../packages/core/src/events/events.ts)                 | The typed event union — **14** members                            |
| [`events/emitter.ts`](../packages/core/src/events/emitter.ts)               | Synchronous bus; a throwing listener cannot break a run           |
| [`events/console-tracer.ts`](../packages/core/src/events/console-tracer.ts) | Ready-made readable trace, with redaction applied before printing |

### Testing (shipped to consumers)

| File                                                                            | Does                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`testing/mock-provider.ts`](../packages/core/src/testing/mock-provider.ts)     | Scripted offline provider, streaming too — no key, no network |
| [`testing/event-collector.ts`](../packages/core/src/testing/event-collector.ts) | Records a run's events for ordering assertions                |

The suite, by file:

| Suite                                           | Count | Needs a key                             |
| ----------------------------------------------- | ----- | --------------------------------------- |
| `sessions`                                      | 144   | no                                      |
| `structured-output`                             | 37    | no                                      |
| `resumable`                                     | 26    | no                                      |
| `streaming`                                     | 23    | no                                      |
| `http-stream` · `reliability`                   | 38    | no                                      |
| `agent-loop` · `tools` · `provider` · `secrets` | 68    | no                                      |
| `summarize` · `trim` · `sse`                    | 37    | no                                      |
| `live`                                          | 13    | yes — skipped automatically without one |

The session count is large because the store contract is **one test body run
against seven adapter configurations**, and the stream-store contract against
two. Adding a backend is a row in an array, and it is either correct against the
same assertions or visibly not.

---

## The five invariants

These are the design. Every future step must preserve them, and each has tests.

1. **The loop always terminates.** Every exit path sets a `stopReason`. A model
   that calls tools forever costs `maxTurns` requests, not an afternoon.
2. **A completed run never throws** — with three documented exceptions:
   cancellation, provider failure, `onToolError: 'throw'`, and now
   `InvalidOutputError`. Tool failures are still recoverable results, not throws.
3. **Every turn is recorded.** `steps`, `usage`, and `messages` are complete even
   when a run stops early — so tracing is a formatter over existing data. A
   repair is a model call, so it is a step; it is not a turn, so it does not
   count against `maxTurns`.
4. **A streamed run and a normal run are the same run.** Same loop, same
   ordering, same `RunResult`. Only the source of the text differs.
5. **Only a completed run is persisted.** A run that threw mid-turn can leave an
   assistant message holding tool calls whose results never arrived; every
   provider rejects that on the next request. `max_turns` is a completion and
   does save. A run whose output never validated does **not**.

---

## Decisions made in step 4

Both of DELTA's open questions from step 3.5 are resolved, and the third
question — "does `outputSchema` suppress tools or compose with them?" — was
answered before implementation began.

| Question                               | Answer                                     | Why                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Suppress tools, or compose?**        | Compose                                    | A run that calls tools _and_ returns a typed object is the case people actually want. The schema rides on every call; only the final turn is validated. The loop body is untouched       |
| **Where does the repair budget live?** | Its own `maxOutputRetries`, default 1      | `maxTurns` is the tool budget. Folding them lets a non-compliant model silently eat it and end as `max_turns` — the failure reported on entirely the wrong path                          |
| **Is a repair a `RunStep`?**           | Yes, with `kind: 'repair'`; not a turn     | Invariant 3 wins on recording: it costs tokens and can hit a fallback. But `result.turns` must never exceed the `maxTurns` the config promises                                           |
| **Parameterise on schema or output?**  | Output — `AgentConfig<TOutput = string>`   | Parameterising on `TSchema` leaves the no-schema case with no inference candidate, collapsing to `RunResult<never>`. On the output, `string` is a free default                           |
| **Partial objects while streaming?**   | Withheld, along with `text.delta` entirely | Third application of a precedent set twice. Half a JSON object is not renderable, and the raw text is not what a caller of `outputSchema` asked for                                      |
| **Prompt fallback: gated or always?**  | Always appended                            | `ModelProvider` has no capability surface, and the gateways are the problem — Ollama and older vLLM accept `response_format` and silently drop it. 60 tokens beats a silent class of bug |

Things the plan did not anticipate:

- **The type parameter needed one cast, not two.** The plan expected
  `this.config as AgentConfig<T>` in three methods. Making the _internal_ entry
  points take `AgentConfig<unknown>` instead makes covariance do the work, and
  the only remaining cast is in `clone()`. Verified by printing the checker's
  inferred types for seven call shapes.
- **Adding the field did not break the six files.** The plan predicted typecheck
  would fail the moment `AgentConfig<TOutput>` landed. It did not: nothing
  propagated a non-default `TOutput` until `Agent` itself became generic one step
  later. The blast radius was real, it just arrived one commit late.
- **`strict: true` was a live 400 waiting to happen.**
  [`openai-compatible.ts`](../packages/core/src/providers/openai-compatible.ts)
  hardcoded it whenever a schema was present. OpenAI's strict mode rejects any
  schema without `additionalProperties: false` and every key `required`, which
  Zod's `toJSONSchema({ io: 'input' })` does not produce. The code had never been
  reachable — nothing set `responseFormat` — so this step is what would have
  activated it. `ResponseFormat.strict` is now opt-in, defaulting to `false`.
- **`resolveJsonSchema` lied about whose schema failed.** Its second parameter
  was `toolName`, and passing `'output'` produced _"Could not derive a JSON Schema
  for tool \"output\""_ with a hint telling you to fix a `tool()` call you never
  wrote. `SchemaSubject` fixes the wording without changing a byte of the three
  existing tool messages — `tools.test.ts` passing unmodified is the canary.
- **A secrets test found a pre-existing behaviour, not a regression.** An
  assertion that no event carries invalid model output failed on
  `model.response.text`, which has always carried the answer verbatim. That is by
  design — the tracer only prints it under `verbose`, and `redact()` catches
  key-shaped substrings before anything reaches a browser. The test was narrowed
  to what this step actually guarantees, and says so.

### Zero dependencies held

Nothing was added. `run/output.ts` is `JSON.parse`, a regex, and a hand-written
brace scanner; the validator stays an optional peer reached through Standard
Schema.

## Verified vs unverified

| Claim                                                     | How it was checked                                         | Result         |
| --------------------------------------------------------- | ---------------------------------------------------------- | -------------- |
| Lint, format, typecheck, test, build                      | `pnpm check` across 10 workspaces                          | pass           |
| The 348 step-3.5 tests still pass                         | unmodified                                                 | pass           |
| Type inference across 7 call shapes                       | printed the checker's inferred return type for each        | pass           |
| The loop body did not change                              | `git diff` — three one-line edits, no control flow         | pass           |
| A malformed answer is repaired                            | ran `pnpm example:structured`; `turn → repair`, severity 4 | pass           |
| Repairs do not multiply with transport retries            | `maxRetries: 3` + `maxOutputRetries: 2` → exactly 3 calls  | pass           |
| A run that never validated persists nothing               | store empty after `InvalidOutputError`                     | pass           |
| Tools and a schema compose                                | tool turn then typed answer; `['turn', 'turn']`            | pass           |
| A provider ignoring `responseFormat` still works          | prose + fenced answer, prompt fallback alone               | pass           |
| `rawText` stays out of `toJSON()` and the trace           | secret in the invalid answer; absent from both             | pass           |
| No `text.delta` with a schema                             | zero deltas, transport still streamed                      | pass           |
| Brace-in-a-string does not defeat the extractor           | `{"note":"use } sparingly"}` after a prose preamble        | pass           |
| **Real Postgres and real Redis**                          | not run — adapters tested against fakes                    | **unverified** |
| **Real streaming against a real model**                   | still not run — needs a key                                | **unverified** |
| **`strict: true` against a real OpenAI endpoint**         | offline-untestable; needs a key                            | **unverified** |
| **`responseFormat` on a turn the model wants a tool for** | pinned offline; the live interaction is untested           | **unverified** |

**Everything runnable without a key has been run**, including the new example's
repair and failure acts. What remains needs a key:

- **`pnpm example:stream`** — carried over from step 2. Step 1's live run found a
  bug all 66 offline tests missed.
- **`pnpm example:structured` act ①** — the mechanics are verified; what a live
  run adds is whether a real model honours the schema first time.
- **`pnpm example:sessions`, `example:server`, `example:resumable`** — verified
  offline; a live run confirms a real model uses the recalled context.

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
| 6   | Structured output + streaming | 10    | **done**    | `outputSchema`, repair, typed inference, HTTP/SSE/resumable streaming                      |
| 7   | Reliability                   | 10    | **done**    | Timeouts, cancellation, loop bounds, typed errors, retries, fallback, secret safety        |
| 8   | Tracing                       | 5     | **partial** | `steps[]` + 14 events + console tracer + an SSE feed; no JSON/OTel exporters               |
| 9   | Developer experience          | 10    | **done**    | Typed end to end, zero-config install, actionable errors, shipped test helpers             |
| 10  | Docs & examples               | 10    | **partial** | 16 pages + 7 runnable examples; 2 pages forward-looking; **not yet hosted**                |
| 11  | Product thinking              | 10    | **done**    | Differentiation is real and demonstrable                                                   |
| 12  | Demo & pitch                  | 10    | not started | Landing page done; **no video**                                                            |

**Roughly 100–110 of 120 addressable today.** The cheapest remaining marks, in
order: hosting the docs (category 10), the video (12), guardrails and handoffs
(3 + 4, and the largest block of unclaimed marks left).

---

## Next step — 5 of 8: guardrails & handoffs

Twenty marks across two categories, both largely unstarted, and the last
substantial runtime work before launch. `outputSchema` is the substrate the
output half builds on.

- [ ] **Input guardrails** — reject or rewrite a run's input before the first
      model call. Must be able to end the run without it counting as a failure.
- [ ] **Output guardrails** — run against the validated output, so they compose
      with `outputSchema` rather than re-parsing text.
- [ ] **Tool guardrails** — veto a specific tool call after arguments validate
      but before the handler runs. The seam already exists in `tools/execute.ts`.
- [ ] **Approval gates** — pause a run for a human decision and resume it. The
      hard part is that a paused run must survive a process exiting, which means
      leaning on the session and stream stores rather than holding a promise.
- [ ] **Handoffs** — delegate to another agent with the required context, cycle
      detection, and a `handoff.start` / `handoff.end` event pair so a trace
      shows the whole path.
- [ ] **Un-stub** [`guardrails.mdx`](../apps/web/content/docs/guardrails.mdx) and
      [`handoffs.mdx`](../apps/web/content/docs/handoffs.mdx).

### Acceptance

`pnpm check` green · an example where a guardrail blocks a dangerous tool call
and the run recovers · an example where two agents hand off and the trace shows
it · a cycle is detected rather than looping · the 386 existing tests pass
unmodified.

### Open design questions

1. **Is a guardrail a function or an object?** A function is simpler; an object
   can carry a name, which is what makes `guardrail.triggered` useful in a trace.
2. **Does a blocked run throw or return?** Invariant 2 says a completed run does
   not throw, and a guardrail firing is arguably a completion with a different
   `stopReason` — which would mean adding one.
3. **Where does approval state live?** A resumable run already records itself; an
   approval is the same problem viewed from the other end.

---

## Later steps

| Step | Scope                                                                                                                                                     |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6    | **Built-in tool pack** — HTTP fetch, sandboxed filesystem, calculator, web search                                                                         |
| 7    | **Native providers** — Anthropic Messages API and Gemini `generateContent` as siblings to the OpenAI transport (both can reuse `sse.ts`); trace exporters |
| 8    | **Launch** — host the docs, record the demo video, write the pitch                                                                                        |

---

## Outstanding manual setup

Only you can do these.

- [ ] **Publish 0.2.0.** `just-another-sdk@0.1.0` went up on 2026-08-01. Four
      changesets are pending, so `pnpm changeset version` bumps to 0.2.0 and
      writes the first `CHANGELOG.md`. Check that changelog before merging — it
      will fold in three entries from before 0.1.0 shipped.
- [ ] **Add `NPM_TOKEN`** to GitHub → Settings → Secrets → Actions, or
      [`release.yml`](../.github/workflows/release.yml) cannot publish. Use an
      **Automation** token; a classic one with 2FA-on-publish fails in CI. The
      0.1.0 release commit does not match the workflow's, so this may never have
      been set.
- [ ] **Uncomment `OPENROUTER_API_KEY` in `examples/.env`**, then run
      `pnpm example:stream`, `example:structured`, `example:sessions`,
      `example:server`, and `example:resumable`.
- [ ] **Point Vercel at `apps/web`** — [`vercel.json`](../apps/web/vercel.json)
      has the monorepo build command already. Then put the URL in
      [`README.md`](../README.md) and
      [`packages/core/package.json`](../packages/core/package.json) `homepage`.
- [ ] **Optional: verify Postgres and Redis against real servers.** A
      `docker compose` with both, and a `live`-style suite that skips without
      them, would close the last unverified adapter row.

---

## Maintaining this file

Rewrite it at the end of each step. Keep it **current state** — what is true
right now — and let git history carry the past. It is not a changelog
(`packages/core/CHANGELOG.md`) and not product documentation
(`apps/web/content/docs/`). If a claim here cannot be checked against the repo in
under a minute, it does not belong.
