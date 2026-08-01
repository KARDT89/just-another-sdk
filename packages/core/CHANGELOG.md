# just-another-sdk

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
