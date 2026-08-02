---
'just-another-sdk': minor
---

Structured output — typed, validated results instead of a string.

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
