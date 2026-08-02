import type { AgentEvent } from '../events/events.js'
import { redact } from '../util/redact.js'

/**
 * Turning a run into something the web platform understands.
 *
 * Everything here is runtime-neutral — `ReadableStream`, `TextEncoder`, and
 * `Response` are all web standards available in Node ≥ 20, Bun, Deno, and
 * Workers. Nothing in this file imports a `node:` builtin, which is what lets it
 * live in the package root rather than behind its own entry point.
 */

const encoder = new TextEncoder()

/**
 * Bridges an async iterable of strings to a `ReadableStream` of UTF-8 bytes.
 *
 * `cancel` is wired to the run's abort so that a client hanging up actually
 * stops the work — a browser closing the tab should not leave a model call
 * running and billing.
 */
export function textToReadableStream(
  source: AsyncIterable<string>,
  onCancel: () => void,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) {
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(next.value))
      } catch (cause) {
        controller.error(cause)
      }
    },

    cancel() {
      onCancel()
    },
  })
}

/** Options for {@link eventsToReadableStream}. */
export interface EventStreamOptions {
  /**
   * Which event types to send.
   *
   * Defaults to everything except `model.request`, which carries the full tool
   * JSON Schemas and is server-shaped detail a browser has no use for.
   */
  readonly include?: readonly AgentEvent['type'][]

  /**
   * Skip events numbered below this. For replaying part of a live run.
   */
  readonly fromIndex?: number

  /**
   * What to number the first event of this stream.
   *
   * A resumed stream has already been positioned by its reader, so it must not
   * start counting from zero again — event 40 has to keep saying `id: 40`, or
   * the client's next reconnect asks to resume from the wrong place.
   *
   * @internal
   */
  readonly startIndex?: number
}

const DEFAULT_EXCLUDED: readonly AgentEvent['type'][] = ['model.request']

/**
 * Serialises a run's events as `text/event-stream`.
 *
 * ```text
 * event: tool.start
 * id: 4
 * data: {"toolName":"get_weather","input":{"city":"Paris"}}
 * ```
 *
 * The `id:` field is the event's index in the run. Browsers echo the last one
 * back as `Last-Event-ID` when an `EventSource` reconnects, which is what makes
 * resuming work without any client code.
 *
 * **Every payload is redacted first.** These bytes leave the server, so a tool
 * that handles credentials must not leak them to a client — the same rule
 * `consoleTracer` follows before printing.
 */
export function eventsToReadableStream(
  source: AsyncIterable<AgentEvent>,
  onCancel: () => void,
  options: EventStreamOptions = {},
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  const include = options.include
  const fromIndex = options.fromIndex ?? 0

  // Numbered by position in the *source*, before filtering — not by position in
  // the output. A resumed stream is replayed from a recording that kept every
  // event, so the two only line up if `include` cannot shift the numbering.
  let index = options.startIndex ?? 0

  const wanted = (event: AgentEvent): boolean =>
    include ? include.includes(event.type) : !DEFAULT_EXCLUDED.includes(event.type)

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const next = await iterator.next()
          if (next.done) {
            controller.close()
            return
          }

          const event = next.value
          const at = index
          index += 1

          if (!wanted(event) || at < fromIndex) continue

          controller.enqueue(encoder.encode(formatSseEvent(event, at)))
          return
        }
      } catch (cause) {
        controller.error(cause)
      }
    },

    cancel() {
      onCancel()
    },
  })
}

/**
 * One SSE frame.
 *
 * `data` is a single line because `JSON.stringify` never emits a raw newline —
 * were that not true, every line would need its own `data:` prefix.
 */
export function formatSseEvent(event: AgentEvent, index: number): string {
  const payload = JSON.stringify(redact(event))
  return `event: ${event.type}\nid: ${index}\ndata: ${payload}\n\n`
}

/** Headers every streamed response needs, merged under the caller's own. */
export function streamHeaders(contentType: string, runId: string, init?: ResponseInit): Headers {
  const headers = new Headers(init?.headers)
  if (!headers.has('content-type')) headers.set('content-type', contentType)
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store')
  // Nginx and friends buffer proxied responses by default, which turns a token
  // stream into one delivery at the end. This is the documented opt-out.
  if (!headers.has('x-accel-buffering')) headers.set('x-accel-buffering', 'no')
  if (!headers.has('x-run-id')) headers.set('x-run-id', runId)
  return headers
}
