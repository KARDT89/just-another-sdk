---
'just-another-sdk': minor
---

Native Anthropic and Gemini providers.

Claude and Gemini were reachable only through OpenRouter. Both now have
first-class providers speaking their own APIs — the Messages API and
`generateContent` — built on `fetch` and the existing SSE framer, so the
package still installs with an empty dependency tree.

```ts
import { anthropic, google } from 'just-another-sdk/providers'

const agent = new Agent({
  name: 'assistant',
  model: anthropic('claude-opus-5'),
  fallbacks: [google('gemini-2.5-pro')],
})
```

`anthropic()` reads `ANTHROPIC_API_KEY`; `google()` reads `GEMINI_API_KEY`, then
`GOOGLE_API_KEY`, and is also exported as `gemini()`. Both support streaming,
tool calls, parallel tool calls, usage and cache accounting, per-call timeouts
and cancellation, and vendor-accurate error mapping — so retries and the
`fallbacks` chain behave the same as they do on OpenAI. Anthropic's 529 overload
and Gemini's `RetryInfo` back-off are both classified correctly.

Two things worth knowing:

- **Anthropic** requires `max_tokens`, so one is supplied (4096) when the agent
  does not set `maxOutputTokens`. `responseFormat` maps to the native
  `output_config.format` only when you opt in with `structuredOutputs: true`,
  because that field is model-gated; otherwise it is ignored and structured
  output falls back to the runtime's own validate-and-repair path.
- **Gemini** accepts only an OpenAPI 3.0 subset of JSON Schema, so every tool
  schema is rewritten before it is sent. Without that, tools would be rejected —
  Zod emits `$schema` and the SDK's own empty-object schema sets
  `additionalProperties`.

Both providers take a `defaultBody` escape hatch for anything unmodelled —
Anthropic's `thinking` and `output_config.effort`, Gemini's `safetySettings` and
`thinkingConfig` — and for removing a field the SDK would otherwise send, which
matters because recent Claude models reject `temperature` outright.

Internally, the transport helpers shared by every provider (deadline linking,
abort classification, `Retry-After` parsing) moved to `providers/transport.ts`.
No public API changed.
