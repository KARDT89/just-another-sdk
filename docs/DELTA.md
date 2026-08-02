# Delta

**Where the project stands, what is deliberately missing, and what happens next.**

|         |                                                           |
| ------- | --------------------------------------------------------- |
| Step    | 7 of 8 — the built-in tool pack                           |
| Date    | 2026-08-02                                                |
| Package | `just-another-sdk@0.3.0` — **published**; 0.4.0 pending   |
| Size    | 65 source files, ~14.5k lines, **0 runtime dependencies** |
| Tests   | 579 — 567 offline (~2.5s) + 12 live                       |

This file is rewritten at the end of every step. It is the current state of the
project, not a changelog — release history lives in
`packages/core/CHANGELOG.md`, and product documentation lives in the
[docs site](../apps/web/content/docs).

---

## What is built

Grouped by the seam it occupies. Step 1 built the loop, step 2 wrapped the model
call inside it, step 3 wrapped the loop itself, step 3.5 wrapped the result so it
could reach a browser, step 4 wrapped the _answer_, step 5 wrapped the whole
thing in **policy**, step 6 changed **who is inside the loop**. Step 7 changed
what the agent can **reach**.

Step 7 is the first step that is not a runtime change at all: the loop, the
state, and the events are untouched. What changed is that `npm i` now hands you
an agent that can already do things — and, because several of those things touch
the network and the disk, a security boundary that did not previously need to
exist.

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
| [`tools/resolve.ts`](../packages/core/src/tools/resolve.ts)   | Own tools + built-ins + transfer tools. **One place, two callers**      |

### The built-in tool pack

Seventeen tools, tiered by **who chooses the host** — which is the line that
matters, not "network or not".

| File                                                                              | Does                                                                         |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [`schema/mini.ts`](../packages/core/src/schema/mini.ts)                           | A ~150-line Standard Schema, so built-in arguments are validated with no Zod |
| [`tools/builtin/pure.ts`](../packages/core/src/tools/builtin/pure.ts)             | The five automatic tools. No I/O, no config, nothing to lock down            |
| [`tools/builtin/calculator.ts`](../packages/core/src/tools/builtin/calculator.ts) | A recursive-descent parser. **No `eval`, no `Function`**                     |
| [`tools/builtin/units.ts`](../packages/core/src/tools/builtin/units.ts)           | Eight dimensions as ratio tables; temperature handled explicitly             |
| [`tools/builtin/web.ts`](../packages/core/src/tools/builtin/web.ts)               | Weather, geocoding, Wikipedia, currency — fixed endpoints, **no key**        |
| [`tools/builtin/url-policy.ts`](../packages/core/src/tools/builtin/url-policy.ts) | The security boundary: allowlist, address rules, redirect re-checks          |
| [`tools/builtin/http.ts`](../packages/core/src/tools/builtin/http.ts)             | `httpFetch`, `readUrl`, capped streaming reads, HTML → prose                 |
| [`tools/builtin/search.ts`](../packages/core/src/tools/builtin/search.ts)         | `webSearch(client)` — the vendor is yours, structurally                      |
| [`tools/builtin/fs.ts`](../packages/core/src/tools/builtin/fs.ts)                 | Five rooted filesystem tools; `realpath` containment                         |

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
| `builtin-tools`                                 | 73    | no                                      |
| `tool-sandbox`                                  | 45    | no                                      |
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

## Decisions made in step 7

The three questions step 6 left open are answered, and one that only appeared
once the code existed.

| Question                             | Answer                                     | Why                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Allowlist by default, or refuse?** | Refuse — no allowlist, no requests         | An allowlist of nothing _is_ refusing, with a friendlier error. There is no permissive default anywhere in the pack                                             |
| **One import or four?**              | Two: `tools` and `tools/fs`                | The split that matters is `node:fs`, not tidiness. Everything else is `fetch`, so it runs on the edge; the filesystem pack must not be dragged into that bundle |
| **Core or a second package?**        | Core                                       | A second package doubles the release process for a solo maintainer and halves the chance anyone finds the tools. Subpath exports give the same tree-shaking     |
| **What does "by default" mean?**     | Pure tools auto-on; everything else opt-in | Split by blast radius. Auto-enabling HTTP ships an SSRF vector to every user of the SDK; auto-enabling the filesystem lets a prompt injection read `~/.ssh`     |

Four traps the design is built around, each with a test that fails without it:

- **The calculator-as-`eval` trap.** The three-line version of this tool hands a
  model a general-purpose code execution primitive, and the model does not have
  to be adversarial to reach it — a prompt injection in a fetched page is enough.
  So it is a parser, and a test reads the module's **own source** to assert
  neither `eval` nor `Function` appears in it.
- **The symlink trap.** Normalising `..` away is not containment. A link at
  `workspace/notes -> /etc` contains no traversal and normalises to a path
  squarely inside the root. Only `realpath`-then-recheck catches it, and the
  suite plants exactly that link.
- **The redirect trap.** Checking the allowlist once, against the URL the model
  supplied, makes it decorative: an allowed host that `302`s to `127.0.0.1` walks
  straight through. `redirect: 'manual'` and a re-check per hop is the fix.
- **The duplicate-name trap.** `ToolRegistry` throws on duplicates, so shipping a
  new built-in would have broken — at construction, on upgrade — every agent that
  already had a tool called `calculate`. A developer's own tool silently wins.

Things the plan did not anticipate:

- **Zero dependencies made validation the hard part.** Built-in tools need their
  arguments checked, and the SDK cannot import Zod to describe its own
  parameters. Step 6 sidestepped it with raw `parameters` JSON Schema and _no
  validation_, which is fine for one optional string and not for a filesystem
  path. The answer is `schema/mini.ts`: ~150 lines implementing the same
  Standard Schema interface every supported validator implements, hooked in
  through the `toJSONSchema()` strategy `resolveJsonSchema` already looked for.
  No converter to register, no `parameters` duplicate to keep in sync.
- **A live run found a bug the offline suite could not.** `wikipedia` returned
  `HTTP 429` on the first real call: Wikipedia's API policy requires a
  descriptive `User-Agent`, and Node's `fetch` sends nothing useful. Fixed with a
  default UA and a `userAgent` option, plus a 429 message that says the fix is
  configuration rather than a retry.
- **The escape suite found a real hole.** `http://[::ffff:127.0.0.1]/` was
  reaching loopback, because `new URL()` **rewrites the dotted quad into hex** —
  it arrives as `::ffff:7f00:1`, which the dotted-quad check never matched. The
  test was written before the fix and failed, which is the entire argument for
  writing the escape suite first.
- **Auto-on tools are not free, and the number is now pinned.** The five cost
  **~732 tokens on every request of every agent**. A test asserts the combined
  definition size stays under budget, so the figure in the docs cannot drift from
  the code, and `builtins: false` is documented next to it.

### Zero dependencies held

Nothing added. Seventeen tools, four public APIs called (`fetch`, `URL`, `Intl`,
`node:fs` in the separate entry), and `pnpm why` shows nothing new.

## Verified vs unverified

| Claim                                                  | How it was checked                                       | Result         |
| ------------------------------------------------------ | -------------------------------------------------------- | -------------- |
| Lint, format, typecheck, test, build                   | `pnpm check` across 13 workspaces                        | pass           |
| The 461 step-6 tests still pass                        | 8 needed `builtins: false` — see below                   | **amended**    |
| `calculate` cannot execute code                        | 7 escape attempts, plus reading its own source           | pass           |
| `unit_convert` round-trips and refuses cross-dimension | `c → f → c`; `km → kg` rejected                          | pass           |
| `date_math` gets month ends and leap years right       | 31 Jan + 1 month → 28 Feb; → 29 Feb in 2024              | pass           |
| Filesystem escapes all fail                            | 4 traversal forms, absolute path, **planted symlink**    | pass           |
| An escape never leaks the absolute host path           | asserted on the error message                            | pass           |
| 11 address forms refused with `allow: ['*']`           | loopback, private, metadata, IPv6, IPv4-mapped           | pass           |
| A redirect to a blocked host is refused                | and the second hop is never requested                    | pass           |
| A wildcard matches on a dot boundary only              | `notwikipedia.org` rejected by `*.wikipedia.org`         | pass           |
| Caps hold on responses and writes                      | streamed and stopped, not buffered then measured         | pass           |
| Built-ins present by default, absent when off          | plus a same-named tool replacing rather than throwing    | pass           |
| The built-ins' context cost stays under budget         | pinned at < 3,200 characters                             | pass           |
| The keyless tier works with **no API key**             | **ran live** — Open-Meteo, Wikipedia, ECB rates, geocode | pass           |
| The example runs with no API key at all                | ran it; all four acts                                    | pass           |
| **Real Postgres and real Redis**                       | not run — adapters tested against fakes                  | **unverified** |
| **Real streaming against a real model**                | still not run — needs a key                              | **unverified** |
| **A handoff against a real model**                     | offline only; whether models transfer _well_ is untested | **unverified** |
| **Whether models use these tools well**                | every test drives them through `mockProvider`            | **unverified** |
| **`strict: true` against a real OpenAI endpoint**      | offline-untestable; needs a key                          | **unverified** |

> **The amended row, stated rather than buried.** Eight step-6 tests failed when
> the automatic tools landed, because they asserted exact tool lists and now saw
> five more. Each was given `builtins: false` so it tests what it always meant to
> test — the wire shape of one tool, the ordering of one run — rather than being
> re-baselined to absorb the new count. That is a real behaviour change for
> anyone on 0.3.0: their agents will start seeing five extra tools. It is the
> price of "by default", it is opt-out, and the changeset says so.

> **What the offline suite still cannot tell you.** Every mechanical property
> above is real. Whether a model _reaches for_ `calculate` instead of doing
> arithmetic in its head, or picks the right unit string, is a prompt-quality
> question a scripted provider cannot answer. The descriptions are written for
> that job; none of it is measured.

---

## Progress against the brief

Mapped to the 12 graded categories in [`CLAUDE.md`](../CLAUDE.md).

| #   | Category                      | Marks | State       | What's missing                                                                      |
| --- | ----------------------------- | ----- | ----------- | ----------------------------------------------------------------------------------- |
| 1   | Agent runtime                 | 15    | **done**    | —                                                                                   |
| 2   | Tools                         | 10    | **done**    | Custom authoring, validation, async, typed results — **plus 17 built-ins**          |
| 3   | Handoffs                      | 10    | **done**    | Delegation, context transfer, three limits, events, docs, a runnable example        |
| 4   | Guardrails                    | 10    | **done**    | Input, output, tool, approval gates, and a fail-closed rule                         |
| 5   | Memory & sessions             | 10    | **done**    | 5 adapters, windowed reads, undo, trimming, summarization, events                   |
| 6   | Structured output + streaming | 10    | **done**    | `outputSchema`, repair, typed inference, HTTP/SSE/resumable streaming               |
| 7   | Reliability                   | 10    | **done**    | Timeouts, cancellation, loop bounds, typed errors, retries, fallback, secret safety |
| 8   | Tracing                       | 5     | **partial** | `steps[]` + 19 events + console tracer + an SSE feed; no JSON/OTel exporters        |
| 9   | Developer experience          | 10    | **done**    | Typed end to end, zero-config install, actionable errors, shipped test helpers      |
| 10  | Docs & examples               | 10    | **partial** | 18 pages + 10 runnable examples; **not yet hosted**                                 |
| 11  | Product thinking              | 10    | **done**    | Differentiation is real and demonstrable                                            |
| 12  | Demo & pitch                  | 10    | not started | Landing page done; **no video**                                                     |

**Roughly 115–120 of 120 addressable today.** Everything left is launch work:
hosting the docs (category 10) and the video (12).

---

## Next step — 8 of 8: launch

No more runtime work. The two categories still open are the two nobody else can
do for you.

- [ ] **Host the docs.** [`vercel.json`](../apps/web/vercel.json) already has the
      monorepo build command; point Vercel at `apps/web`. Then put the real URL
      in [`README.md`](../README.md) and `packages/core/package.json` `homepage`,
      both of which currently guess at `just-another-sdk.vercel.app`.
- [ ] **Write the pitch.** Who it is for, what it solves, why it should exist,
      how it differs, why anyone would adopt it. The material is all in this
      repository already — the zero-dependency claim, the loop that cannot hang,
      the escape suite — it has never been written as an argument.
- [ ] **Record the video.** Face on camera, the product demonstrated, the
      technical decisions explained.
- [ ] **Post it publicly**, per the brief.

### Acceptance

The docs resolve at a real URL · the README and `homepage` point at it · a pitch
someone could read in two minutes · a video where the product is visibly working.

### Open questions

1. **Does `run_command` ship before launch?** It is the one obvious gap in the
   tool pack, and it is also the one tool where a mistake is unrecoverable.
2. **Is the hosted docs URL a custom domain or `*.vercel.app`?** It goes in a
   published `package.json`, so changing it later means a release.

---

## Later steps

Nothing scheduled after launch. Candidates, in rough order of value: trace
exporters for JSON and OpenTelemetry (closes the last `partial`), native
Anthropic and Gemini providers, and a sandboxed `run_command`.

---

## Outstanding manual setup

Only you can do these.

- [ ] **Publish 0.4.0 by hand.** One changeset is pending. `pnpm changeset version`
      bumps to 0.4.0 and writes the changelog; `pnpm release` builds and publishes,
      prompting for an OTP.
- [ ] **The release workflow still cannot publish.** Both attempts failed with
      `ERR_PNPM_OTP_NON_INTERACTIVE`: the npm account is set to
      `two-factor auth: auth-and-writes`, so a stored `NPM_TOKEN` can never
      satisfy the registry on its own. **0.1.0, 0.2.0, and 0.3.0 were all pushed by
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
      `example:server`, and `example:resumable`. `example:guardrails`,
      `example:handoffs`, and `example:builtin-tools` need no key.
- [ ] **Run `example:handoffs` against a real model once.** Swap the mocks for
      `openrouter(...)` and check the router actually picks the right specialist.
- [ ] **Watch a real model use the built-in tools once.** Whether it reaches for
      `calculate` instead of doing arithmetic in its head is the one thing the
      offline suite cannot tell you, and the tool descriptions are written for
      exactly that job. `pnpm example:builtin-tools -- --live` already proves the
      _endpoints_ work with no key; this is about tool _selection_.
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
