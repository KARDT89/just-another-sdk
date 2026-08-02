import { describe, expect, it } from 'vitest'

import { parseSseStream, type SseEvent } from '../src/providers/sse.js'

/**
 * The SSE framer in isolation — no HTTP, no provider, no agent.
 *
 * Framing bugs are the kind that pass every happy-path test and then corrupt one
 * response in a thousand under real network chunking, so these tests feed the
 * parser adversarially: one byte at a time, split across line terminators, with
 * the keep-alive comments real gateways actually send.
 */

/** A body that delivers exactly the chunks given, in order. */
function streamOf(...chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

/** Splits text into one chunk per byte — the worst case a real socket can produce. */
function byteByByte(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    },
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  for await (const event of parseSseStream(body)) events.push(event)
  return events
}

describe('SSE framing', () => {
  it('parses a well-formed stream', async () => {
    const events = await collect(streamOf('data: one\n\n', 'data: two\n\n', 'data: [DONE]\n\n'))

    expect(events.map((e) => e.data)).toEqual(['one', 'two', '[DONE]'])
  })

  it('reassembles frames when the body arrives one byte at a time', async () => {
    const events = await collect(byteByByte('data: hello\n\ndata: world\n\n'))

    expect(events.map((e) => e.data)).toEqual(['hello', 'world'])
  })

  it('handles CRLF line endings', async () => {
    const events = await collect(streamOf('data: one\r\n\r\ndata: two\r\n\r\n'))

    expect(events.map((e) => e.data)).toEqual(['one', 'two'])
  })

  /**
   * The classic SSE bug: a chunk boundary landing between the `\r` and the `\n`.
   * Normalising the `\r` immediately invents a line terminator, which splits the
   * frame in the wrong place and truncates it.
   */
  it('handles a chunk that ends on the CR of a CRLF pair', async () => {
    const events = await collect(streamOf('data: split\r', '\n\r\n', 'data: after\r\n\r\n'))

    expect(events.map((e) => e.data)).toEqual(['split', 'after'])
  })

  it('discards comment lines', async () => {
    // Exactly what OpenRouter emits as a keep-alive.
    const events = await collect(
      streamOf(': OPENROUTER PROCESSING\n\n', 'data: real\n\n', ': ping\n\n'),
    )

    expect(events.map((e) => e.data)).toEqual(['real'])
  })

  it('joins multi-line data fields with a newline', async () => {
    const events = await collect(streamOf('data: first\ndata: second\n\n'))

    expect(events[0]?.data).toBe('first\nsecond')
  })

  it('records the event name and strips one leading space from values', async () => {
    const events = await collect(streamOf('event: error\ndata:  two-spaces\n\n'))

    expect(events[0]?.event).toBe('error')
    // One space is framing, the second is content.
    expect(events[0]?.data).toBe(' two-spaces')
  })

  it('emits a final frame that arrived without its trailing blank line', async () => {
    // Several gateways close the connection straight after `[DONE]`.
    const events = await collect(streamOf('data: one\n\n', 'data: [DONE]'))

    expect(events.map((e) => e.data)).toEqual(['one', '[DONE]'])
  })

  it('ignores frames carrying no data', async () => {
    const events = await collect(streamOf('id: 1\nretry: 500\n\n', 'data: real\n\n'))

    expect(events).toHaveLength(1)
  })

  /**
   * An abandoned stream must not leak its socket. The body here never closes on
   * its own — exactly like a real response the consumer walks away from — so
   * only an explicit cancel can end it.
   */
  it('cancels the body when the consumer stops early', async () => {
    let cancelled = false
    const encoder = new TextEncoder()

    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode('data: endless\n\n'))
      },
      cancel() {
        cancelled = true
      },
    })

    for await (const event of parseSseStream(body)) {
      expect(event.data).toBe('endless')
      break
    }

    // `cancel()` settles a microtask after the generator's `finally` runs.
    await Promise.resolve()
    expect(cancelled).toBe(true)
  })
})
