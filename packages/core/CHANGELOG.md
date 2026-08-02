# just-another-sdk

## 0.3.0

### Minor Changes

- 81b35da: Multi-agent handoffs.

  A cheap router decides _who_ should answer; a specialist with its own
  instructions, tools, and model actually answers it:

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
  result.agentName // 'billing' — who actually answered
  ```

  **A handoff is a tool.** Each target becomes a `transfer_to_<name>` tool, which
  is what a transfer already is from the model's point of view. That is why it
  needed almost no new machinery: a transfer is validated, subject to the routing
  agent's `toolGuardrails`, gateable behind `requireApproval`, bounded by the tool
  timeout, and visible in a trace — because every tool call is.

  **It is one run.** The loop swaps which agent it is running rather than starting
  a nested run, so there is one `runId`, one `usage` total, one session save, and
  one `RunResult`. `maxTurns` is therefore a budget for the run, shared across the
  chain, rather than one each agent gets a fresh copy of.

  **Three limits, and none of them ends the run.** `maxHandoffs` (default 5),
  cycle detection for `A → B → A`, and that shared turn budget. A refused transfer
  becomes an error result the model reads — "answer the user directly" — so the run
  still finishes with an answer and `stopReason` is still `finish`. Like a
  guardrail rejection it carries no error on the outcome, so it does not trip
  `onToolError: 'throw'`.

  This revises what the docs previously promised: there is no
  `stopReason: 'max_handoffs'`. Ending a run whose conversation is valid, and whose
  current agent could have answered, throws work away for nothing.

  **Narrowing the handover** is a `filter`, and it narrows only what the model is
  _shown_:

  ```ts
  handoffs: [
    {
      agent: billing,
      filter: (messages) => messages.slice(-4),
      describe: 'The user reports a duplicate charge in March.',
    },
  ]
  ```

  `result.messages` and anything a session persists stay complete — delegation is
  not a way to erase a user's history. A slice that orphans a tool result is
  repaired rather than thrown.

  Also new: `RunResult.agentPath`, `RunResult.agentName` now naming the agent that
  answered, `RunStep.agentName`, `Agent.handoffNames`, `Agent.withHandoffs()`,
  `maxHandoffs` on `AgentConfig` and `RunOptions`, and two events —
  `handoff.start` and `handoff.refused` — bringing the union to 19. `run.finish`
  gains `agentPath`, and the console tracer prints the route.

  Zero runtime dependencies, still. Every existing test passed unmodified.

## 0.2.0

### Minor Changes

- 8fd5afd: Guardrails and human approval gates.

  **Three places to say no**, all named so they show up in a trace:

  ```ts
  new Agent({
    name: 'support',
    model,
    tools: [refundOrder],
    inputGuardrails: [{ name: 'max-length', check: (input) => … }],
    outputGuardrails: [{ name: 'pii-scrub', check: (text) => ({ allow: true, replace: strip(text) }) }],
    toolGuardrails: [{ name: 'refund-cap', tools: ['refund_order'], check: ({ input }) => … }],
  })
  ```

  Each can **allow**, **rewrite**, or **reject**. They run in declaration order, one
  at a time, so a rewrite is visible to the next one — scrub, then length-check.

  **An input guardrail rejects before a single token is spent.** The example prints
  `model calls made: 0` to prove it rather than assert it.

  **Output guardrails are typed on the agent's output.** With an `outputSchema` the
  guardrail receives the _validated object_, not raw text, so a rewrite cannot
  break the schema contract. A rewrite also updates the **transcript** — scrubbing
  only the return value would leave the original in the session and hand it back on
  the next turn.

  **A blocked tool call is not a run failure.** The model receives an error result,
  reads it, and routes around it. This holds under `onToolError: 'throw'` too: that
  flag means "a tool broke, abort", and a guardrail refusing a call is policy
  working correctly, not a broken tool. Both paths are tested.

  **Human approval, with no store to implement.** A `requireApproval` verdict
  suspends the run and throws `ApprovalRequiredError` carrying a plain-JSON
  `suspension`. Decide wherever you like — another process, an hour later — then
  call `agent.resumeApproval(suspension, decisions)`. There is no `ApprovalStore`,
  no adapter per backend, and nothing is written mid-run, which is what keeps "only
  a completed run is persisted" true with no special case.

  Four properties hold structurally, and the docs are equally explicit that the SDK
  cannot _authenticate_ a decision without a secret or a store:

  - **If any call in a turn needs approval, none of them run.** Otherwise the
    ungated ones would execute again on resume — a duplicated side effect, the exact
    failure an approval gate exists to prevent.
  - **An approval authorises one call, once.** Only the resume step reads your
    decisions; the in-loop gate never does, so a second call to the same gated tool
    suspends again.
  - **An approval cannot override an outright `reject`.** Guardrails are re-run on
    resume; `approved: true` satisfies a `requireApproval` and nothing else.
  - **An unknown `toolCallId` fails loud**, listing the ids that were expected.

  **A guardrail that throws fails closed** — it becomes a rejection, never a silent
  allow. Deliberately the opposite of a throwing `onEvent` listener (swallowed) and
  of a failed summary (falls back): those are optimisations, this is a safety
  control.

  `agent.run()`'s signature is unchanged and **`StopReason` gains no members**.
  Both rejection and suspension throw, which is the same call `InvalidOutputError`
  made last release — a `RunResult<Ticket>` with no valid ticket in it is worse
  than an error that says why. It also means `stream()`, `session().run()`, and
  `resumable()` all support approval with no type change.

  New: `GuardrailError` (`guardrail_blocked`) and `ApprovalRequiredError`
  (`approval_required`); events `guardrail.triggered`, `approval.required`,
  `approval.resolved`; `RunStep.kind` gains `'resume'`; `Agent.resumeApproval()` —
  deliberately not `resume`, which already means re-attaching to a recorded stream.
  A tool guardrail naming an unregistered tool is now a `ConfigurationError` at
  construction, because a typo in a safety control must not fail open.

  New example: `pnpm example:guardrails`, the first that needs **no API key at
  all**.

- 2dfdfc4: Sessions and memory.

  **Multi-turn conversations now persist themselves.** Pass a `sessionId` to a run
  and history is loaded before the loop and this run's new messages appended after
  it — no `messages` bookkeeping at the call site:

  ```ts
  await agent.run('My name is Ada.', { sessionId: 'user_123' })
  await agent.run('What is my name?', { sessionId: 'user_123' })
  ```

  With no store configured this uses a bounded per-agent in-memory store, so
  multi-turn costs zero imports and zero setup. Sessions belong to the agent's
  config object, so two agents never see each other's conversations.

  **`session` on `AgentConfig`** takes any `SessionStore` — a three-method
  interface (`load`, `append`, `clear`). Append rather than `save(allMessages)`:
  there is no read-modify-write, so writes are O(1) per message and two concurrent
  runs on one session interleave instead of clobbering each other.

  **Seven adapters.** `memorySession()` (bounded, LRU); `fileSession(dir)` from
  `just-another-sdk/sessions/file`, one JSONL file per session and tolerant of a
  torn final line after a crash; `sqliteSession(path)` from
  `just-another-sdk/sessions/sqlite`, on Node's built-in `node:sqlite`; and from
  `just-another-sdk/sessions`, `redisSession(client)`, `postgresSession(client)`,
  `drizzleSession(db)`, and `prismaSession(client)`, which take **the client you
  already have** and duck-type it — `pg`, `postgres.js`, Drizzle, Prisma,
  `node-redis`, `ioredis`, or a bare `(sql, params) => rows` function. None of
  those packages becomes a dependency; the client types are structural, so the
  package still installs nothing.

  **`agent.session(id)`** binds a conversation for chat loops and CLIs:
  `chat.run()`, `chat.stream()`, `chat.messages()`, `chat.clear()`.

  **`context` on `AgentConfig`** bounds what is sent: `{ maxMessages, maxTokens,
countTokens }`. Trimming is non-destructive — the store keeps everything — drops
  only the oldest, and never leaves a tool result orphaned from the assistant
  message that produced it. It applies to `options.messages` too, so it is useful
  without a session store.

  **New events** `session.load` (with `droppedCount`, so trimming is visible in a
  trace) and `session.save`, both rendered by `consoleTracer`.

  Only a _completed_ run is persisted: a run that throws mid-turn can leave an
  assistant tool-call with no results, which every provider rejects on the next
  request. Passing both `sessionId` and `messages` is a `ConfigurationError` rather
  than a silent concatenation of two overlapping transcripts.

- 6f200ec: Streaming and reliability.

  **`agent.stream()`** returns a `StreamedRun` — an async iterable of events that
  is also awaitable for the final `RunResult`. It runs the same loop as `run()`
  with a listener attached, so streamed and non-streamed runs cannot drift apart.
  `textStream()` yields just the tokens; `.abort()` cancels. Providers that do not
  implement `stream()` still work, delivering the answer as a single `text.delta`.

  **SSE streaming on the OpenAI-compatible transport**, with a vendor-neutral
  `text/event-stream` framer that handles chunk-boundary splits, keep-alive
  comments, and multi-line data fields. Fragmented `tool_calls` are reassembled by
  index; partial arguments are never surfaced to user code.

  **Automatic retries** with exponential backoff and full jitter, on by default
  (`maxRetries: 2`). A provider's `Retry-After` is honoured as a floor, and one
  longer than `maxRetryDelayMs` fails fast rather than blocking the caller.
  Cancellation takes effect during a backoff instead of after it. Configurable via
  `maxRetries`, `retryDelayMs`, `maxRetryDelayMs`, and `retryOn`.

  **Model fallback chains** via `fallbacks: ModelProvider[]`, tried in order once
  the primary is spent — including on non-retryable failures, where a second vendor
  is exactly what helps. The chain resets to the primary each turn.

  **New events** `model.retry` and `model.fallback`, both carrying `discardedText`
  so a renderer knows what to un-paint. **`RunStep` gains `modelId`**, recording
  which model served each turn. `mockProvider` gains streaming support
  (`textChunks`, `chunkDelayMs`, `errorAfterChunks`, `supportsStreaming`,
  `streamCallCount`), and `compatible()` gains `defaultBody`.

  Removes the unused `max_turns_exceeded` error code, which was never constructed —
  reaching `maxTurns` is a non-throwing `stopReason`.

- 6174b6b: Structured output — typed, validated results instead of a string.

  **`outputSchema` on an agent makes `result.output` an object**, with the type
  inferred from the schema and no cast at the call site:

  ```ts
  const Ticket = z.object({
    category: z.enum(['bug', 'feature', 'question']),
    severity: z.number().int().min(1).max(5),
    summary: z.string(),
  })

  const agent = new Agent({ name: 'triage', model, outputSchema: Ticket })

  const result = await agent.run(customerEmail)
  result.output.severity + 1 // a real number
  result.text // the raw JSON
  ```

  Any Standard Schema validator, the same interop `tool()` already uses. An agent
  without a schema is unchanged in every respect: `output` is still the text, and
  `agent.run<T>()` still compiles and still wins.

  **It composes with tools.** The loop is untouched — the schema rides along on
  every model call, and only the final answer is validated. A run that calls three
  tools and returns a typed object is one agent, not two.

  **Three layers, because one is not enough.** The derived JSON Schema goes out as
  the provider's `response_format`; the schema is _also_ appended to the system
  prompt, always, because gateways like Ollama and older vLLM accept
  `response_format` and silently ignore it with no capability flag to ask; and the
  answer is then extracted (bare JSON, a fenced block, or an object embedded in
  prose) and validated.

  **A bad answer gets one bounded repair.** The failed output and the specific
  per-field errors go back to the model. `maxOutputRetries` defaults to `1` and is
  **additive to `maxRetries`, never multiplicative** — that one re-sends an
  identical request after a transport failure, this one sends a different
  conversation. A repair is recorded in `steps` with `kind: 'repair'` so its tokens
  and its serving model are visible, but it does **not** count as a turn:
  `maxTurns` stays the ceiling it claims to be.

  **`InvalidOutputError`** when the budget is spent, carrying `issues`, `rawText`,
  and `attempts`. `rawText` is on the instance and deliberately absent from
  `toJSON()` — raw model output is unbounded and can echo back whatever a user
  pasted in, and `details` is the log-safe form the tracer and the SSE serializer
  print. A run that never validated persists nothing, same rule as any other failed
  run.

  **No `text.delta` with a schema.** The model's only text is the JSON object, and
  half an object is not renderable — so `textStream()` and `toResponse()` are empty
  and `toEventResponse()` is the browser shape. `await agent.stream(x)` still
  resolves to the validated result.

  **Fix:** the OpenAI-compatible transport hardcoded `strict: true` whenever a
  schema was present. Strict mode rejects any schema without
  `additionalProperties: false` and every key `required`, which no validator's JSON
  Schema output guarantees — so the first live structured call would have 400'd.
  `ResponseFormat.strict` is now opt-in and defaults to `false`; pass an
  `outputJsonSchema` that satisfies the rules to turn it on. This code had never
  been reachable before this release.

  New event `output.invalid`, new error code `invalid_output`, new `RunStep.kind`,
  and a new `SchemaSubject` so a conversion failure on an `outputSchema` no longer
  tells you to go fix a `tool()` call you never wrote. New example:
  `pnpm example:structured`, whose repair and failure acts run offline.

- 2dfdfc4: Streaming that plugs into the web platform, and sessions that behave like a chat
  backend.

  **`toResponse()` is now the whole route handler.** `StreamedRun` gained
  `toTextStream()` — a real web `ReadableStream<Uint8Array>`, not just an async
  iterable — plus `toResponse()`, `toEventStream()`, and `toEventResponse()`:

  ```ts
  export async function POST(req: Request) {
    const { message, userId } = await req.json()
    return agent.stream(message, { sessionId: userId }).toResponse()
  }
  ```

  Works in Next.js, Hono, Bun, Deno, and Workers. Streaming-safe headers come with
  it, including `x-accel-buffering: no` so proxies do not swallow the stream, and
  `x-run-id` for tracing. Cancelling the body aborts the run. `StreamedRun.runId`
  is available synchronously, before the first token, and `RunOptions.runId` lets
  you supply your own.

  **An SSE feed of every event**, so a UI can render "calling `get_weather`…" and
  not only text. `readEventStream(response)` is the client half and runs anywhere
  `fetch` does, reusing the same SSE framer the providers use. Payloads are
  **redacted** before they leave the process, and `model.request` is withheld by
  default since it carries your tool schemas.

  **Resumable runs.** `agent.resumable()` records a run as it happens, so a client
  that loses its connection mid-generation reconnects and picks up where it left
  off — `EventSource` sends `Last-Event-ID` automatically and the `id:` on each
  event is what it resumes from. This also fixes a real bug: an ordinary run wired
  to `request.signal` is cancelled on disconnect, and because only completed runs
  persist, the user lost the exchange they had already watched arrive. Backed by
  `memoryStreamStore()` or `redisStreamStore(client)` from
  `just-another-sdk/streams`. Following bounds itself, so an expired id or a dead
  writer ends the stream instead of hanging the client.

  **Windowed session reads.** `load(id, { limit })` and `chat.messages({ limit })`
  stop a 1000-message conversation from being parsed in full to send twenty. Native
  per adapter — `LIMIT`, `LRANGE -N -1`, `slice`. A hint, not a guarantee: a store
  that ignores it is slower, never wrong. `session.load` gained `truncated`, so a
  bounded read is distinguishable from a complete one.

  **Undo.** `pop()` removes and returns the last message; two of them walk back an
  exchange, which is what "edit my message and regenerate" needs. Optional on
  `SessionStore` so the interface is still three methods; implemented on all five
  adapters.

  **Summarization.** `context: { maxTokens: 30_000, summarize: true }` folds
  aged-out history into a model-written recap instead of dropping it. The summary
  is an ordinary message carrying an explicit watermark, so nothing is deleted and
  it round-trips through every adapter. Folds compact to half the budget, so one
  fold lasts several turns rather than buying a summary every run. **A failed
  summary never fails the run** — it falls back to plain trimming and
  `session.summarize` carries the error.

  **Breaking:** `drizzleSession` and `prismaSession` are removed. Drizzle's
  `db.execute()` takes no parameter array, so a real adapter would have to
  interpolate values into SQL. Both are one documented line through the same tested
  path:

  ```ts
  postgresSession(db.$client) // Drizzle
  postgresSession((sql, p) => prisma.$queryRawUnsafe(sql, ...p)) // Prisma
  ```

  New entry point `just-another-sdk/streams`. New events `session.summarize` and
  the `truncated` field on `session.load`. `SseEvent` now surfaces `id`. Two new
  examples: a streaming chat server and a resumable run.

## 0.1.0

### Minor Changes

- 27ec46a: Initial release.

  **Agent runtime** — `Agent` as immutable configuration, a bounded loop that always
  terminates with a `stopReason`, per-turn `steps` recorded for tracing, summed
  token usage, and multi-turn continuation by passing `messages` back in.

  **Tools** — `tool()` with handler input inferred from any
  [Standard Schema](https://standardschema.dev) validator, automatic JSON Schema
  derivation for Zod, per-tool timeouts, concurrent execution within a turn, and
  failures fed back to the model as recoverable tool results by default.

  **Providers** — zero-dependency `fetch`-based transport covering OpenRouter,
  OpenAI, and any OpenAI-compatible endpoint (Groq, Together, DeepSeek, Ollama,
  vLLM, LM Studio), plus a one-method contract for writing your own.

  **Reliability** — one `AgentError` hierarchy with machine-readable codes and a
  `retryable` flag, `AbortSignal` cancellation that reaches in-flight model calls
  and tools, per-tool and per-model deadlines, and a guarantee (with tests) that an
  API key never appears in an error, an event, or a trace.

  **Observability** — a typed event stream with a built-in `consoleTracer`, where a
  throwing listener can never break a run.

  **Testing** — `just-another-sdk/testing` ships `mockProvider` and `collectEvents`
  so agent behaviour can be tested offline and deterministically.
