import type { AgentConfig, AgentInput, RunOptions } from '../agent/types.js'
import { AbortError, ConfigurationError, toAgentError } from '../errors/errors.js'
import type { AgentEvent } from '../events/events.js'
import { AsyncQueue } from './async-queue.js'
import type { RunResult } from './result.js'
import { executeRun } from './runner.js'

/**
 * What `agent.stream()` returns: an async iterable of events that is *also*
 * awaitable for the final result.
 *
 * ```ts
 * const stream = agent.stream('Write a haiku about TypeScript.')
 *
 * for await (const event of stream) {
 *   if (event.type === 'text.delta') process.stdout.write(event.delta)
 * }
 *
 * const result = await stream   // the same run, now finished
 * ```
 *
 * Both halves are optional. Awaiting without iterating is a normal `run()` that
 * happens to buffer events; iterating without awaiting is a pure UI feed.
 *
 * > **Returning one from an `async` function unwraps it.** Any object with a
 * > `then` method is recursively resolved by the promise machinery, so
 * > `async function go() { return agent.stream(p) }` hands back a `RunResult`,
 * > not a `StreamedRun`. Wrap it — `return { stream: agent.stream(p) }` — when
 * > it has to cross an `async` boundary intact.
 */
export interface StreamedRun<TOutput = string>
  extends AsyncIterable<AgentEvent>, PromiseLike<RunResult<TOutput>> {
  /**
   * The final result as a real promise, for `.catch()` and `.finally()`, which
   * `PromiseLike` does not provide.
   */
  readonly completed: Promise<RunResult<TOutput>>

  /**
   * Just the streamed text, for the common rendering case. Consumes the same
   * single iteration as the event stream — use one or the other.
   */
  textStream(): AsyncIterable<string>

  /** Abandon the run: the in-flight model call and any running tools are aborted. */
  abort(reason?: string): void
}

/**
 * Runs an agent, exposing progress as it happens.
 *
 * This is not a second agent loop. It runs the *same* `executeRun` with a
 * forwarding listener attached, so streaming cannot drift from non-streaming
 * behaviour: there is one implementation of the loop, its invariants, and its
 * ordering guarantees.
 */
export function streamAgent<TOutput = string>(
  config: AgentConfig,
  input: AgentInput,
  options: RunOptions = {},
): StreamedRun<TOutput> {
  const queue = new AsyncQueue<AgentEvent>()
  const controller = new AbortController()

  // The caller's signal and `.abort()` compose: either one cancels the run.
  const callerSignal = options.signal
  let detachCaller = (): void => {}

  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort(callerSignal.reason)
    } else {
      const onAbort = () => controller.abort(callerSignal.reason)
      callerSignal.addEventListener('abort', onAbort, { once: true })
      detachCaller = () => callerSignal.removeEventListener('abort', onAbort)
    }
  }

  // Started eagerly rather than on first `next()`. `await agent.stream(p)` with
  // no iteration has to work, and so does firing the request now to render it
  // later.
  const completed = executeRun<TOutput>(
    config,
    input,
    {
      ...options,
      signal: controller.signal,
      onEvent: (event: AgentEvent) => {
        queue.push(event)
        // The caller's own listener still fires. Subscribing to events and
        // streaming them are not mutually exclusive.
        options.onEvent?.(event)
      },
    },
    { streaming: true },
  ).then(
    (result) => {
      queue.close()
      detachCaller()
      return result
    },
    (error: unknown) => {
      // `executeRun` only ever rejects with an `AgentError`; normalising anyway
      // guarantees the iterator and the promise fail with the same object.
      const agentError = toAgentError(error)
      queue.fail(agentError)
      detachCaller()
      throw agentError
    },
  )

  // A consumer who only iterates never attaches a rejection handler to this
  // promise, which would surface as a process-level `unhandledRejection` on
  // every failing run. Marking it handled here does not stop `completed` from
  // rejecting for someone who does await it.
  void completed.catch(() => {})

  let consumed = false
  const iterate = (): AsyncIterator<AgentEvent> => {
    if (consumed) {
      throw new ConfigurationError('This streamed run has already been iterated.', {
        hint: 'A run streams to one consumer. Use `.completed` for the final result, or collect the events you need in a single loop.',
      })
    }
    consumed = true
    return queue[Symbol.asyncIterator]()
  }

  return {
    completed,

    then: (onFulfilled, onRejected) => completed.then(onFulfilled, onRejected),

    [Symbol.asyncIterator]: iterate,

    textStream(): AsyncIterable<string> {
      const events = iterate()
      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const next = await events.next()
            if (next.done) return
            if (next.value.type === 'text.delta') yield next.value.delta
          }
        },
      }
    },

    abort(reason?: string): void {
      controller.abort(new AbortError(reason ?? 'The streamed run was aborted.'))
    },
  }
}
