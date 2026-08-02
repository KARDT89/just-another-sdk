# Delta

**Where the project stands, what is deliberately missing, and what happens next.**

|         |                                                           |
| ------- | --------------------------------------------------------- |
| Step    | 6 of 8 — handoffs                                         |
| Date    | 2026-08-02                                                |
| Package | `just-another-sdk@0.2.0` — **published**; 0.3.0 pending   |
| Size    | 54 source files, ~11.2k lines, **0 runtime dependencies** |
| Tests   | 461 — 449 offline (~2.2s) + 12 live                       |

This file is rewritten at the end of every step. It is the current state of the
project, not a changelog — release history lives in
`packages/core/CHANGELOG.md`, and product documentation lives in the
[docs site](../apps/web/content/docs).

---

## What is built

Grouped by the seam it occupies. Step 1 built the loop, step 2 wrapped the model
call inside it, step 3 wrapped the loop itself, step 3.5 wrapped the result so it
could reach a browser, step 4 wrapped the _answer_, step 5 wrapped the whole
thing in **policy**. Step 6 changed **who is inside the loop**.

That last one is the honest framing, and it is the first step since step 1 to
touch the loop body meaningfully — see [Decisions](#decisions-made-in-step-6).

### Agent runtime

| File                                                                  | Does                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`run/runner.ts`](../packages/core/src/run/runner.ts)                 | The loop. Model call → tool execution → repeat, bounded by `maxTurns`        |
| [`run/runner.ts`](../packages/core/src/run/runner.ts) · `ActiveAgent` | Everything the loop needs from whichever agent is holding the run            |
| [`run/model-call.ts`](../packages/core/src/run/model-call.ts)         | Stream-vs-generate dispatch, the retry loop, the fallback chain              |
| [`run/run-state.ts`](../packages/core/src/run/run-state.ts)           | The only mutable object in the hot path; created fresh per run               |
| [`run/result.ts`](../packages/core/src/run/result.ts)                 | `RunResult`, `RunStep`, `StopReason`                                         |
| [`agent/agent.ts`](../packages/core/src/agent/agent.ts)               | `Agent` — `.run()`, `.stream()`, `.session()`, `.clone()`, `.withHandoffs()` |
| [`agent/types.ts`](../packages/core/src/agent/types.ts)               | `AgentConfig`, `RunOptions`, `AGENT_DEFAULTS`                                |

### Handoffs

| File                                                                        | Does                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`handoffs/types.ts`](../packages/core/src/handoffs/types.ts)               | `HandoffTarget`, `HandoffSpec`, `HandoffRefusal` — plain data               |
| [`handoffs/handoff.ts`](../packages/core/src/handoffs/handoff.ts)           | Resolve targets, synthesize the transfer tool, repair a filtered transcript |
| [`run/runner.ts`](../packages/core/src/run/runner.ts) · `decideHandoff`     | The three limits, applied to a turn's transfer calls                        |
| [`run/runner.ts`](../packages/core/src/run/runner.ts) · `applyHandoff`      | The switch: resolve, narrow, brief, emit — shared with the resume prologue  |
| [`run/run-state.ts`](../packages/core/src/run/run-state.ts) · `switchAgent` | `agentPath`, the depth counter, and the view log                            |

### Structured output

| File                                                                          | Does                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [`run/output.ts`](../packages/core/src/run/output.ts)                         | Pure: schema resolution, the prompt instruction, JSON extraction, repair prompt |
| [`run/runner.ts`](../packages/core/src/run/runner.ts) · `finalizeOutput`      | Validate the final answer, emit, repair, throw — all _outside_ the loop         |
| [`schema/standard-schema.ts`](../packages/core/src/schema/standard-schema.ts) | `SchemaSubject`, so a conversion failure names the right thing                  |

### Guardrails & approval

| File                                                                      | Does                                                                    |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`guardrails/types.ts`](../packages/core/src/guardrails/types.ts)         | Verdicts, the three kinds, and the approval suspension — all plain data |
| [`guardrails/apply.ts`](../packages/core/src/guardrails/apply.ts)         | Input and output guardrails, sequential, failing closed                 |
| [`tools/execute.ts`](../packages/core/src/tools/execute.ts)               | prepare → invoke, so a gated turn runs nothing                          |
| [`run/runner.ts`](../packages/core/src/run/runner.ts) · `settleApprovals` | The resume prologue: re-check, apply decisions, execute, or re-suspend  |

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
| [`errors/errors.ts`](../packages/core/src/errors/errors.ts)   | One `AgentError` hierarchy, 14 machine-readable codes, `retryable` flag |
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
| [`events/events.ts`](../packages/core/src/events/events.ts)                 | The typed event union — **19** members                            |
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
| `guardrails`                                    | 40    | no                                      |
| `structured-output`                             | 37    | no                                      |
| `handoffs`                                      | 35    | no                                      |
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
   that calls tools forever costs `maxTurns` requests, not an afternoon. A chain
   of agents costs the same, because `maxTurns` is a budget for the **run**.
2. **A completed run never throws** — with a documented and closed list of
   exceptions: cancellation, provider failure, `onToolError: 'throw'`,
   `InvalidOutputError`, `GuardrailError`, and `ApprovalRequiredError`. Tool
   failures are still recoverable results, and so are a **guardrail-blocked tool
   call** and a **refused handoff** — only input and output rejections throw.
3. **Every turn is recorded.** `steps`, `usage`, and `messages` are complete even
   when a run stops early — so tracing is a formatter over existing data. A
   repair is a model call, so it is a step; it is not a turn, so it does not
   count against `maxTurns`. The same is true of a resume. Each step names the
   agent that took it.
4. **A streamed run and a normal run are the same run.** Same loop, same
   ordering, same `RunResult`. Only the source of the text differs. A handoff did
   not change this, because a handoff is not a new run.
5. **Only a completed run is persisted.** A run that threw mid-turn can leave an
   assistant message holding tool calls whose results never arrived; every
   provider rejects that on the next request. `max_turns` is a completion and
   does save. A run whose output never validated does **not**.

---

## Decisions made in step 6

All three of step 5's open questions are answered, and the handoffs page was
revised against what it had committed to — consciously, with the reason written
into the page itself.

| Question                                  | Answer                              | Why                                                                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Replace the run, or nest inside it?**   | Flat — one run, `agentPath`         | A nested run means two `runId`s, two event streams to merge for `stream()`, two session saves to reconcile, and `maxTurns` threaded by hand. Invariant 4 survives only because there is one run      |
| **`max_handoffs`: stop reason or error?** | **Neither** — refuse the call       | The committed doc promised a `StopReason`. Both alternatives discard a run whose conversation is valid and whose current agent could answer. Refusing the _call_ leaves invariants 1 and 2 untouched |
| **Whose `outputSchema` wins?**            | The initiator's                     | `triage.run<Ticket>()` returning whatever the specialist happened to declare makes `RunResult<T>` a lie. The _instruction_ still follows the acting agent, so the specialist is told the shape       |
| **`handoff.end`?**                        | Dropped                             | A flat handoff is a transition, not a span. The receiving agent holds the run until it ends or transfers onward, so the only honest close is `run.finish` — which now carries `agentPath`            |
| **Where do the limits live?**             | After execution, before the results | The transfer tool has no side effect, so "run it then refuse it" costs nothing and keeps the limit checks out of `executeToolCalls` entirely                                                         |

Three traps the design is built around, each with a test that fails without it:

- **The `onToolError: 'throw'` trap, again.** A refused transfer sets no `error`
  on the outcome, exactly as a guardrail rejection does not. Someone who set that
  flag so a broken database aborts the run must not lose the run to a routing
  policy. Tested under both policies.
- **The approval-resume trap.** `settleApprovals` runs _before_ the loop. If the
  approved call was a transfer and nothing applied it, the human says yes, the
  tool result says "transferred to billing", and triage answers the question it
  just delegated. It returns the accepted handoff so both it and the loop go
  through one `applyHandoff`.
- **The filter-as-deletion trap.** A `filter` narrows `state.view`; the session
  save and `RunResult.messages` read `state.messages`. Two accessors instead of
  one, because otherwise delegation becomes a way to erase a user's history.
  Tested with `filter: () => []` and a real store.

Things the plan did not anticipate:

- **The loop body genuinely changed this time.** Steps 2–5 could each claim they
  left it alone; this one cannot. Nine hoisted `const`s above the loop all had to
  become per-agent, and a loop reading nine variables that must be swapped in
  lockstep is a loop with nine chances to swap eight of them. They are one
  `ActiveAgent` record now, resolved lazily and memoized per config. The 426
  existing tests were the canary for that substitution and passed unmodified.
- **`RunState` grew a second log.** `viewLog` stays `undefined` until a _filtered_
  handoff happens, so the default path allocates nothing and behaves exactly as
  before. `replaceFinalText` patches the view by object identity rather than by
  index, because after a filter the two logs are not aligned.
- **`repairPairing` needed a second pass.** Dropping orphaned tool results can
  _create_ the other illegal shape — an assistant turn whose calls are now
  unanswered. The fix keeps the turn's text and drops only the dangling calls.
- **`maxHandoffs` resets across a suspension.** A suspension carries messages, not
  counters. Cycle detection is unaffected because it reads the route, which is
  reconstructed from the conversation. Documented rather than papered over.

### Zero dependencies held

Nothing added. The transfer tool's parameters are written as raw JSON Schema
precisely because the SDK cannot import a validator to describe its own single
optional string.

## Verified vs unverified

| Claim                                                           | How it was checked                                                 | Result         |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | -------------- |
| Lint, format, typecheck, test, build                            | `pnpm check` across 12 workspaces                                  | pass           |
| **The 426 step-5 tests still pass**                             | unmodified — the canary for the `ActiveAgent` substitution         | pass           |
| Two agents transfer; the receiver's model, tools, prompt serve  | `steps[].modelId` is `triage, billing, billing`                    | pass           |
| A cycle is refused rather than followed                         | `A → B → A`; the refusal names the route                           | pass           |
| `maxHandoffs` refuses the call, and the run still answers       | `stopReason: 'finish'`, `handoff_refused` in the result            | pass           |
| A refusal finishes under **both** `onToolError` policies        | same script, both policies                                         | pass           |
| Two transfers in one turn → first wins, second refused          | `already_transferring`, one `handoff.start`                        | pass           |
| `maxTurns` is shared, not per agent                             | `maxTurns: 3` across a chain → `turns === 3`                       | pass           |
| A transfer is gated by the routing agent's tool guardrails      | rejected; the specialist's model never called                      | pass           |
| **An approved transfer takes effect on resume**                 | `agentPath` is `['triage','billing']` after `resumeApproval`       | pass           |
| A denied transfer leaves the router holding the conversation    | specialist's model never called                                    | pass           |
| A suspension survives `JSON.stringify` → `parse`                | resumed from the re-parsed object                                  | pass           |
| A `filter` narrows the request and **nothing else**             | `filter: () => []`; the store still holds the transcript           | pass           |
| A filter that orphans a tool result is repaired                 | no `tool` message reaches the provider                             | pass           |
| The initiator's `outputSchema` governs; the target's is ignored | plus the instruction reaching the receiver's system prompt         | pass           |
| `handoff.start` sits between `tool.end` and the next request    | full ordering assertion                                            | pass           |
| `agentPath` arrives identically through `stream()`              | iterated the events                                                | pass           |
| An unreached handoff target is never resolved                   | its `instructions` thunk was never called                          | pass           |
| The example runs with no API key at all                         | ran it; all four acts                                              | pass           |
| **Real Postgres and real Redis**                                | not run — adapters tested against fakes                            | **unverified** |
| **Real streaming against a real model**                         | still not run — needs a key                                        | **unverified** |
| **A handoff against a real model**                              | offline only; whether models _choose_ to transfer well is untested | **unverified** |
| **`strict: true` against a real OpenAI endpoint**               | offline-untestable; needs a key                                    | **unverified** |

> **What the offline suite cannot tell you about handoffs.** Every mechanical
> property above is real. Whether a router _decides well_ — whether the
> synthesized description is enough for a model to pick the right specialist — is
> a prompt-quality question that a scripted provider cannot answer. The first
> live run of `example:handoffs` against a real model is the test that matters,
> and it has not happened.

---

## Progress against the brief

Mapped to the 12 graded categories in [`CLAUDE.md`](../CLAUDE.md).

| #   | Category                      | Marks | State       | What's missing                                                                      |
| --- | ----------------------------- | ----- | ----------- | ----------------------------------------------------------------------------------- |
| 1   | Agent runtime                 | 15    | **done**    | —                                                                                   |
| 2   | Tools                         | 10    | **done**    | Built-in tool pack (step 7) is additive                                             |
| 3   | Handoffs                      | 10    | **done**    | Delegation, context transfer, three limits, events, docs, a runnable example        |
| 4   | Guardrails                    | 10    | **done**    | Input, output, tool, approval gates, and a fail-closed rule                         |
| 5   | Memory & sessions             | 10    | **done**    | 5 adapters, windowed reads, undo, trimming, summarization, events                   |
| 6   | Structured output + streaming | 10    | **done**    | `outputSchema`, repair, typed inference, HTTP/SSE/resumable streaming               |
| 7   | Reliability                   | 10    | **done**    | Timeouts, cancellation, loop bounds, typed errors, retries, fallback, secret safety |
| 8   | Tracing                       | 5     | **partial** | `steps[]` + 19 events + console tracer + an SSE feed; no JSON/OTel exporters        |
| 9   | Developer experience          | 10    | **done**    | Typed end to end, zero-config install, actionable errors, shipped test helpers      |
| 10  | Docs & examples               | 10    | **partial** | 17 pages + 9 runnable examples, none forward-looking; **not yet hosted**            |
| 11  | Product thinking              | 10    | **done**    | Differentiation is real and demonstrable                                            |
| 12  | Demo & pitch                  | 10    | not started | Landing page done; **no video**                                                     |

**Roughly 115–120 of 120 addressable today.** Everything left is launch work:
hosting the docs (category 10) and the video (12).

---

## Next step — 7 of 8: the built-in tool pack

The last additive runtime work. Nothing in it changes the loop; the point is that
`npm i just-another-sdk` should give a developer something to _do_ on the first
afternoon rather than a set of interfaces to implement.

- [ ] **`fetchTool`** — HTTP with an allowlist, a size cap, and a redirect bound.
      Dangerous by default is the whole risk here; it ships locked down.
- [ ] **`fileTools`** — read/write/list rooted at a directory, with traversal
      refused rather than normalised away.
- [ ] **`calculator`** — expression evaluation with no `eval`, no `Function`.
- [ ] **`webSearch`** — provider-injected, like the Redis and Postgres adapters,
      so the pack stays at zero dependencies.
- [ ] Ship them from `just-another-sdk/tools`, each composable with the
      `toolGuardrails` that already exist.

### Acceptance

`pnpm check` green · every tool has a failure test as well as a success one ·
the sandbox tools have an escape test that must fail to escape · zero new runtime
dependencies · the 461 existing tests pass unmodified.

### Open design questions

1. **Does `fetchTool` allowlist by default, or refuse without configuration?**
   Refusing is safer and worse to demo; an allowlist of nothing is the same thing
   with a friendlier error.
2. **Is the pack one import or four?** One is easier to show; four is easier to
   tree-shake, and a filesystem tool in an edge bundle is dead weight.
3. **Do these ship in core or a second package?** A second package keeps core's
   surface honest but doubles the release process for a solo maintainer.

---

## Later steps

| Step | Scope                                                              |
| ---- | ------------------------------------------------------------------ |
| 8    | **Launch** — host the docs, record the demo video, write the pitch |

---

## Outstanding manual setup

Only you can do these.

- [ ] **Publish 0.3.0 by hand.** One changeset is pending. `pnpm changeset version`
      bumps to 0.3.0 and writes the changelog; `pnpm release` builds and publishes,
      prompting for an OTP.
- [ ] **The release workflow still cannot publish.** Both attempts failed with
      `ERR_PNPM_OTP_NON_INTERACTIVE`: the npm account is set to
      `two-factor auth: auth-and-writes`, so a stored `NPM_TOKEN` can never
      satisfy the registry on its own. **0.1.0 and 0.2.0 were both pushed by
      hand.** The workflow's `version` half works — it opened and merged the
      "Version Packages" PR — only `publish` fails. Three ways out, best first:
      **npm Trusted Publishing (OIDC)**, which bypasses 2FA and stores no token
      (the workflow already requests `id-token: write`, but whether pnpm 11.15
      drives it is unverified); a **Granular Access Token** with 2FA bypass,
      which npm is restricting; or relaxing the account to
      `two-factor auth: auth-only`, which weakens the account to fix CI.
- [ ] **Delete the stale branch** left by the failed run:
      `git push origin --delete changeset-release/main`.
- [ ] **Uncomment `OPENROUTER_API_KEY` in `examples/.env`**, then run
      `pnpm example:stream`, `example:structured`, `example:sessions`,
      `example:server`, and `example:resumable`. `example:guardrails` and
      `example:handoffs` need no key.
- [ ] **Run `example:handoffs` against a real model once.** Swap the mocks for
      `openrouter(...)` and check the router actually picks the right specialist.
      It is the only claim in this file the offline suite cannot make.
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
