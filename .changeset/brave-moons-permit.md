---
'just-another-sdk': minor
---

Guardrails and human approval gates.

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
