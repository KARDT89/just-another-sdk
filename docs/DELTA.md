# Delta

**Where the project stands, what is deliberately missing, and what happens next.**

|         |                                                          |
| ------- | -------------------------------------------------------- |
| Step    | 1 of 8 — project foundation + working agent runtime      |
| Date    | 2026-08-01                                               |
| Commit  | `27ec46a`                                                |
| Package | `just-another-sdk@0.0.0` — **not yet published**         |
| Size    | 28 source files, ~3.8k lines, **0 runtime dependencies** |
| Tests   | 78 passing — 66 offline (~300ms) + 12 live               |

This file is rewritten at the end of every step. It is the current state of the
project, not a changelog — release history will live in
`packages/core/CHANGELOG.md` once changesets generates it at first publish, and
product documentation lives in the [docs site](../apps/web/content/docs).

---

## What is built

Grouped by the seam it occupies. Each area is independently extensible — the
point of step 1 was that nothing later requires a refactor.

### Agent runtime

| File                                                        | Does                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------- |
| [`run/runner.ts`](../packages/core/src/run/runner.ts)       | The loop. Model call → tool execution → repeat, bounded by `maxTurns` |
| [`run/run-state.ts`](../packages/core/src/run/run-state.ts) | The only mutable object in the hot path; created fresh per run        |
| [`run/result.ts`](../packages/core/src/run/result.ts)       | `RunResult`, `RunStep`, `StopReason`                                  |
| [`agent/agent.ts`](../packages/core/src/agent/agent.ts)     | `Agent` — immutable config, `.run()`, `.clone()`, `.withTools()`      |
| [`agent/types.ts`](../packages/core/src/agent/types.ts)     | `AgentConfig`, `RunOptions`, `AGENT_DEFAULTS`                         |

Three kinds of state are kept apart: `Agent` (configuration, process-lifetime,
safe to share across concurrent requests), `RunState` (one run), `Session`
(persisted — not built yet).

### Tools

| File                                                                          | Does                                                                           |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`tools/tool.ts`](../packages/core/src/tools/tool.ts)                         | `tool()` — handler input inferred from the schema; memoized JSON Schema        |
| [`tools/execute.ts`](../packages/core/src/tools/execute.ts)                   | Validate → deadline → invoke → wrap failures as recoverable results            |
| [`tools/registry.ts`](../packages/core/src/tools/registry.ts)                 | Name-indexed lookup; duplicate names rejected at construction                  |
| [`schema/standard-schema.ts`](../packages/core/src/schema/standard-schema.ts) | Any Standard Schema validator; lazy `import('zod')` for JSON Schema derivation |

The lazy import is what keeps Zod an **optional peer** while still working with
zero configuration — the reason the dependency count is 0.

### Providers

| File                                                                                    | Does                                                            |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [`providers/provider.ts`](../packages/core/src/providers/provider.ts)                   | The contract: one required method, `generate()`                 |
| [`providers/openai-compatible.ts`](../packages/core/src/providers/openai-compatible.ts) | `fetch`-based transport; all vendor-shaped code lives here only |
| [`providers/openrouter.ts`](../packages/core/src/providers/openrouter.ts)               | `openrouter('anthropic/claude-opus-5')`                         |
| [`providers/openai.ts`](../packages/core/src/providers/openai.ts)                       | `openai('gpt-5')` and `compatible()` for Groq, Ollama, vLLM, …  |

### Reliability

| File                                                          | Does                                                                    |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`errors/errors.ts`](../packages/core/src/errors/errors.ts)   | One `AgentError` hierarchy, 11 machine-readable codes, `retryable` flag |
| [`util/redact.ts`](../packages/core/src/util/redact.ts)       | Secret redaction for errors, events, and traces                         |
| [`util/stringify.ts`](../packages/core/src/util/stringify.ts) | Safe `unknown` → string, so tool output never becomes `[object Object]` |

### Observability

| File                                                                        | Does                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`events/events.ts`](../packages/core/src/events/events.ts)                 | The typed event union — 8 members                                 |
| [`events/emitter.ts`](../packages/core/src/events/emitter.ts)               | Synchronous bus; a throwing listener cannot break a run           |
| [`events/console-tracer.ts`](../packages/core/src/events/console-tracer.ts) | Ready-made readable trace, with redaction applied before printing |

### Testing (shipped to consumers)

| File                                                                            | Does                                                          |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`testing/mock-provider.ts`](../packages/core/src/testing/mock-provider.ts)     | Scripted offline provider — no key, no network, deterministic |
| [`testing/event-collector.ts`](../packages/core/src/testing/event-collector.ts) | Records a run's events for ordering assertions                |

The suite is split by what it can prove:

| Suite                                                                                                                                                                                                                              | Count | Needs a key                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------- |
| [`test/agent-loop.test.ts`](../packages/core/test/agent-loop.test.ts) · [`tools`](../packages/core/test/tools.test.ts) · [`provider`](../packages/core/test/provider.test.ts) · [`secrets`](../packages/core/test/secrets.test.ts) | 66    | no — runs in ~300ms                     |
| [`test/live.test.ts`](../packages/core/test/live.test.ts)                                                                                                                                                                          | 12    | yes — skipped automatically without one |

The live suite reads `OPENROUTER_API_KEY` from the environment or falls back to
[`examples/.env`](../examples), so `pnpm test` picks it up locally and skips in CI.
It covers what a mock cannot: real wire format, real tool-call round-trips, and
real provider error mapping.

### Everything else

- **Site** — [`apps/web`](../apps/web): Next 16 + Fumadocs + shadcn/ui, terminal-styled
  landing page, 11 written doc pages, 5 marked not-yet-shipped, search, `llms.txt`.
- **Examples** — [`examples/01-hello-agent`](../examples/01-hello-agent),
  [`examples/02-tool-calling`](../examples/02-tool-calling) (parallel tools,
  failure recovery, tracing, multi-turn).
- **CI** — [`.github/workflows/ci.yml`](../.github/workflows/ci.yml): format, lint,
  typecheck, test, build, publint, attw, **plus** installing the packed tarball
  into a clean project and asserting it has zero dependencies.
- **Release** — [`.github/workflows/release.yml`](../.github/workflows/release.yml):
  changesets → `npm publish` with provenance.

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

---

## Verified vs unverified

| Claim                                | How it was checked                                    | Result                      |
| ------------------------------------ | ----------------------------------------------------- | --------------------------- |
| Lint, format, typecheck, test, build | `pnpm check`                                          | pass                        |
| Package metadata and exports map     | `publint`                                             | no issues                   |
| Types resolve for consumers          | `attw --pack . --profile node16`                      | pass                        |
| Installs with zero dependencies      | packed tarball → clean project → `npm ls`             | 0 deps                      |
| ESM entry works                      | 6 behavioural assertions against the tarball          | pass                        |
| CJS entry + `.d.cts` types           | compiled with `tsc --module node16` and executed      | pass                        |
| Only intended files ship             | `npm pack` → 38 files: `dist/`, README, LICENSE       | pass                        |
| Missing-key failure path             | ran both examples with no key                         | clear `configuration_error` |
| Landing page and docs render         | headless screenshots of `/`, `/docs`, 2 doc pages     | pass                        |
| **Real model calls**                 | 12 live tests + both examples on `openai/gpt-4o-mini` | pass                        |

Nothing material is unverified any more. Against a real model rather than a mock,
the live run confirmed: parallel tool calls executing concurrently (122ms and 60ms
overlapping in a single turn), a tool throwing a 503 and the model answering
anyway, multi-turn context retention, a real 401 mapped to `AuthenticationError`
with no key material in it, `maxTurns` halting a model instructed to loop forever,
a forced `toolChoice` overriding what the prompt asked for, and mid-flight
cancellation.

> **The live run found a bug that all 66 offline tests missed.** A whole-run
> `timeoutMs` surfaced as `network_error` instead of `timeout_error`. The runner
> aborts its signal with a `TimeoutError` as the reason, and real `fetch` rejects
> with that reason object — whose `name` is `'TimeoutError'`, not `'AbortError'` —
> so the abort-shape check misclassified it and the caller was told to check their
> network connection. Fixed in
> [`openai-compatible.ts`](../packages/core/src/providers/openai-compatible.ts) by
> passing an already-typed `AgentError` straight through, and pinned by two offline
> tests that reject with `signal.reason` the way real `fetch` does. The new timeout
> test was confirmed to fail without the fix.
>
> This is the case for keeping the live suite: the mock provider rejected with a
> generic `AbortError`, which is exactly the shape the buggy code handled
> correctly.

---

## Decisions that changed during step 1

Each of these contradicts the original plan, so the reason is recorded.

| Changed                             | To                                     | Why                                                                                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Biome                               | **ESLint 10 + Prettier**               | Your call. Web pinned to ESLint **9** because `eslint-config-next`'s plugin transitives don't support 10 yet                                                                                                                           |
| Plain pnpm scripts                  | **Turborepo**                          | Your call. Task graph + caching across the three workspaces                                                                                                                                                                            |
| TypeScript 7.0.2                    | **6.0.3**                              | `typescript-eslint@8` peers `>=4.8.4 <6.1.0`. 6.0.3 is the newest version it supports — the earlier "must use 5.9" call was wrong                                                                                                      |
| `StopReason` with 4 members         | **2** (`'finish'`, `'max_turns'`)      | Cancellation and tool-throws reject rather than return, so `'error'` and `'aborted'` were unreachable. A type that lies is worse than a narrow one                                                                                     |
| ESLint `files: 'packages/*/src/**'` | **`'**/src/**'`**                      | Flat-config globs resolve against **cwd**. When each package lints itself from its own directory the anchored pattern matched nothing, silently linting the library with weaker untyped rules. Found with a deliberate-violation probe |
| `LICENSE` listed in `files`         | **actually added** to `packages/core/` | It was declared but absent, so it wasn't shipping in the tarball                                                                                                                                                                       |

---

## Progress against the brief

Mapped to the 12 graded categories in [`CLAUDE.md`](../CLAUDE.md).

| #   | Category                      | Marks | State       | What's missing                                                                                                           |
| --- | ----------------------------- | ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | Agent runtime                 | 15    | **done**    | —                                                                                                                        |
| 2   | Tools                         | 10    | **done**    | Built-in tool pack (step 6) is additive, not required here                                                               |
| 3   | Handoffs                      | 10    | not started | Step 5                                                                                                                   |
| 4   | Guardrails                    | 10    | **partial** | Schema validation + `onToolError` cover tool safety and controlled failure; no declarative guardrails, no approval gates |
| 5   | Memory & sessions             | 10    | **partial** | Multi-turn works via `messages`; no persistence, no storage adapters, no context management                              |
| 6   | Structured output + streaming | 10    | **partial** | Event stream done; no `text.delta` emission, no iterator, no `outputSchema`                                              |
| 7   | Reliability                   | 10    | **partial** | Timeouts, cancellation, loop bounds, typed errors, secret safety all done; **no automatic retries or fallback**          |
| 8   | Tracing                       | 5     | **partial** | `steps[]` + events + console tracer done; no JSON/OTel exporters                                                         |
| 9   | Developer experience          | 10    | **done**    | Typed API, zero-config install, actionable errors, shipped test helpers                                                  |
| 10  | Docs & examples               | 10    | **partial** | 11 pages + 2 runnable examples done; 5 pages stubbed; **not yet hosted**                                                 |
| 11  | Product thinking              | 10    | **done**    | Differentiation is real and demonstrable, not just claimed                                                               |
| 12  | Demo & pitch                  | 10    | not started | Landing page done; **no video**                                                                                          |

**Roughly 60–70 of 120 addressable today.** The cheapest remaining marks, in
order: hosting the docs (category 10), retries + fallback (7), the video (12).

---

## Next step — 2 of 8: streaming & reliability

Two categories move at once because they share the same seam: both wrap the model
call inside [`run/runner.ts`](../packages/core/src/run/runner.ts).

### Streaming

- [ ] **`ModelProvider.stream?()` for the OpenAI-compatible transport** —
      SSE parsing in
      [`providers/openai-compatible.ts`](../packages/core/src/providers/openai-compatible.ts),
      yielding the `ModelStreamChunk` union that already exists in
      [`provider.ts`](../packages/core/src/providers/provider.ts).
      Handle partial `tool_calls` deltas (arguments arrive fragmented).
- [ ] **`agent.stream(input, options)`** — new `packages/core/src/run/stream.ts`,
      returning an async-iterable that also resolves to `RunResult` when awaited.
      Emits the `text.delta` member already declared in
      [`events/events.ts`](../packages/core/src/events/events.ts).
- [ ] **Fall back to `generate()`** when a provider has no `stream()`, so
      streaming is never a hard requirement for a custom provider.
- [ ] **Tests** — `mockProvider` gains a `textChunks` field; assert deltas
      concatenate to the final text, that ordering is
      `run.start → text.delta* → model.response`, and that a non-streaming
      provider still works through `agent.stream()`.
- [ ] **Un-stub** [`docs/streaming.mdx`](../apps/web/content/docs/streaming.mdx) —
      it already documents the intended API, so delete the warning callout and
      correct anything the implementation changed.

### Reliability

- [ ] **Retries with backoff + jitter** — new
      `packages/core/src/run/retry.ts`, driven by the existing `retryable` flag
      and `RateLimitError.retryAfterMs`. Config: `maxRetries` (default 2),
      `retryDelayMs`, `retryOn`.
- [ ] **Model fallback chains** — `fallbacks: ModelProvider[]` on `AgentConfig`;
      exhaust retries on the primary, then move down the chain. Record which
      model served each turn (`RunStep` already carries `modelId`).
- [ ] **New events** — `model.retry` and `model.fallback`, added to the
      `AgentEvent` union so traces show what happened.
- [ ] **Tests** — retry on 429 then succeed; give up after `maxRetries`; never
      retry a 401; fall back after the primary is exhausted; cancellation aborts
      mid-backoff rather than sleeping it out.
- [ ] **Update** [`docs/errors.mdx`](../apps/web/content/docs/errors.mdx) —
      replace the hand-rolled retry loop with the config option.

### Acceptance

`pnpm check` green · `pnpm example:tools` prints tokens as they arrive · a
provider without `stream()` still works via `agent.stream()` · a 429 is retried
without user code · all three invariants still hold, proven by the existing
78 tests continuing to pass unmodified.

### Open design questions

1. **Backpressure** — what happens when a consumer reads slower than the model
   produces. Buffer, or apply pressure to the provider?
2. **Tool interleaving** — does tool execution pause streamed text, or run
   alongside it?
3. **Partial tool calls** — surface fragmented arguments as they arrive, or only
   completed calls? Simpler to withhold; less useful for a live UI.
4. **Retry scope** — per model call (simple) or per run (needs replay)?

---

## Later steps

| Step | Scope                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3    | **Sessions & memory** — `SessionStore` interface + in-memory, file, SQLite, Redis adapters; context-window trimming and summarization                               |
| 4    | **Structured output** — `outputSchema` on `AgentConfig`, provider-native JSON Schema where available, repair-retry, `InvalidOutputError`                            |
| 5    | **Guardrails & handoffs** — input/output/tool guardrails, approval gates (needs serializable run state from step 3), agent-to-agent delegation with cycle detection |
| 6    | **Built-in tool pack** — HTTP fetch, sandboxed filesystem, calculator, web search; a curated set so nobody starts from nothing                                      |
| 7    | **Native providers** — Anthropic Messages API and Gemini `generateContent` as sibling files to the OpenAI transport; trace exporters (JSON, OTel)                   |
| 8    | **Launch** — host the docs, publish `0.1.0`, record the demo video, write the pitch                                                                                 |

---

## Outstanding manual setup

Only you can do these.

- [ ] **Publish `0.0.0`** to lock the npm name. `just-another-sdk` is free today,
      but `zero-sdk` being taken while `zerosdk` was free shows how fast that
      changes. `cd packages/core && npm publish --access public`
- [ ] **Add `NPM_TOKEN`** to GitHub → Settings → Secrets → Actions, or the release
      workflow cannot publish.
- [ ] **Point Vercel at `apps/web`** — [`vercel.json`](../apps/web/vercel.json) has
      the monorepo build command already. Then put the URL in
      [`README.md`](../README.md) and
      [`packages/core/package.json`](../packages/core/package.json) `homepage`.
- [x] **Run the live example** — done; 12 live tests now cover it.

---

## Maintaining this file

Rewrite it at the end of each step. Keep it **current state** — what is true
right now — and let git history carry the past. It is not a changelog
(`packages/core/CHANGELOG.md`) and not product documentation
(`apps/web/content/docs/`). If a claim here cannot be checked against the repo in
under a minute, it does not belong.
