/**
 * A `text/event-stream` framer.
 *
 * Deliberately vendor-neutral and in its own file: OpenAI, Anthropic, and Gemini
 * all stream over SSE but disagree about everything above the framing layer.
 * Only the framing is shared, so only the framing lives here.
 *
 * Implements the parts of the WHATWG event-stream grammar that real providers
 * actually use. `retry:` is parsed and discarded — no provider stream reconnects
 * on its own.
 */

/** One dispatched event. Frames carrying no `data` are never surfaced. */
export interface SseEvent {
  /** The `event:` field, or `undefined` for the default (unnamed) event type. */
  readonly event: string | undefined
  /** Concatenated `data:` lines, joined with `\n`. Never empty. */
  readonly data: string
  /**
   * The `id:` field, when present.
   *
   * No provider sets it, but this SDK's own `toEventResponse()` does — it is the
   * event's index in the run, and it is what a reconnecting client resumes from.
   */
  readonly id: string | undefined
}

/**
 * Frames an SSE body into events.
 *
 * Zero dependencies and no `node:` imports — `ReadableStream` and `TextDecoder`
 * are web globals available in Node 20+, Deno, Bun, and workers alike.
 *
 * The stream is always cancelled on the way out, including when the consumer
 * abandons iteration with `break` or `return`, so an unfinished response cannot
 * leak a socket.
 */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        // Flush whatever the decoder is still holding, then dispatch a final
        // frame that arrived without its terminating blank line. Several
        // gateways end the response immediately after `data: [DONE]`.
        buffer += decoder.decode()
        const trailing = decodeFrame(normalize(buffer))
        if (trailing) yield trailing
        return
      }

      buffer += decoder.decode(value, { stream: true })

      // A chunk can end on the `\r` of a `\r\n` pair. Normalising it now would
      // invent a line terminator and split the frame in the wrong place, so the
      // lone `\r` is held back until the next read proves what follows it.
      let pending = ''
      if (buffer.endsWith('\r')) {
        pending = '\r'
        buffer = buffer.slice(0, -1)
      }
      buffer = normalize(buffer) + pending

      // Frames are separated by a blank line.
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary === -1) break

        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        const event = decodeFrame(frame)
        if (event) yield event
      }
    }
  } finally {
    reader.releaseLock()
    // Fire-and-forget: the body may already be closed, and a rejection here
    // would mask whatever error actually ended the stream.
    void body.cancel().catch(() => {})
  }
}

/** Collapses `\r\n` and bare `\r` to `\n`, per the event-stream grammar. */
function normalize(text: string): string {
  return text.replace(/\r\n|\r/g, '\n')
}

/**
 * Turns one frame's raw text into an event, or `undefined` when the frame
 * carries no data — a keep-alive comment, or trailing whitespace at the end of
 * the body.
 */
function decodeFrame(frame: string): SseEvent | undefined {
  if (frame.length === 0) return undefined

  let event: string | undefined
  let id: string | undefined
  const data: string[] = []

  for (const line of frame.split('\n')) {
    // Comment. Load-bearing: OpenRouter sends `: OPENROUTER PROCESSING` as a
    // keep-alive every few seconds, and a parser that JSON-parses it dies
    // partway through an otherwise healthy stream.
    if (line.startsWith(':')) continue

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    // A single leading space after the colon is part of the framing, not the value.
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
    else if (field === 'id') id = value
    // `retry` only matters to a client that reconnects on its own.
  }

  if (data.length === 0) return undefined

  // Multi-line `data:` fields join with a newline — legal, and Gemini uses it.
  return { event, data: data.join('\n'), id }
}
