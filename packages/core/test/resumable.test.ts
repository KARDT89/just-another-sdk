import { beforeEach, describe, expect, it } from 'vitest'

import { Agent, memorySession, readEventStream, memoryStreamStore } from '../src/index.js'
import type { AgentEvent, StreamStore } from '../src/index.js'
import { redisStreamStore } from '../src/streams/redis.js'
import { resumeStream } from '../src/streams/resumable.js'
import { mockProvider } from '../src/testing/index.js'

/**
 * A resumable run is defined by two properties, and they are the whole point:
 *
 *   1. It **outlives the reader.** A client hanging up must not cancel the run,
 *      and must not cost the user the exchange they already watched arrive.
 *   2. It can be **read again from anywhere**, including from index N, including
 *      after it is over.
 */

/* ------------------------------------------------------------------------- */
/* A fake Redis, so the second store gets the same contract run against it    */
/* ------------------------------------------------------------------------- */

function fakeRedis() {
  const lists = new Map<string, string[]>()
  const values = new Map<string, string>()
  return {
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
    async lLen(key: string): Promise<number> {
      return (lists.get(key) ?? []).length
    },
    async set(key: string, value: string): Promise<string> {
      values.set(key, value)
      return 'OK'
    },
    async get(key: string): Promise<string | null> {
      return values.get(key) ?? null
    },
    async expire(): Promise<number> {
      return 1
    },
  }
}

const stores: { name: string; create: () => StreamStore }[] = [
  { name: 'memoryStreamStore', create: () => memoryStreamStore() },
  { name: 'redisStreamStore', create: () => redisStreamStore(fakeRedis()) },
]

const event = (n: number): AgentEvent => ({
  type: 'text.delta',
  id: `e${n}`,
  timestamp: n,
  runId: 'r',
  agentName: 'a',
  turn: 1,
  delta: `${n}`,
})

describe.each(stores)('StreamStore contract — $name', ({ create }) => {
  let store: StreamStore

  beforeEach(() => {
    store = create()
  })

  it('reports an unknown stream as empty and unfinished', async () => {
    expect(await store.read('nope', 0)).toEqual([])
    expect(await store.status('nope')).toMatchObject({ count: 0, done: false })
  })

  it('appends and reads back in order', async () => {
    await store.append('s', [event(1), event(2)])
    await store.append('s', [event(3)])

    expect((await store.read('s', 0)).map((e) => (e as { delta: string }).delta)).toEqual([
      '1',
      '2',
      '3',
    ])
  })

  it('reads from an index', async () => {
    await store.append('s', [event(1), event(2), event(3)])

    expect((await store.read('s', 1)).map((e) => (e as { delta: string }).delta)).toEqual([
      '2',
      '3',
    ])
    expect(await store.read('s', 3)).toEqual([])
  })

  it('records the outcome', async () => {
    await store.append('s', [event(1)])
    expect(await store.status('s')).toMatchObject({ count: 1, done: false })

    await store.finish('s', 'finish')

    expect(await store.status('s')).toMatchObject({ count: 1, done: true, outcome: 'finish' })
  })

  it('records a failure as a distinct outcome', async () => {
    await store.append('s', [event(1)])
    await store.finish('s', 'error')

    expect(await store.status('s')).toMatchObject({ done: true, outcome: 'error' })
  })

  it('ignores an empty append', async () => {
    await store.append('s', [])
    expect(await store.status('s')).toMatchObject({ count: 0 })
  })
})

describe('agent.resumable', () => {
  it('reads the whole run from the recording', async () => {
    const model = mockProvider([{ text: 'hello there' }])
    const run = new Agent({ name: 'a', model }).resumable('hi')

    const received: AgentEvent[] = []
    for await (const e of readEventStream(run.toEventResponse())) received.push(e)

    expect(received[0]?.type).toBe('run.start')
    expect(received.at(-1)?.type).toBe('run.finish')
    expect(
      received
        .filter((e) => e.type === 'text.delta')
        .map((e) => e.delta)
        .join(''),
    ).toBe('hello there')
  })

  it('hands back a stream id and a run id', () => {
    const model = mockProvider([{ text: 'ok' }])
    const run = new Agent({ name: 'a', model }).resumable('hi')

    expect(run.streamId).toMatch(/^stream_/)
    expect(run.runId).toMatch(/^run_/)
  })

  it('puts the stream id on the response, so a client can reconnect', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const run = new Agent({ name: 'a', model }).resumable('hi')
    const response = run.toEventResponse()

    expect(response.headers.get('x-stream-id')).toBe(run.streamId)
    expect(response.headers.get('content-type')).toBe('text/event-stream')

    await response.text()
  })

  it('completes even though nobody ever reads it', async () => {
    const store = memorySession()
    const model = mockProvider([{ text: 'answered into the void' }])
    const agent = new Agent({ name: 'a', model, session: store })

    const run = agent.resumable('hi', { sessionId: 's' })
    const result = await run.completed

    expect(result.text).toBe('answered into the void')
    // This is the bug a resumable run fixes: a disconnected ordinary run saves
    // nothing, and the user loses the exchange they already watched arrive.
    expect((await store.load('s')).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('survives a reader that gives up halfway', async () => {
    const model = mockProvider([{ text: 'one two three four five', chunkDelayMs: 5 }])
    const run = new Agent({ name: 'a', model }).resumable('hi')

    // Read a couple of events, then walk away — as a browser tab closing does.
    const reader = run.toEventStream().getReader()
    await reader.read()
    await reader.cancel()

    const result = await run.completed
    expect(result.text).toBe('one two three four five')
  })
})

describe('agent.resume', () => {
  it('replays a finished run from the beginning', async () => {
    const model = mockProvider([{ text: 'hello there' }])
    const agent = new Agent({ name: 'a', model })

    const run = agent.resumable('hi')
    await run.completed

    const received: AgentEvent[] = []
    for await (const e of readEventStream(agent.resume(run.streamId).toEventResponse())) {
      received.push(e)
    }

    expect(received.at(-1)?.type).toBe('run.finish')
  })

  it('resumes from an index without renumbering', async () => {
    const model = mockProvider([{ text: 'a b c d' }])
    const agent = new Agent({ name: 'a', model })

    const run = agent.resumable('hi')
    await run.completed

    const body = await agent.resume(run.streamId, { fromIndex: 3 }).toEventResponse().text()
    const ids = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))

    // Positions in the run, not in this response — otherwise the client's next
    // reconnect would ask to start from the wrong place.
    expect(ids[0]).toBe(3)
  })

  it('picks up a run that is still going, then follows it to the end', async () => {
    const model = mockProvider([{ text: 'one two three four five six', chunkDelayMs: 10 }])
    const agent = new Agent({ name: 'a', model })

    const run = agent.resumable('hi')

    // Join while it is mid-flight.
    await new Promise((resolve) => setTimeout(resolve, 25))

    const received: AgentEvent[] = []
    for await (const e of readEventStream(agent.resume(run.streamId).toEventResponse())) {
      received.push(e)
    }

    // A late joiner still gets the beginning, because the recording has it.
    expect(received[0]?.type).toBe('run.start')
    expect(received.at(-1)?.type).toBe('run.finish')
    expect(
      received
        .filter((e) => e.type === 'text.delta')
        .map((e) => e.delta)
        .join(''),
    ).toBe('one two three four five six')
  })

  it('lets two readers follow the same run independently', async () => {
    const model = mockProvider([{ text: 'shared answer', chunkDelayMs: 5 }])
    const agent = new Agent({ name: 'a', model })
    const run = agent.resumable('hi')

    const read = async (): Promise<string> => {
      const events: AgentEvent[] = []
      for await (const e of readEventStream(agent.resume(run.streamId).toEventResponse())) {
        events.push(e)
      }
      return events
        .filter((e) => e.type === 'text.delta')
        .map((e) => e.delta)
        .join('')
    }

    const [first, second] = await Promise.all([read(), read()])

    expect(first).toBe('shared answer')
    expect(second).toBe(first)
  })

  it('reaches the end of a failed run rather than hanging', async () => {
    const model = mockProvider([{ error: new Error('provider is down') }])
    const agent = new Agent({ name: 'a', model, maxRetries: 0 })

    const run = agent.resumable('hi')
    await expect(run.completed).rejects.toThrow()

    const received: AgentEvent[] = []
    for await (const e of readEventStream(agent.resume(run.streamId).toEventResponse())) {
      received.push(e)
    }

    // The failure is in the recording, so a reconnecting client learns why
    // instead of watching the stream stop for no stated reason.
    expect(received.at(-1)?.type).toBe('run.error')
  })

  it('resumes with a client-supplied stream id', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model })

    const run = agent.resumable('hi', { streamId: 'stream_mine' })
    expect(run.streamId).toBe('stream_mine')

    await run.completed
    const body = await agent.resume('stream_mine').toEventResponse().text()
    expect(body).toContain('run.finish')
  })

  it('keeps one agent-s streams out of another-s', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const a = new Agent({ name: 'a', model })
    const b = new Agent({ name: 'b', model })

    const run = a.resumable('hi')
    await run.completed

    // `b` has its own default store, so the id means nothing there.
    const body = await b.resume(run.streamId, { startTimeoutMs: 50 }).toEventResponse().text()
    expect(body).toBe('')
  })

  it('gives up on an unknown stream instead of holding the connection open', async () => {
    // Expired, mistyped, or living in another instance's memory — all look the
    // same from here, and none of them should hang a client forever.
    const agent = new Agent({ name: 'a', model: mockProvider([{ text: 'ok' }]) })

    const startedAt = Date.now()
    const body = await agent
      .resume('stream_does_not_exist', { startTimeoutMs: 100 })
      .toEventResponse()
      .text()

    expect(body).toBe('')
    expect(Date.now() - startedAt).toBeLessThan(2_000)
  })

  it('gives up on a stream whose writer died without finishing it', async () => {
    // Nothing marks this stream done, so only the idle timeout ends it.
    const store = memoryStreamStore()
    await store.append('orphan', [event(1)])

    const received: AgentEvent[] = []
    for await (const e of readEventStream(
      resumeStream(store, 'orphan', { idleTimeoutMs: 100 }).toEventResponse(),
    )) {
      received.push(e)
    }

    expect(received).toHaveLength(1)
  })
})
