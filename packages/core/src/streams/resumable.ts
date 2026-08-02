import type { AgentConfig, AgentInput, RunOptions } from '../agent/types.js'
import type { AgentEvent } from '../events/events.js'
import {
  eventsToReadableStream,
  streamHeaders,
  type EventStreamOptions,
} from '../http/to-stream.js'
import type { RunResult } from '../run/result.js'
import { streamAgent, type StreamedRun } from '../run/stream.js'
import { createId } from '../util/id.js'
import { STREAM_ID_PREFIX, type StreamStore } from './store.js'

/**
 * A run that outlives the request that started it.
 *
 * The point is the client, not the server: a browser that loses its connection
 * mid-generation reconnects and picks the answer up where it left off, instead
 * of watching half a reply disappear.
 *
 * It also removes a real failure mode. A normal streamed run wired to
 * `request.signal` is cancelled when the client disconnects, and since only a
 * completed run is persisted, the user loses the exchange they had already
 * watched arrive. A resumable run is not tied to the request, so it finishes and
 * saves on its own.
 */
export interface ResumableRun<TOutput = string> {
  /** Hand this to the client. It is how the run is found again. */
  readonly streamId: string

  /** The run's own id, for traces. */
  readonly runId: string

  /** Resolves when the run finishes, whether or not anyone is listening. */
  readonly completed: Promise<RunResult<TOutput>>

  /** Events from the beginning, as `text/event-stream`. */
  toEventStream(options?: FollowOptions): ReadableStream<Uint8Array>

  /** {@link toEventStream} as a `Response`, carrying `x-stream-id`. */
  toEventResponse(init?: ResponseInit & FollowOptions): Response
}

export interface ResumableOptions extends RunOptions {
  /** Use this stream id rather than generating one. */
  readonly streamId?: string
}

/**
 * Starts a run that records itself, so it can be followed and re-followed.
 *
 * ```ts
 * const run = agent.resumable(message, { sessionId: userId })
 * return run.toEventResponse()
 * ```
 *
 * Note what is *not* passed: `request.signal`. Cancelling on disconnect is the
 * opposite of what this is for. To stop a resumable run early, use an
 * `AbortSignal` you control.
 */
export function startResumable<TOutput = string>(
  config: AgentConfig<unknown>,
  store: StreamStore,
  input: AgentInput,
  options: ResumableOptions = {},
): ResumableRun<TOutput> {
  const { streamId: given, ...runOptions } = options
  const streamId = given ?? createId(STREAM_ID_PREFIX)

  const stream: StreamedRun<TOutput> = streamAgent<TOutput>(config, input, runOptions)

  // Recording happens by consuming the run's own iterator, which means the
  // resumable run *is* the one consumer. Everyone else — including the caller —
  // reads from the store, so any number of readers can follow, and a reader
  // arriving late still gets the whole thing.
  const recording = record(stream, store, streamId)

  return {
    streamId,
    runId: stream.runId,
    completed: recording,

    toEventStream(streamOptions?: FollowOptions): ReadableStream<Uint8Array> {
      return followStream(store, streamId, streamOptions)
    },

    toEventResponse(init?: ResponseInit & FollowOptions): Response {
      const { include, fromIndex, startTimeoutMs, idleTimeoutMs, ...responseInit } = init ?? {}
      const streamOptions: FollowOptions = {
        ...(include !== undefined ? { include } : {}),
        ...(fromIndex !== undefined ? { fromIndex } : {}),
        ...(startTimeoutMs !== undefined ? { startTimeoutMs } : {}),
        ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      }
      const headers = streamHeaders('text/event-stream', stream.runId, responseInit)
      if (!headers.has('x-stream-id')) headers.set('x-stream-id', streamId)
      return new Response(this.toEventStream(streamOptions), { ...responseInit, headers })
    },
  }
}

/**
 * Re-attaches to a recorded run: replays what has already happened, then follows
 * the rest.
 *
 * ```ts
 * const from = Number(request.headers.get('last-event-id') ?? 0)
 * return resumeStream(store, streamId, { fromIndex: from }).toEventResponse()
 * ```
 *
 * A finished run resumes just as well as a running one — the recording is the
 * source of truth, not the process that produced it.
 */
export function resumeStream(
  store: StreamStore,
  streamId: string,
  options: FollowOptions = {},
): { toEventStream(): ReadableStream<Uint8Array>; toEventResponse(init?: ResponseInit): Response } {
  return {
    toEventStream: () => followStream(store, streamId, options),

    toEventResponse(init?: ResponseInit): Response {
      const headers = new Headers(init?.headers)
      if (!headers.has('content-type')) headers.set('content-type', 'text/event-stream')
      if (!headers.has('cache-control')) headers.set('cache-control', 'no-store')
      if (!headers.has('x-accel-buffering')) headers.set('x-accel-buffering', 'no')
      if (!headers.has('x-stream-id')) headers.set('x-stream-id', streamId)
      return new Response(followStream(store, streamId, options), { ...init, headers })
    },
  }
}

/** How long to wait between polls when following a stream that is still running. */
const POLL_INTERVAL_MS = 200

/**
 * How long to keep polling a stream that has produced nothing at all.
 *
 * An unknown id — expired, mistyped, or belonging to another instance's
 * in-memory store — is indistinguishable from a run that has not emitted yet,
 * because both report zero events. Without this bound the follower polls
 * forever and the client hangs holding an open connection. A run emits
 * `run.start` immediately, so a few seconds is generous.
 */
const DEFAULT_START_TIMEOUT_MS = 5_000

/**
 * How long to follow a live stream that has stopped producing.
 *
 * Covers the case the store cannot report: the process that was writing died,
 * so the stream will never be marked done and the tail will never arrive. Long
 * enough not to cut off a slow tool call.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000

/** Bounds on how long a follower waits. Both have sensible defaults. */
export interface FollowOptions extends EventStreamOptions {
  /** Give up if the stream has produced nothing at all. Default 5_000. */
  readonly startTimeoutMs?: number
  /** Give up if a started stream stops producing. Default 60_000. */
  readonly idleTimeoutMs?: number
}

/**
 * Reads a recorded stream to its end: everything from `fromIndex`, then whatever
 * arrives, then done.
 *
 * **It polls.** Redis pub/sub would be lower-latency, but it would tie following
 * to one backend and put a subscription in the interface that in-memory and
 * SQL stores cannot honour. Polling works across processes with any store, in
 * about forty lines, and the interval is well under the gap between tokens. A
 * pub/sub fast path can go inside `redisStreamStore` later without the interface
 * changing.
 */
async function* followEvents(
  store: StreamStore,
  streamId: string,
  fromIndex: number,
  options: FollowOptions,
): AsyncGenerator<AgentEvent> {
  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS

  let cursor = Math.max(0, fromIndex)
  let seenAnything = false
  let lastProgressAt = Date.now()

  for (;;) {
    const events = await store.read(streamId, cursor)

    if (events.length > 0) {
      cursor += events.length
      seenAnything = true
      lastProgressAt = Date.now()
      for (const event of events) yield event
      // Loop again immediately: more may already be waiting, and sleeping here
      // would add latency to a stream that is keeping up.
      continue
    }

    // Status is checked only after a read comes back empty, so an event written
    // between the read and the check is picked up on the next pass rather than
    // lost to an early exit.
    const status = await store.status(streamId)
    if (status.done && cursor >= status.count) return

    if (status.count > 0) seenAnything = true

    // Ending the stream rather than throwing: from a client's point of view a
    // dead stream and a finished one look the same, and an error here would
    // surface as a failed request for a run that may well have succeeded.
    const waited = Date.now() - lastProgressAt
    if (waited >= (seenAnything ? idleTimeoutMs : startTimeoutMs)) return

    await sleep(POLL_INTERVAL_MS)
  }
}

function followStream(
  store: StreamStore,
  streamId: string,
  options: FollowOptions = {},
): ReadableStream<Uint8Array> {
  // The reader has already positioned the log, so the serializer must not skip
  // again — it only has to keep numbering from where the reader started, so the
  // replayed events keep the `id:` values the client will resume from next time.
  const start = options.fromIndex ?? 0
  const { fromIndex: _skipped, startTimeoutMs: _s, idleTimeoutMs: _i, ...rest } = options

  return eventsToReadableStream(
    followEvents(store, streamId, start, options),
    () => {
      // A reader giving up does not stop the run — that is the whole point.
    },
    { ...rest, startIndex: start },
  )
}

/** Consumes the live run once, writing every event to the store. */
async function record<TOutput>(
  stream: StreamedRun<TOutput>,
  store: StreamStore,
  streamId: string,
): Promise<RunResult<TOutput>> {
  try {
    for await (const event of stream) {
      await store.append(streamId, [event])
    }
    const result = await stream.completed
    await store.finish(streamId, 'finish')
    return result
  } catch (cause) {
    // The `run.error` event has already been recorded by the loop above, so a
    // follower sees why it failed before the stream ends.
    await store.finish(streamId, 'error')
    throw cause
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
