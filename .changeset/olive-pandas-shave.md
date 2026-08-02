---
'just-another-sdk': minor
---

Streaming and reliability.

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
