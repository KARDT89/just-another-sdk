import { describe, expect, it } from 'vitest'

import {
  Agent,
  AuthenticationError,
  NetworkError,
  RateLimitError,
  type AgentEvent,
} from '../src/index.js'
import { backoffDelay, resolveRetryPolicy } from '../src/run/retry.js'
import { mockProvider } from '../src/testing/index.js'

/**
 * Retries, backoff, and model fallback.
 *
 * Every test here pins `retryDelayMs` to 1 so the suite stays fast: the *timing*
 * of the backoff is asserted directly against `backoffDelay` with a stubbed
 * random source, which is both exact and instant.
 */

const FAST = { retryDelayMs: 1, maxRetryDelayMs: 50 } as const

/** Collects events without caring about the result. */
function recorder(): { events: AgentEvent[]; onEvent: (event: AgentEvent) => void } {
  const events: AgentEvent[] = []
  return { events, onEvent: (event) => events.push(event) }
}

describe('retry', () => {
  it('retries a rate limit and then succeeds', async () => {
    const model = mockProvider((_request, index) =>
      index === 0 ? { error: new RateLimitError('slow down') } : { text: 'Recovered.' },
    )

    const { events, onEvent } = recorder()
    const agent = new Agent({ name: 'a', model, ...FAST })
    const result = await agent.run('go', { onEvent })

    expect(result.text).toBe('Recovered.')
    expect(model.calls).toHaveLength(2)

    const retries = events.filter((e) => e.type === 'model.retry')
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({ attempt: 1, maxAttempts: 3, discardedText: '' })
  })

  it('gives up after maxRetries and rejects with the original error', async () => {
    const failure = new RateLimitError('still limited')
    const model = mockProvider([{ error: failure }])

    const agent = new Agent({ name: 'a', model, maxRetries: 2, ...FAST })

    await expect(agent.run('go')).rejects.toBe(failure)
    expect(model.calls).toHaveLength(3)
  })

  it('never retries an authentication failure', async () => {
    const model = mockProvider([{ error: new AuthenticationError('bad key') }])
    const agent = new Agent({ name: 'a', model, ...FAST })

    await expect(agent.run('go')).rejects.toMatchObject({ code: 'authentication_error' })
    expect(model.calls).toHaveLength(1)
  })

  it('never retries a call cancelled in flight', async () => {
    const controller = new AbortController()
    const model = mockProvider([{ text: 'too late', delayMs: 500 }])
    const agent = new Agent({ name: 'a', model, ...FAST })

    const promise = agent.run('go', { signal: controller.signal })
    // Let the call actually start, so this exercises cancellation of an
    // in-flight request rather than the pre-loop abort check.
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()

    await expect(promise).rejects.toMatchObject({ code: 'aborted' })
    expect(model.calls).toHaveLength(1)
  })

  it('honours maxRetries: 0 as "do not retry"', async () => {
    const model = mockProvider([{ error: new NetworkError('connection reset') }])
    const agent = new Agent({ name: 'a', model, maxRetries: 0, ...FAST })

    await expect(agent.run('go')).rejects.toMatchObject({ code: 'network_error' })
    expect(model.calls).toHaveLength(1)
  })

  it('lets a run option override the agent’s maxRetries', async () => {
    const model = mockProvider([{ error: new NetworkError('down') }])
    const agent = new Agent({ name: 'a', model, maxRetries: 5, ...FAST })

    await expect(agent.run('go', { maxRetries: 1 })).rejects.toMatchObject({
      code: 'network_error',
    })
    expect(model.calls).toHaveLength(2)
  })

  it('lets retryOn override the default predicate in both directions', async () => {
    // Retries something the default would not.
    const stubborn = mockProvider((_request, index) =>
      index === 0 ? { error: new AuthenticationError('bad key') } : { text: 'ok' },
    )
    const forced = new Agent({
      name: 'a',
      model: stubborn,
      ...FAST,
      retryOn: (error) => error.code === 'authentication_error',
    })
    await expect(forced.run('go')).resolves.toMatchObject({ text: 'ok' })
    expect(stubborn.calls).toHaveLength(2)

    // Refuses something the default would retry.
    const limited = mockProvider([{ error: new RateLimitError('slow down') }])
    const refuses = new Agent({
      name: 'a',
      model: limited,
      ...FAST,
      retryOn: () => false,
    })
    await expect(refuses.run('go')).rejects.toMatchObject({ code: 'rate_limit_error' })
    expect(limited.calls).toHaveLength(1)
  })

  it('aborts promptly during a backoff instead of sleeping it out', async () => {
    const controller = new AbortController()
    const model = mockProvider([{ error: new NetworkError('down') }])
    // A backoff long enough that sleeping it out would be obvious.
    const agent = new Agent({
      name: 'a',
      model,
      retryDelayMs: 5_000,
      maxRetryDelayMs: 5_000,
    })

    const startedAt = Date.now()
    const promise = agent.run('go', { signal: controller.signal })

    // Let the first attempt fail and the backoff begin.
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()

    await expect(promise).rejects.toMatchObject({ code: 'aborted' })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })
})

describe('backoff', () => {
  const policy = resolveRetryPolicy({
    name: 'a',
    model: mockProvider([]),
    retryDelayMs: 100,
    maxRetryDelayMs: 10_000,
  })

  it('follows an exponential curve with full jitter', () => {
    // With random() pinned to 1, the delay is the cap itself: 100, 200, 400.
    expect(backoffDelay(1, policy, undefined, () => 1)).toBe(100)
    expect(backoffDelay(2, policy, undefined, () => 1)).toBe(200)
    expect(backoffDelay(3, policy, undefined, () => 1)).toBe(400)

    // Jitter spreads retries across the whole window, not just its end.
    expect(backoffDelay(3, policy, undefined, () => 0)).toBe(0)
    expect(backoffDelay(3, policy, undefined, () => 0.5)).toBe(200)
  })

  it('clamps the curve at maxRetryDelayMs', () => {
    expect(backoffDelay(20, policy, undefined, () => 1)).toBe(10_000)
  })

  /**
   * `Retry-After` is a floor. Sleeping exactly what the server asked guarantees
   * every rate-limited client returns in the same millisecond; jittering below
   * it guarantees a second 429.
   */
  it('treats Retry-After as a floor and adds jitter on top', () => {
    expect(backoffDelay(1, policy, 2_000, () => 0)).toBe(2_000)
    expect(backoffDelay(1, policy, 2_000, () => 1)).toBe(2_100)
  })

  /**
   * The rule that keeps a `retry-after: 30` response from blocking a caller's
   * `await` for a minute. The error still carries `retryAfterMs`, so scheduling
   * it remains the caller's option.
   */
  it('refuses to honour a Retry-After longer than the cap', () => {
    expect(backoffDelay(1, policy, 30_000, () => 0)).toBeNull()
  })
})

describe('model fallback', () => {
  it('falls back once the primary is exhausted', async () => {
    const primary = mockProvider([{ error: new NetworkError('primary down') }], {
      providerId: 'p1',
      modelId: 'vendor-a/model',
    })
    const backup = mockProvider([{ text: 'Served by the backup.' }], {
      providerId: 'p2',
      modelId: 'vendor-b/model',
    })

    const { events, onEvent } = recorder()
    const agent = new Agent({
      name: 'a',
      model: primary,
      fallbacks: [backup],
      maxRetries: 1,
      ...FAST,
    })

    const result = await agent.run('go', { onEvent })

    expect(result.text).toBe('Served by the backup.')
    expect(primary.calls).toHaveLength(2) // initial + one retry
    expect(backup.calls).toHaveLength(1)

    // The trace records which model actually served the turn.
    expect(result.steps[0]?.modelId).toBe('vendor-b/model')
    expect(result.modelId).toBe('vendor-b/model')

    const fallbacks = events.filter((e) => e.type === 'model.fallback')
    expect(fallbacks).toHaveLength(1)
    expect(fallbacks[0]).toMatchObject({
      fromModelId: 'vendor-a/model',
      toModelId: 'vendor-b/model',
      index: 1,
    })
  })

  /**
   * A bad key or an unknown model on the primary is exactly when a second vendor
   * should take over — waiting for retries that can never succeed would be
   * pointless.
   */
  it('falls back on a non-retryable failure without retrying it', async () => {
    const primary = mockProvider([{ error: new AuthenticationError('bad key') }])
    const backup = mockProvider([{ text: 'Backup answered.' }], { modelId: 'backup/model' })

    const agent = new Agent({ name: 'a', model: primary, fallbacks: [backup], ...FAST })
    const result = await agent.run('go')

    expect(result.text).toBe('Backup answered.')
    expect(primary.calls).toHaveLength(1)
  })

  it('does not fall back on cancellation', async () => {
    const controller = new AbortController()
    const primary = mockProvider([{ text: 'slow', delayMs: 200 }])
    const backup = mockProvider([{ text: 'should never run' }])

    const agent = new Agent({ name: 'a', model: primary, fallbacks: [backup], ...FAST })

    const promise = agent.run('go', { signal: controller.signal })
    controller.abort()

    await expect(promise).rejects.toMatchObject({ code: 'aborted' })
    expect(backup.calls).toHaveLength(0)
  })

  it('rejects with the last provider’s error when the whole chain fails', async () => {
    const primary = mockProvider([{ error: new NetworkError('primary down') }])
    const backup = mockProvider([{ error: new AuthenticationError('backup key invalid') }])

    const agent = new Agent({
      name: 'a',
      model: primary,
      fallbacks: [backup],
      maxRetries: 0,
      ...FAST,
    })

    await expect(agent.run('go')).rejects.toMatchObject({
      code: 'authentication_error',
      message: expect.stringContaining('backup key invalid'),
    })
  })

  /**
   * A transient outage must not permanently demote the preferred model, so the
   * chain restarts from the primary on every turn.
   */
  it('resets to the primary at the start of each turn', async () => {
    let primaryCalls = 0
    const primary = mockProvider(
      () => {
        primaryCalls += 1
        // Fails only on the first turn.
        return primaryCalls === 1
          ? { error: new NetworkError('blip') }
          : { text: 'Primary is back.' }
      },
      { modelId: 'primary/model' },
    )

    const backup = mockProvider([{ toolCalls: [{ toolName: 'noop', input: {} }] }], {
      modelId: 'backup/model',
    })

    const { tool } = await import('../src/index.js')
    const noop = tool({
      name: 'noop',
      description: 'Does nothing.',
      inputSchema: (await import('zod')).object({}),
      execute: () => 'ok',
    })

    const agent = new Agent({
      name: 'a',
      model: primary,
      fallbacks: [backup],
      tools: [noop],
      maxRetries: 0,
      ...FAST,
    })

    const result = await agent.run('go')

    // Turn 1 fell back to the backup, turn 2 went to the primary again.
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0]?.modelId).toBe('backup/model')
    expect(result.steps[1]?.modelId).toBe('primary/model')
  })

  it('emits neither retry nor fallback on a clean run', async () => {
    const model = mockProvider([{ text: 'First try.' }])
    const { events, onEvent } = recorder()

    await new Agent({ name: 'a', model }).run('go', { onEvent })

    expect(events.some((e) => e.type === 'model.retry')).toBe(false)
    expect(events.some((e) => e.type === 'model.fallback')).toBe(false)
  })
})

describe('streaming with retries', () => {
  /**
   * The one case where a retry is visible to a renderer: the first attempt
   * streamed real tokens before dying. `discardedText` is exactly what has to be
   * un-painted before the retry's own text arrives.
   */
  it('reports discarded text when a retry follows partial output', async () => {
    const model = mockProvider((_request, index) =>
      index === 0
        ? {
            text: 'This will be thrown away.',
            errorAfterChunks: 2,
            error: new NetworkError('reset mid-stream'),
          }
        : { text: 'The real answer.' },
    )

    const { events, onEvent } = recorder()
    const agent = new Agent({ name: 'a', model, ...FAST })
    const result = await agent.stream('go', { onEvent })

    const retries = events.filter((e) => e.type === 'model.retry')
    expect(retries).toHaveLength(1)

    const discarded = retries[0]?.discardedText ?? ''
    expect(discarded.length).toBeGreaterThan(0)

    // The deltas emitted before the failure match what the event reports.
    const beforeRetry = events
      .slice(0, events.indexOf(retries[0] as AgentEvent))
      .filter((e) => e.type === 'text.delta')
      .map((e) => e.delta)
      .join('')
    expect(beforeRetry).toBe(discarded)

    // Only the successful attempt reaches the result.
    expect(result.text).toBe('The real answer.')
  })
})
