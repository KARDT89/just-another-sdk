import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import {
  Agent,
  assistantMessage,
  memorySession,
  tool,
  toolMessage,
  userMessage,
} from '../src/index.js'
import type { LoadOptions, ModelMessage, SessionStore } from '../src/index.js'
import { fileSession } from '../src/sessions/file.js'
import { postgresSession } from '../src/sessions/postgres.js'
import { redisSession } from '../src/sessions/redis.js'
import { sqliteSession } from '../src/sessions/sqlite.js'
import { collectEvents, mockProvider } from '../src/testing/index.js'

/**
 * Two things are tested here, and they are different jobs:
 *
 *   1. **The store contract** — one body run against every adapter, so a new
 *      backend is correct by construction or visibly not.
 *   2. **The run boundary** — when history is loaded, when it is saved, and what
 *      happens when a run does not finish.
 *
 * Redis and Postgres run against in-memory fakes of the client interfaces they
 * accept. That proves the adapter's own logic — command shapes, SQL shape, row
 * normalisation, client detection — offline and deterministically, which is the
 * rule for this package's suite. It does not prove either server's behaviour.
 */

/* ------------------------------------------------------------------------- */
/* Fakes for the injected-client adapters                                    */
/* ------------------------------------------------------------------------- */

function fakeNodeRedis() {
  const lists = new Map<string, string[]>()
  return {
    lists,
    async rPush(key: string, elements: string[]): Promise<number> {
      const list = lists.get(key) ?? []
      list.push(...elements)
      lists.set(key, list)
      return list.length
    },
    async lRange(key: string, start: number, stop: number): Promise<string[]> {
      const list = lists.get(key) ?? []
      return stop === -1 ? list.slice(start) : list.slice(start, stop + 1)
    },
    async rPop(key: string): Promise<string | null> {
      return lists.get(key)?.pop() ?? null
    },
    async del(key: string): Promise<number> {
      return lists.delete(key) ? 1 : 0
    },
    async expire(): Promise<number> {
      return 1
    },
  }
}

function fakeIoRedis() {
  const lists = new Map<string, string[]>()
  return {
    lists,
    async rpush(key: string, ...elements: string[]): Promise<number> {
      const list = lists.get(key) ?? []
      list.push(...elements)
      lists.set(key, list)
      return list.length
    },
    async lrange(key: string, start: number, stop: number): Promise<string[]> {
      const list = lists.get(key) ?? []
      return stop === -1 ? list.slice(start) : list.slice(start, stop + 1)
    },
    async rpop(key: string): Promise<string | null> {
      return lists.get(key)?.pop() ?? null
    },
    async del(key: string): Promise<number> {
      return lists.delete(key) ? 1 : 0
    },
  }
}

/**
 * Just enough Postgres to answer the four statements the adapter emits.
 *
 * Deliberately literal: if the adapter's SQL changes shape, this stops matching
 * and the test fails, which is the point.
 */
function fakeSql() {
  const rowsBySession = new Map<string, unknown[]>()
  const statements: string[] = []

  const run = (sql: string, params: readonly unknown[]): unknown[] => {
    statements.push(sql.replace(/\s+/g, ' ').trim())
    const text = sql.trim().toLowerCase()

    if (text.startsWith('create')) return []

    const sessionId = String(params[0])

    if (text.startsWith('select')) {
      const stored = rowsBySession.get(sessionId) ?? []
      // A windowed read is `order by seq desc limit $2`, and the adapter is
      // expected to reverse it back into order itself.
      if (text.includes('desc')) {
        const limit = Number(params[1])
        return [...stored]
          .reverse()
          .slice(0, limit)
          .map((message) => ({ message }))
      }
      return stored.map((message) => ({ message }))
    }

    if (text.startsWith('insert')) {
      const placeholders = sql.match(/\$\d+::jsonb/g) ?? []
      const stored = rowsBySession.get(sessionId) ?? []
      for (let i = 0; i < placeholders.length; i += 1) {
        // The driver would parse jsonb on the way back out; do the same.
        stored.push(JSON.parse(String(params[i + 1])))
      }
      rowsBySession.set(sessionId, stored)
      return []
    }

    if (text.startsWith('delete')) {
      // `pop` deletes only the highest seq and returns it; `clear` deletes all.
      if (text.includes('returning')) {
        const stored = rowsBySession.get(sessionId) ?? []
        const removed = stored.pop()
        return removed === undefined ? [] : [{ message: removed }]
      }
      rowsBySession.delete(sessionId)
      return []
    }

    throw new Error(`fakeSql got an unexpected statement: ${sql}`)
  }

  return { run, statements, rowsBySession }
}

/** `pg`: `query(sql, params)` answering `{ rows }`. */
function fakePg() {
  const sql = fakeSql()
  return {
    statements: sql.statements,
    async query(text: string, params: readonly unknown[] = []) {
      return { rows: sql.run(text, params) }
    },
  }
}

/** `postgres.js`: `unsafe(sql, params)` answering a bare array. */
function fakePostgresJs() {
  const sql = fakeSql()
  return {
    statements: sql.statements,
    async unsafe(text: string, params: readonly unknown[] = []) {
      return sql.run(text, params)
    },
  }
}

/**
 * Prisma is not an adapter any more — it is the documented one-line wrapper:
 * `postgresSession((sql, p) => prisma.$queryRawUnsafe(sql, ...p))`.
 */
function fakePrismaWrapper() {
  const sql = fakeSql()
  const calls: string[] = []
  return {
    statements: sql.statements,
    calls,
    query: async (text: string, params: readonly unknown[]) => {
      calls.push(text)
      return sql.run(text, params)
    },
  }
}

/** Drizzle is not an adapter either — you pass `db.$client`, a real driver. */
function fakeDrizzle() {
  const client = fakePg()
  return { $client: client, statements: client.statements }
}

/* ------------------------------------------------------------------------- */
/* The store contract                                                        */
/* ------------------------------------------------------------------------- */

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jas-sessions-'))
  tempDirs.push(dir)
  return dir
}

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const adapters: { name: string; create: () => Promise<SessionStore> | SessionStore }[] = [
  { name: 'memorySession', create: () => memorySession() },
  { name: 'fileSession', create: async () => fileSession(await tempDir()) },
  { name: 'sqliteSession', create: async () => sqliteSession(join(await tempDir(), 'c.db')) },
  { name: 'redisSession (node-redis)', create: () => redisSession(fakeNodeRedis()) },
  { name: 'redisSession (ioredis)', create: () => redisSession(fakeIoRedis()) },
  { name: 'postgresSession (pg)', create: () => postgresSession(fakePg()) },
  { name: 'postgresSession (postgres.js)', create: () => postgresSession(fakePostgresJs()) },
  // The two documented ORM one-liners get the same contract run against them, so
  // dropping the named exports did not quietly drop the support.
  {
    name: 'postgresSession (Drizzle $client)',
    create: () => postgresSession(fakeDrizzle().$client),
  },
  {
    name: 'postgresSession (Prisma wrapper)',
    create: () => postgresSession(fakePrismaWrapper().query),
  },
]

describe.each(adapters)('SessionStore contract — $name', ({ create }) => {
  let store: SessionStore

  beforeEach(async () => {
    store = await create()
  })

  it('returns an empty transcript for an unknown session', async () => {
    expect(await store.load('nobody')).toEqual([])
  })

  it('round-trips every message shape exactly', async () => {
    const conversation: ModelMessage[] = [
      userMessage('What is the weather in Paris?'),
      assistantMessage([
        { type: 'text', text: 'Let me check.' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'get_weather',
          input: { city: 'Paris' },
        },
      ]),
      toolMessage([
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'get_weather',
          output: { tempC: 18 },
        },
      ]),
      assistantMessage([{ type: 'text', text: 'It is 18°C.' }]),
    ]

    await store.append('s1', conversation)

    expect(await store.load('s1')).toEqual(conversation)
  })

  it('appends in order across separate calls', async () => {
    await store.append('s1', [userMessage('one')])
    await store.append('s1', [userMessage('two'), userMessage('three')])

    expect((await store.load('s1')).map((m) => m.content)).toEqual(['one', 'two', 'three'])
  })

  it('keeps sessions independent', async () => {
    await store.append('a', [userMessage('for a')])
    await store.append('b', [userMessage('for b')])

    expect((await store.load('a')).map((m) => m.content)).toEqual(['for a'])
    expect((await store.load('b')).map((m) => m.content)).toEqual(['for b'])
  })

  it('clears one session without touching the others', async () => {
    await store.append('a', [userMessage('for a')])
    await store.append('b', [userMessage('for b')])

    await store.clear('a')

    expect(await store.load('a')).toEqual([])
    expect((await store.load('b')).map((m) => m.content)).toEqual(['for b'])
  })

  it('treats clearing an unknown session as a no-op', async () => {
    await expect(store.clear('never-existed')).resolves.toBeUndefined()
  })

  it('ignores an empty append', async () => {
    await store.append('s1', [userMessage('one')])
    await store.append('s1', [])

    expect(await store.load('s1')).toHaveLength(1)
  })

  it('rejects a session id carrying control characters', async () => {
    await expect(store.load(`bad${String.fromCharCode(0)}id`)).rejects.toThrow(/control character/)
  })

  it('honours a load limit by returning the newest messages, in order', async () => {
    await store.append('s1', [userMessage('1'), userMessage('2'), userMessage('3')])

    expect((await store.load('s1', { limit: 2 })).map((m) => m.content)).toEqual(['2', '3'])
  })

  it('returns everything when the limit exceeds the transcript', async () => {
    await store.append('s1', [userMessage('1'), userMessage('2')])

    expect(await store.load('s1', { limit: 50 })).toHaveLength(2)
  })

  it('pops exactly the last message and returns it', async () => {
    await store.append('s1', [userMessage('one'), userMessage('two')])

    const popped = await store.pop?.('s1')

    expect(popped?.content).toBe('two')
    expect((await store.load('s1')).map((m) => m.content)).toEqual(['one'])
  })

  it('pops undefined from an empty session without corrupting it', async () => {
    expect(await store.pop?.('never-existed')).toBeUndefined()
    expect(await store.load('never-existed')).toEqual([])
  })
})

/* ------------------------------------------------------------------------- */
/* Durability                                                                */
/* ------------------------------------------------------------------------- */

describe('durability across a restart', () => {
  it('fileSession reads back a conversation written by a previous instance', async () => {
    const dir = await tempDir()

    const first = fileSession(dir)
    await first.append('user_1', [userMessage('My name is Ada.')])

    // A new store object, as a new process would build.
    const second = fileSession(dir)

    expect((await second.load('user_1')).map((m) => m.content)).toEqual(['My name is Ada.'])
  })

  it('sqliteSession reads back a conversation written by a previous instance', async () => {
    const path = join(await tempDir(), 'chat.db')

    const first = sqliteSession(path)
    await first.append('user_1', [userMessage('My name is Ada.')])

    const second = sqliteSession(path)

    expect((await second.load('user_1')).map((m) => m.content)).toEqual(['My name is Ada.'])
  })
})

/* ------------------------------------------------------------------------- */
/* Adapter specifics                                                         */
/* ------------------------------------------------------------------------- */

describe('fileSession', () => {
  it('skips a torn final line rather than losing the conversation', async () => {
    const dir = await tempDir()
    const store = fileSession(dir)

    await store.append('u', [userMessage('one'), userMessage('two')])

    // Simulate a crash mid-write: a complete transcript plus a partial line.
    const path = join(dir, 'u.jsonl')
    await writeFile(path, `${await readFile(path, 'utf8')}{"role":"user","cont`, 'utf8')

    expect((await store.load('u')).map((m) => m.content)).toEqual(['one', 'two'])
  })

  it('throws on corruption that is not a torn final line', async () => {
    const dir = await tempDir()
    const store = fileSession(dir)

    await store.append('u', [userMessage('one')])
    const path = join(dir, 'u.jsonl')
    await writeFile(path, `not json\n${await readFile(path, 'utf8')}`, 'utf8')

    await expect(store.load('u')).rejects.toThrow(/corrupt/)
  })

  it('cannot be talked into writing outside its directory', async () => {
    const dir = await tempDir()
    const store = fileSession(dir)

    await store.append('../escape', [userMessage('nope')])

    // Percent-encoded into a plain basename, so the traversal never happens.
    expect((await store.load('../escape')).map((m) => m.content)).toEqual(['nope'])
    await expect(readFile(join(dir, '..', 'escape.jsonl'), 'utf8')).rejects.toThrow()
  })
})

describe('memorySession bounds', () => {
  it('evicts the least recently used session', async () => {
    const store = memorySession({ maxSessions: 2 })

    await store.append('a', [userMessage('a')])
    await store.append('b', [userMessage('b')])
    await store.load('a') // touching 'a' makes 'b' the oldest
    await store.append('c', [userMessage('c')])

    expect(await store.load('b')).toEqual([])
    expect(await store.load('a')).toHaveLength(1)
    expect(await store.load('c')).toHaveLength(1)
  })

  it('caps messages per session, dropping the oldest', async () => {
    const store = memorySession({ maxMessagesPerSession: 2 })

    await store.append('a', [userMessage('1'), userMessage('2'), userMessage('3')])

    expect((await store.load('a')).map((m) => m.content)).toEqual(['2', '3'])
  })
})

describe('client detection', () => {
  it('accepts a plain query function', async () => {
    const sql = fakeSql()
    const store = postgresSession(async (text, params) => sql.run(text, params))

    await store.append('a', [userMessage('hi')])

    expect((await store.load('a')).map((m) => m.content)).toEqual(['hi'])
  })

  it('works through the documented Prisma wrapper', async () => {
    const prisma = fakePrismaWrapper()
    const store = postgresSession(prisma.query)

    await store.append('a', [userMessage('hi')])
    await store.load('a')

    expect(prisma.calls.some((sql) => /insert into/i.test(sql))).toBe(true)
    expect(prisma.calls.some((sql) => /^\s*select/i.test(sql))).toBe(true)
  })

  it('works through the documented Drizzle $client', async () => {
    const db = fakeDrizzle()
    const store = postgresSession(db.$client)

    await store.append('a', [userMessage('hi')])

    expect(db.statements.some((sql) => sql.includes('insert into'))).toBe(true)
  })

  it('names what it expected when the client is unrecognised', () => {
    expect(() => postgresSession({} as never)).toThrow(/did not recognise/)
    expect(() => redisSession({} as never)).toThrow(/did not recognise/)
    // The message has to point Drizzle and Prisma users somewhere, now that
    // their named adapters are gone.
    expect(() => postgresSession({} as never)).toThrow(/\$client/)
    expect(() => postgresSession({} as never)).toThrow(/queryRawUnsafe/)
  })

  it('skips the DDL when ensureTable is false', async () => {
    const pg = fakePg()
    const store = postgresSession({ client: pg, ensureTable: false })

    await store.append('a', [userMessage('hi')])

    expect(pg.statements.some((sql) => /create table/i.test(sql))).toBe(false)
  })

  it('refuses a table name that is not a plain identifier', () => {
    expect(() => postgresSession({ client: fakePg(), table: 'drop"; --' })).toThrow(
      /Invalid identifier/,
    )
  })
})

/* ------------------------------------------------------------------------- */
/* The run boundary                                                          */
/* ------------------------------------------------------------------------- */

describe('sessions at the run boundary', () => {
  it('remembers across runs with nothing configured but a sessionId', async () => {
    const model = mockProvider([{ text: 'Nice to meet you, Ada.' }, { text: 'Your name is Ada.' }])
    const agent = new Agent({ name: 'assistant', model })

    await agent.run('My name is Ada.', { sessionId: 'user_1' })
    await agent.run('What is my name?', { sessionId: 'user_1' })

    // The second call must see the first exchange plus the new question.
    const second = model.calls[1]
    expect(second?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(second?.messages[0]?.content).toBe('My name is Ada.')
  })

  it('keeps the default store of one agent out of reach of another', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const a = new Agent({ name: 'a', model })
    const b = new Agent({ name: 'b', model })

    await a.run('secret', { sessionId: 'shared-id' })
    await b.run('hello', { sessionId: 'shared-id' })

    expect(model.calls[1]?.messages).toHaveLength(1)
  })

  it('persists only the messages this run produced', async () => {
    const store = memorySession()
    const model = mockProvider([{ text: 'one' }, { text: 'two' }])
    const agent = new Agent({ name: 'a', model, session: store })

    await agent.run('first', { sessionId: 's' })
    await agent.run('second', { sessionId: 's' })

    const stored = await store.load('s')
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
  })

  it('saves nothing when the run throws', async () => {
    const store = memorySession()
    const model = mockProvider([{ error: new Error('provider is down') }])
    const agent = new Agent({ name: 'a', model, session: store, maxRetries: 0 })

    await expect(agent.run('hello', { sessionId: 's' })).rejects.toThrow()

    // A half-written turn is worse than none: an assistant tool-call with no
    // results poisons every later run on this session.
    expect(await store.load('s')).toEqual([])
  })

  it('saves a run that stopped at max_turns', async () => {
    const store = memorySession()
    const model = mockProvider([{ toolCalls: [{ toolName: 'noop' }] }])
    const agent = new Agent({
      name: 'a',
      model,
      session: store,
      maxTurns: 1,
      tools: [tool({ name: 'noop', description: 'does nothing', execute: () => 'ok' })],
    })

    const result = await agent.run('go', { sessionId: 's' })

    expect(result.stopReason).toBe('max_turns')
    expect((await store.load('s')).length).toBeGreaterThan(0)
  })

  it('refuses sessionId and messages together', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model })

    await expect(
      agent.run('hi', { sessionId: 's', messages: [userMessage('earlier')] }),
    ).rejects.toThrow(/either `sessionId` or `messages`/)
  })

  it('streams and persists through the same path as run', async () => {
    const store = memorySession()
    const model = mockProvider([{ text: 'streamed answer' }])
    const agent = new Agent({ name: 'a', model, session: store })

    const stream = agent.stream('hello', { sessionId: 's' })
    for await (const _event of stream) void _event
    await stream

    expect((await store.load('s')).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('trims loaded history without deleting it from the store', async () => {
    const store = memorySession()
    await store.append('s', [
      userMessage('ancient'),
      assistantMessage([{ type: 'text', text: 'old reply' }]),
      userMessage('recent'),
    ])

    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, session: store, context: { maxMessages: 1 } })

    await agent.run('now', { sessionId: 's' })

    // The model saw one message of history plus the new turn...
    expect(model.calls[0]?.messages.map((m) => m.content)).toEqual(['recent', 'now'])
    // ...but nothing was destroyed.
    expect((await store.load('s')).length).toBe(5)
  })

  it('applies the context policy to caller-supplied messages too', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, context: { maxMessages: 1 } })

    await agent.run('now', {
      messages: [userMessage('old'), assistantMessage([{ type: 'text', text: 'older reply' }])],
    })

    expect(model.calls[0]?.messages.map((m) => m.role)).toEqual(['assistant', 'user'])
  })

  it('does not corrupt a session when two runs share it', async () => {
    const store = memorySession()
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, session: store })

    await Promise.all([
      agent.run('first', { sessionId: 's' }),
      agent.run('second', { sessionId: 's' }),
    ])

    const stored = await store.load('s')
    expect(stored).toHaveLength(4)
    expect(
      stored
        .filter((m) => m.role === 'user')
        .map((m) => m.content)
        .sort(),
    ).toEqual(['first', 'second'])
  })

  it('emits session.load and session.save around the run', async () => {
    const store = memorySession()
    await store.append('s', [userMessage('a'), userMessage('b'), userMessage('c')])

    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, session: store, context: { maxMessages: 2 } })
    const events = collectEvents()

    await agent.run('hello', { sessionId: 's', onEvent: events.listener })

    const types = events.types()
    expect(types.indexOf('run.start')).toBe(0)
    expect(types.indexOf('session.load')).toBe(1)
    expect(types.indexOf('session.save')).toBeLessThan(types.indexOf('run.finish'))

    const loaded = events.ofType('session.load')[0]
    expect(loaded?.sessionId).toBe('s')
    expect(loaded?.messageCount).toBe(2)
    expect(loaded?.droppedCount).toBe(1)
    expect(loaded?.truncated).toBe(true)

    expect(events.ofType('session.save')[0]?.appendedCount).toBe(2)
  })

  it('reports truncated: false when the whole transcript was read', async () => {
    const store = memorySession()
    await store.append('s', [userMessage('a')])

    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, session: store, context: { maxMessages: 10 } })
    const events = collectEvents()

    await agent.run('hello', { sessionId: 's', onEvent: events.listener })

    const loaded = events.ofType('session.load')[0]
    expect(loaded?.truncated).toBe(false)
    expect(loaded?.droppedCount).toBe(0)
  })

  it('emits no session events when no session is in use', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const events = collectEvents()

    await new Agent({ name: 'a', model }).run('hi', { onEvent: events.listener })

    expect(events.types().some((type) => type.startsWith('session.'))).toBe(false)
  })
})

describe('the runner bounds the read', () => {
  /** Records what `load` was asked for, and delegates to a real store. */
  function spyStore(
    inner = memorySession(),
  ): SessionStore & { loads: (LoadOptions | undefined)[] } {
    const loads: (LoadOptions | undefined)[] = []
    return {
      loads,
      load: (id, options) => {
        loads.push(options)
        return inner.load(id, options)
      },
      append: (id, messages) => inner.append(id, messages),
      clear: (id) => inner.clear(id),
      pop: (id) => inner.pop?.(id) ?? Promise.resolve(undefined),
    }
  }

  it('passes a limit when maxMessages is set', async () => {
    const store = spyStore()
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, session: store, context: { maxMessages: 8 } })

    await agent.run('hi', { sessionId: 's' })

    // One more than the budget: the extra row is how a truncated read is told
    // apart from a complete one.
    expect(store.loads).toEqual([{ limit: 9 }])
  })

  it('passes no limit when only maxTokens is set', async () => {
    // A token budget gives no safe row count, and guessing low would drop
    // context the policy would have kept.
    const store = spyStore()
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, session: store, context: { maxTokens: 5_000 } })

    await agent.run('hi', { sessionId: 's' })

    expect(store.loads).toEqual([undefined])
  })

  it('passes no limit when there is no context policy', async () => {
    const store = spyStore()
    const model = mockProvider([{ text: 'ok' }])

    await new Agent({ name: 'a', model, session: store }).run('hi', { sessionId: 's' })

    expect(store.loads).toEqual([undefined])
  })

  it('still trims when a store ignores the limit', async () => {
    // `limit` is a hint; `trimHistory` is the guarantee.
    const ignoring: SessionStore = {
      load: () => Promise.resolve([userMessage('1'), userMessage('2'), userMessage('3')]),
      append: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    }
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, session: ignoring, context: { maxMessages: 1 } })

    await agent.run('now', { sessionId: 's' })

    expect(model.calls[0]?.messages.map((m) => m.content)).toEqual(['3', 'now'])
  })
})

describe('agent.session(id)', () => {
  it('binds the id so a chat loop carries no history of its own', async () => {
    const model = mockProvider([{ text: 'Hello Ada.' }, { text: 'You are Ada.' }])
    const chat = new Agent({ name: 'a', model }).session('user_1')

    await chat.run('My name is Ada.')
    const second = await chat.run('What is my name?')

    expect(second.text).toBe('You are Ada.')
    expect(model.calls[1]?.messages).toHaveLength(3)
  })

  it('exposes the transcript and can forget it', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const chat = new Agent({ name: 'a', model, session: memorySession() }).session('user_1')

    await chat.run('hello')
    expect(await chat.messages()).toHaveLength(2)

    await chat.clear()
    expect(await chat.messages()).toEqual([])
  })

  it('walks back an exchange with two pops, then regenerates', async () => {
    const model = mockProvider([{ text: 'first answer' }, { text: 'second answer' }])
    const chat = new Agent({ name: 'a', model, session: memorySession() }).session('user_1')

    await chat.run('what is 2+2')
    expect(await chat.messages()).toHaveLength(2)

    expect((await chat.pop())?.role).toBe('assistant')
    expect((await chat.pop())?.content).toBe('what is 2+2')
    expect(await chat.messages()).toEqual([])

    const again = await chat.run('what is 2 + 2, precisely')
    expect(again.text).toBe('second answer')
    expect(model.calls[1]?.messages).toHaveLength(1)
  })

  it('reads a bounded window of the transcript', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const chat = new Agent({ name: 'a', model, session: memorySession() }).session('user_1')

    await chat.run('one')
    await chat.run('two')

    expect(await chat.messages()).toHaveLength(4)
    expect(await chat.messages({ limit: 2 })).toHaveLength(2)
  })

  it('explains itself when the store cannot pop', async () => {
    const noPop: SessionStore = {
      load: () => Promise.resolve([]),
      append: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    }
    const chat = new Agent({
      name: 'a',
      model: mockProvider([{ text: 'ok' }]),
      session: noPop,
    }).session('user_1')

    expect(() => chat.pop()).toThrow(/does not support pop/)
  })

  it('streams against the bound session', async () => {
    const model = mockProvider([{ text: 'hi there' }])
    const chat = new Agent({ name: 'a', model, session: memorySession() }).session('user_1')

    const stream = chat.stream('hello')
    let text = ''
    for await (const chunk of stream.textStream()) text += chunk

    expect(text).toBe('hi there')
    expect(await chat.messages()).toHaveLength(2)
  })
})
