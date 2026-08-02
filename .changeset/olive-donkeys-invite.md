---
'just-another-sdk': minor
---

Multi-agent handoffs.

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
