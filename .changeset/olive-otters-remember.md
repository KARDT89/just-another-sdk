---
'just-another-sdk': minor
---

Sessions and memory.

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
