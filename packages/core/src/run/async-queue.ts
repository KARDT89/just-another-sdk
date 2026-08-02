/**
 * A single-producer, single-consumer queue bridging a callback to an async
 * iterator.
 *
 * The agent loop reports progress by calling a listener synchronously; a
 * `for await` consumer pulls. This is the adapter between the two.
 *
 * **Unbounded, deliberately.** Three alternatives were considered and rejected:
 *
 *   1. *Blocking the producer.* The emitter contractually never awaits a
 *      listener, so that instrumentation cannot slow down or reorder a run.
 *      Making `push` block would break that for every `onEvent` consumer, not
 *      just streaming ones, and would deadlock outright if a handler awaited
 *      anything that depends on the loop.
 *   2. *Dropping.* Silently corrupt for a text stream.
 *   3. *Real backpressure.* To slow the model you must stop reading its socket.
 *      The model keeps generating and you keep paying for it; you have stalled a
 *      TCP window and saved nothing.
 *
 * The buffer is bounded in practice by the run itself: at most `maxTurns` model
 * calls, each capped by `maxOutputTokens`, and every streamed token is already
 * retained in `RunState.messages` for the final result. The worst case is a
 * constant factor on memory the run holds anyway.
 *
 * @internal
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = []
  private readonly waiting: {
    resolve: (result: IteratorResult<T>) => void
    reject: (error: Error) => void
  }[] = []

  private closed = false
  private detached = false
  private failure: { error: Error } | undefined

  /** Never throws and never blocks — safe to call from a synchronous emitter. */
  push(value: T): void {
    if (this.closed || this.detached) return

    const next = this.waiting.shift()
    if (next) {
      next.resolve({ value, done: false })
      return
    }
    this.buffer.push(value)
  }

  /** No more values. Parked consumers finish once the buffer drains. */
  close(): void {
    if (this.closed) return
    this.closed = true

    while (this.waiting.length > 0) {
      this.waiting.shift()?.resolve({ value: undefined, done: true })
    }
  }

  /**
   * The producer failed.
   *
   * The buffer is *not* discarded: everything already queued is yielded first
   * and the error surfaces after it. That is what lets a failing run deliver its
   * `run.error` event to the iterator and *then* throw the same error, rather
   * than swallowing the explanation of what went wrong.
   */
  fail(error: Error): void {
    if (this.closed) return
    this.closed = true
    this.failure = { error }

    // Only a consumer parked on an empty buffer sees this immediately; anything
    // buffered is drained by `next()` before the error is reached.
    while (this.buffer.length === 0 && this.waiting.length > 0) {
      this.waiting.shift()?.reject(error)
    }
  }

  /**
   * Stop buffering and release what is held. The producer keeps running — this
   * is abandonment by the consumer, not cancellation of the work.
   */
  detach(): void {
    this.detached = true
    this.buffer.length = 0
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.buffer.shift()
        if (value !== undefined) return Promise.resolve({ value, done: false })

        if (this.failure) return Promise.reject(this.failure.error)
        if (this.closed) return Promise.resolve({ value: undefined, done: true })

        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiting.push({ resolve, reject })
        })
      },

      // `break` or `return` in a `for await`. Detaching rather than failing is
      // deliberate: abandoning the iterator does not abandon the run.
      return: (): Promise<IteratorResult<T>> => {
        this.detach()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}
