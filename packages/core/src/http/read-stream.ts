import { ProviderError } from '../errors/errors.js'
import type { AgentEvent } from '../events/events.js'
import { parseSseStream } from '../providers/sse.js'

/**
 * The client half of {@link StreamedRun.toEventResponse}.
 *
 * ```ts
 * const response = await fetch('/api/chat', { method: 'POST', body })
 *
 * for await (const event of readEventStream(response)) {
 *   if (event.type === 'text.delta') ui.append(event.delta)
 *   if (event.type === 'tool.start') ui.showSpinner(event.toolName)
 *   if (event.type === 'run.finish') ui.done(event.usage)
 * }
 * ```
 *
 * Runs anywhere `fetch` does — a browser, a React Native app, another server.
 * It shares the SSE framer the providers use, so chunk-boundary splits,
 * keep-alive comments, and multi-line fields are already handled rather than
 * re-solved here.
 *
 * Events arrive exactly as the server emitted them, minus whatever redaction and
 * filtering it applied. There is no reconstruction of `RunResult`: the last
 * `run.finish` event carries the text, usage, and stop reason.
 */
export async function* readEventStream(
  response: Response | ReadableStream<Uint8Array>,
  options: ReadEventStreamOptions = {},
): AsyncGenerator<AgentEvent> {
  const body = response instanceof Response ? response.body : response

  if (!body) {
    throw new ProviderError('The response has no body to read.', {
      hint: 'A streamed response must be consumed before the body is read elsewhere.',
    })
  }

  for await (const frame of parseSseStream(body)) {
    if (frame.data.length === 0) continue

    let event: AgentEvent
    try {
      event = JSON.parse(frame.data) as AgentEvent
    } catch (cause) {
      throw new ProviderError('An event in the stream was not valid JSON.', {
        cause,
        hint: 'This stream should come from `toEventResponse()`. A proxy that rewrites or truncates response bodies will corrupt it.',
      })
    }

    // Recorded before yielding, so a consumer that reconnects from inside the
    // loop resumes *after* the event it is holding rather than repeating it.
    if (options.cursor && frame.id !== undefined) {
      const index = Number(frame.id)
      if (Number.isInteger(index)) options.cursor.index = index
    }

    yield event
  }
}

export interface ReadEventStreamOptions {
  /**
   * Updated with the index of each event as it arrives, so a dropped connection
   * can be resumed from where it stopped.
   *
   * The index comes from the stream's `id:` field, not from counting locally —
   * the server may filter events, and a local count would drift.
   *
   * ```ts
   * const cursor = { index: -1 }
   * try {
   *   for await (const event of readEventStream(response, { cursor })) { … }
   * } catch {
   *   const resumed = await fetch(`/api/chat/${streamId}?from=${cursor.index + 1}`)
   * }
   * ```
   */
  readonly cursor?: { index: number }
}
