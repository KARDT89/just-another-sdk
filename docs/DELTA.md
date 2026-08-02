# Delta

**Where the project stands, what is deliberately missing, and what happens next.**

|         |                                                           |
| ------- | --------------------------------------------------------- |
| Step    | 5 of 8 — guardrails & approval gates                      |
| Date    | 2026-08-02                                                |
| Package | `just-another-sdk@0.1.0` — **published**; 0.2.0 pending   |
| Size    | 52 source files, ~10.4k lines, **0 runtime dependencies** |
| Tests   | 426 — 413 offline (~2.2s) + 13 live                       |

This file is rewritten at the end of every step. It is the current state of the
project, not a changelog — release history lives in
`packages/core/CHANGELOG.md`, and product documentation lives in the
[docs site](../apps/web/content/docs).

---

## What is built

Grouped by the seam it occupies. Step 1 built the loop, step 2 wrapped the model
call inside it, step 3 wrapped the loop itself, step 3.5 wrapped the result so it
could reach a browser, step 4 wrapped the _answer_. Step 5 wrapped the whole
thing in **policy**: three places to refuse, and one place to ask a person.
**The loop body has not changed since step 1** — this step touched exactly one
line inside it, and it is not control flow.

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
| [`events/events.ts`](../packages/core/src/events/events.ts)                 | The typed event union — **17** members                            |
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
2. **A completed run never throws** — with a documented and closed list of
   exceptions: cancellation, provider failure, `onToolError: 'throw'`,
   `InvalidOutputError`, `GuardrailError`, and `ApprovalRequiredError`. Tool
   failures are still recoverable results, and so is a **guardrail-blocked tool
   call** — only input and output rejections throw.
3. **Every turn is recorded.** `steps`, `usage`, and `messages` are complete even
   when a run stops early — so tracing is a formatter over existing data. A
   repair is a model call, so it is a step; it is not a turn, so it does not
   count against `maxTurns`. The same is true of a resume, which replays tool
   calls a suspended run left outstanding.
4. **A streamed run and a normal run are the same run.** Same loop, same
   ordering, same `RunResult`. Only the source of the text differs.
5. **Only a completed run is persisted.** A run that threw mid-turn can leave an
   assistant message holding tool calls whose results never arrived; every
   provider rejects that on the next request. `max_turns` is a completion and
   does save. A run whose output never validated does **not**.

---

## Decisions made in step 5

All three of step 4's open questions are answered, and the two "Intended API"
sketches in the docs were revised — consciously, and with the reasons written
into the pages themselves.

| Question                                    | Answer                                 | Why                                                                                                                                                                                                           |
| ------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Function or object?**                     | Named object                           | The brief requires "guardrail triggered" in a trace, and `guardrail #1` is useless in production. `tool()` set the precedent. A name also makes a `tools` filter checkable at construction                    |
| **Does a blocked run throw or return?**     | Throw — and `StopReason` gains nothing | Step 4's precedent applied literally: a `RunResult<Ticket>` with no ticket is the lie `InvalidOutputError` exists to prevent. Throwing also gave `stream()`, `session()`, and `resumable()` approval for free |
| **Where does approval state live?**         | Nowhere — the suspension is plain JSON | No `ApprovalStore`, no adapter per backend, and nothing written mid-run, so invariant 5 needs no special case                                                                                                 |
| **`toolGuardrails`: record or array?**      | Array with a `tools` filter            | A record cannot say "every tool", its keys are tool names rather than guardrail names, and a key naming a nonexistent tool is a **silent no-op that fails open**                                              |
| **Resume method name**                      | `resumeApproval`                       | `agent.resume(streamId)` already means re-attaching a reader to a recorded stream. The committed doc had not noticed                                                                                          |
| **Can a tool guardrail rewrite arguments?** | No                                     | The seam sits _after_ the schema so the values are trustworthy; writing back would bypass it or need a second validation pass. Clamping belongs in the schema                                                 |

Three traps the design is built around, each with a test that fails without it:

- **The `onToolError: 'throw'` trap.** The runner throws on any `outcome.error`
  under that flag. A guardrail rejection that set it would abort the run for
  anyone using it — so a rejection sets `blockedBy` instead and leaves `error`
  undefined. Tested under both policies.
- **Double execution.** A turn holding two tool calls where only one is gated
  would run the ungated one, suspend, and run it _again_ on resume. Fixed by
  splitting `executeToolCalls` into prepare and invoke with a barrier: if any
  call needs a human, none run. The test asserts handler call counts, not just
  outcomes.
- **Approval replay.** Only the resume prologue reads `options.approvals`; the
  in-loop gate never does. An approval authorises one call, by id, once — a
  property of the code shape rather than a check that can rot. Tested by having
  the model call the same gated tool twice.

Things the plan did not anticipate:

- **A resume must not demand a decision for every outstanding call.** The first
  implementation required one per tool call in the suspended turn, so an ungated
  call sitting beside a gated one re-suspended forever. The fix is smaller than
  the bug: hand everything not explicitly denied back to `executeToolCalls` with
  a gate that downgrades `requireApproval` only for approved ids. Ungated calls
  run, approved calls run, undecided ones re-suspend through the ordinary path,
  and rejections still reject. Caught by the two-parallel-calls test.
- **`RunState` gained its first mutating method.** `replaceFinalText` edits the
  log rather than appending to it, which no other code in the SDK does. It earns
  the exception: an output guardrail that scrubs PII has to scrub it from
  `messages` too, or the session stores the original and hands it back next turn.
  It updates the matching step's text as well, so `steps` and `messages` cannot
  drift.

### Zero dependencies held

Nothing added. The guardrail module is types plus two loops.

## Verified vs unverified

| Claim                                                         | How it was checked                                        | Result         |
| ------------------------------------------------------------- | --------------------------------------------------------- | -------------- |
| Lint, format, typecheck, test, build                          | `pnpm check` across 11 workspaces                         | pass           |
| The 386 step-4 tests still pass                               | unmodified — `tools.test.ts` was the canary for the split | pass           |
| **The loop body changed by exactly one line**                 | diffed the `while` block against `HEAD` programmatically  | pass           |
| An input rejection costs zero model calls                     | `model.calls.length === 0`                                | pass           |
| A guardrail that throws fails closed                          | becomes `GuardrailError`, model never called              | pass           |
| A blocked tool call finishes under **both** `onToolError`     | same script, both policies, both `stopReason: 'finish'`   | pass           |
| Two parallel calls, one gated → neither ran                   | handler spies; after resume each ran exactly once         | pass           |
| A suspension survives `JSON.stringify` → `parse`              | resumed from the re-parsed object                         | pass           |
| An approval cannot override a `reject`                        | second guardrail rejects; handler never invoked           | pass           |
| A re-called gated tool suspends again                         | approval is not standing permission                       | pass           |
| An unknown `toolCallId` fails loud                            | `ConfigurationError` listing the expected ids             | pass           |
| A suspended run persists nothing; a resumed one persists once | store empty, then exactly four messages                   | pass           |
| An output rewrite reaches output, text, messages, store       | plus the matching `RunStep.text`                          | pass           |
| A guardrail sees coerced, validated tool arguments            | `z.coerce.number()` — guardrail saw `42`, not `'42'`      | pass           |
| `ApprovalRequiredError.toJSON()` omits the conversation       | distinctive user message absent from the log-safe form    | pass           |
| Suspension works identically through `stream()`               | `approval.required` in the iterated events                | pass           |
| The example runs with no API key at all                       | ran it; all four acts                                     | pass           |
| **Real Postgres and real Redis**                              | not run — adapters tested against fakes                   | **unverified** |
| **Real streaming against a real model**                       | still not run — needs a key                               | **unverified** |
| **`strict: true` against a real OpenAI endpoint**             | offline-untestable; needs a key                           | **unverified** |
| **`responseFormat` on a turn the model wants a tool for**     | pinned offline; the live interaction is untested          | **unverified** |

> **What stateless approval does not do.** It cannot _authenticate_ a decision —
> that needs a shared secret or a store, and it has neither. The four structural
> properties above are real; replay of a captured `{ suspension, decisions }`
> payload against your own endpoint is your transport's problem, and the docs say
> so rather than implying otherwise.

---

## Progress against the brief

Mapped to the 12 graded categories in [`CLAUDE.md`](../CLAUDE.md).

| #   | Category                      | Marks | State       | What's missing                                                                      |
| --- | ----------------------------- | ----- | ----------- | ----------------------------------------------------------------------------------- |
| 1   | Agent runtime                 | 15    | **done**    | —                                                                                   |
| 2   | Tools                         | 10    | **done**    | Built-in tool pack (step 7) is additive                                             |
| 3   | Handoffs                      | 10    | not started | Step 6                                                                              |
| 4   | Guardrails                    | 10    | **done**    | Input, output, tool, approval gates, and a fail-closed rule                         |
| 5   | Memory & sessions             | 10    | **done**    | 5 adapters, windowed reads, undo, trimming, summarization, events                   |
| 6   | Structured output + streaming | 10    | **done**    | `outputSchema`, repair, typed inference, HTTP/SSE/resumable streaming               |
| 7   | Reliability                   | 10    | **done**    | Timeouts, cancellation, loop bounds, typed errors, retries, fallback, secret safety |
| 8   | Tracing                       | 5     | **partial** | `steps[]` + 17 events + console tracer + an SSE feed; no JSON/OTel exporters        |
| 9   | Developer experience          | 10    | **done**    | Typed end to end, zero-config install, actionable errors, shipped test helpers      |
| 10  | Docs & examples               | 10    | **partial** | 16 pages + 8 runnable examples; 1 page forward-looking; **not yet hosted**          |
| 11  | Product thinking              | 10    | **done**    | Differentiation is real and demonstrable                                            |
| 12  | Demo & pitch                  | 10    | not started | Landing page done; **no video**                                                     |

**Roughly 110–118 of 120 addressable today.** The cheapest remaining marks, in
order: hosting the docs (category 10), the video (12), handoffs (3).

---

## Next step — 6 of 8: handoffs

The last unstarted category, and the last substantial runtime work before launch.
A handoff is modelled as a tool, which is why it comes after guardrails: it flows
through `executeToolCall` and therefore inherits tool guardrails for free.

- [ ] **`handoffs` on `AgentConfig`** — an agent, or `{ agent, filter?, describe? }`
      to narrow the context handed over and add a briefing note.
- [ ] **`RunResult.agentPath`** — `['triage', 'billing']`, so a trace shows the
      whole route.
- [ ] **Loop prevention, three ways**: a `maxHandoffs` ceiling, cycle detection
      for A → B → A, and a `maxTurns` budget shared across the chain rather than
      per agent.
- [ ] **`handoff.start` / `handoff.end` events**, and a tracer line.
- [ ] **Un-stub** [`handoffs.mdx`](../apps/web/content/docs/handoffs.mdx) — note
      that it commits to `stopReason: 'max_handoffs'`, which step 5 has good
      reason to revisit given it added no `StopReason` members.

### Acceptance

`pnpm check` green · two agents hand off and the trace shows it · a cycle is
detected rather than followed · a handoff tool call is subject to the tool
guardrails that already exist · the 426 existing tests pass unmodified.

### Open design questions

1. **Does a handoff replace the run, or nest inside it?** `agentPath` implies one
   run with several agents; a nested run would give each its own `RunResult`.
2. **`max_handoffs`: a `StopReason` or an error?** Step 5 deliberately added no
   `StopReason` members. Consistency argues for an error; the committed doc says
   otherwise.
3. **Does the receiving agent's `outputSchema` win, or the initiator's?** Both are
   defensible, and the answer changes what `RunResult<T>` means for a chain.

---

## Later steps

| Step | Scope                                                                             |
| ---- | --------------------------------------------------------------------------------- |
| 7    | **Built-in tool pack** — HTTP fetch, sandboxed filesystem, calculator, web search |
| 8    | **Launch** — host the docs, record the demo video, write the pitch                |

---

## Outstanding manual setup

Only you can do these.

- [ ] **Publish 0.2.0.** `just-another-sdk@0.1.0` went up on 2026-08-01. Five
      changesets are pending, so `pnpm changeset version` bumps to 0.2.0 and
      writes the first real `CHANGELOG.md`. Check it before merging — it folds in
      three entries from before 0.1.0 shipped.
- [ ] **Add `NPM_TOKEN`** to GitHub → Settings → Secrets → Actions, and **allow
      Actions to create pull requests** (Settings → Actions → General → Workflow
      permissions). The release workflow has never published: 0.1.0 was pushed by
      hand, and the last run failed on the PR permission. Use a **Granular Access
      Token** — classic tokens that bypass 2FA are being restricted.
- [ ] **Delete the stale branch** left by that failed run:
      `git push origin --delete changeset-release/main`.
- [ ] **Uncomment `OPENROUTER_API_KEY` in `examples/.env`**, then run
      `pnpm example:stream`, `example:structured`, `example:sessions`,
      `example:server`, and `example:resumable`. `example:guardrails` needs no key.
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
