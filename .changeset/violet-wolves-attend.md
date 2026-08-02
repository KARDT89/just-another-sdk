---
'just-another-sdk': minor
---

Streaming that plugs into the web platform, and sessions that behave like a chat
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
