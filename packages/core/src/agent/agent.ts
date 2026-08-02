import { ConfigurationError } from '../errors/errors.js'
import type { RunResult } from '../run/result.js'
import { runAgent } from '../run/runner.js'
import { streamAgent, type StreamedRun } from '../run/stream.js'

import { defaultSessionStore } from '../sessions/memory.js'
import type { LoadOptions, SessionStore } from '../sessions/store.js'
import { defaultStreamStore } from '../streams/memory.js'
import {
  resumeStream,
  startResumable,
  type FollowOptions,
  type ResumableOptions,
  type ResumableRun,
} from '../streams/resumable.js'
import type { StreamStore } from '../streams/store.js'
import { ToolRegistry } from '../tools/registry.js'
import type { AnyTool } from '../tools/tool.js'
import type { ModelMessage } from '../types/messages.js'
import type { AgentConfig, AgentInput, RunOptions } from './types.js'

/**
 * An agent: a name, instructions, a model, and some tools.
 *
 * An `Agent` is **immutable configuration**, not a session. It holds no
 * conversation, no counters, and no mutable state, which means a single instance
 * is safe to create once at module scope and share across every concurrent
 * request in your server. Per-run state lives in `RunState`; persisted state will
 * live in `Session`.
 *
 * ```ts
 * import { Agent, tool } from 'just-another-sdk'
 * import { openrouter } from 'just-another-sdk/providers'
 * import * as z from 'zod'
 *
 * const agent = new Agent({
 *   name: 'weather-assistant',
 *   instructions: 'You are concise. Use the tools available to you.',
 *   model: openrouter('anthropic/claude-opus-5'),
 *   tools: [
 *     tool({
 *       name: 'get_weather',
 *       description: 'Get the current weather for a city.',
 *       inputSchema: z.object({ city: z.string() }),
 *       execute: async ({ city }) => ({ tempC: 18, summary: 'clear' }),
 *     }),
 *   ],
 * })
 *
 * const result = await agent.run('What is it like in Paris?')
 * console.log(result.output)
 * ```
 */
export class Agent {
  readonly name: string
  private readonly config: AgentConfig
  private readonly registry: ToolRegistry

  constructor(config: AgentConfig) {
    if (!config.name || config.name.trim().length === 0) {
      throw new ConfigurationError('An agent needs a name.', {
        hint: 'The name identifies the agent in events, traces, and handoffs.',
      })
    }

    if (!config.model || typeof config.model.generate !== 'function') {
      throw new ConfigurationError(`Agent "${config.name}" has no valid model.`, {
        hint:
          "Pass a provider, e.g. model: openrouter('anthropic/claude-opus-5') " +
          "imported from 'just-another-sdk/providers'.",
      })
    }

    if (config.maxTurns !== undefined && config.maxTurns < 1) {
      throw new ConfigurationError(`maxTurns must be at least 1, got ${config.maxTurns}.`, {
        details: { maxTurns: config.maxTurns },
      })
    }

    // Constructing the registry here surfaces duplicate tool names immediately,
    // at the point the developer wrote the mistake, rather than on first run.
    this.registry = new ToolRegistry(config.tools)
    this.config = config
    this.name = config.name
  }

  /** The model bound to this agent. */
  get modelId(): string {
    return this.config.model.modelId
  }

  /** Registered tool names, in declaration order. */
  get toolNames(): readonly string[] {
    return this.registry.names()
  }

  /**
   * Runs the agent to completion and resolves with the final result.
   *
   * Resolves when the model produces an answer or `maxTurns` is hit; rejects with
   * an `AgentError` on cancellation, a provider failure, or a tool failure under
   * `onToolError: 'throw'`.
   *
   * Continue a conversation by passing the previous messages back:
   *
   * ```ts
   * const first = await agent.run('My name is Ada.')
   * const second = await agent.run('What is my name?', { messages: first.messages })
   * ```
   */
  async run<TOutput = string>(
    input: AgentInput,
    options: RunOptions = {},
  ): Promise<RunResult<TOutput>> {
    return runAgent<TOutput>(this.config, input, options)
  }

  /**
   * Runs the agent, exposing events as they happen.
   *
   * The returned object is both an async iterable of events and awaitable for
   * the final `RunResult` — use either, or both:
   *
   * ```ts
   * const stream = agent.stream('Explain async iterators.')
   *
   * for await (const event of stream) {
   *   if (event.type === 'text.delta') process.stdout.write(event.delta)
   * }
   *
   * const result = await stream
   * console.log(`\n${result.usage.outputTokens} tokens`)
   * ```
   *
   * Providers that do not implement `stream()` still work: their answer arrives
   * as a single `text.delta`, so consuming code needs no special case.
   *
   * Deliberately **not** `async` — `await agent.stream(x)` must give you a
   * `RunResult`, not a promise of a stream.
   */
  stream<TOutput = string>(input: AgentInput, options: RunOptions = {}): StreamedRun<TOutput> {
    return streamAgent<TOutput>(this.config, input, options)
  }

  /**
   * This agent, bound to one conversation.
   *
   * Everything below is the same run with `sessionId` pre-filled — the point is
   * that a chat loop stops carrying history around:
   *
   * ```ts
   * const chat = agent.session('user_123')
   *
   * await chat.run('My name is Ada.')
   * await chat.run('What is my name?')   // "Ada"
   *
   * await chat.messages({ limit: 20 })   // the recent transcript
   * await chat.pop()                     // undo the last message
   * await chat.clear()                   // forget it
   * ```
   *
   * Servers usually want `agent.run(input, { sessionId })` instead, since the id
   * arrives with the request. Both take the same path through the runtime.
   */
  session(sessionId: string): AgentSession {
    const store = this.config.session ?? defaultSessionStore(this.config)

    return {
      sessionId,
      store,

      run: <TOutput = string>(input: AgentInput, options: RunOptions = {}) =>
        this.run<TOutput>(input, { ...options, sessionId }),

      stream: <TOutput = string>(input: AgentInput, options: RunOptions = {}) =>
        this.stream<TOutput>(input, { ...options, sessionId }),

      messages: (options?: LoadOptions) => store.load(sessionId, options),

      clear: () => store.clear(sessionId),

      pop: () => {
        if (!store.pop) {
          throw new ConfigurationError('This session store does not support pop().', {
            hint:
              'Add a `pop(sessionId)` method to your SessionStore that removes and returns ' +
              'the last message. Every adapter shipped with the SDK implements it.',
          })
        }
        return store.pop(sessionId)
      },
    }
  }

  /**
   * A run that survives the client disconnecting.
   *
   * ```ts
   * // start
   * const run = agent.resumable(message, { sessionId: userId })
   * return run.toEventResponse()          // carries x-stream-id
   *
   * // reconnect, from a different request and possibly a different instance
   * const from = Number(req.headers.get('last-event-id') ?? 0) + 1
   * return agent.resume(streamId, { fromIndex: from }).toEventResponse()
   * ```
   *
   * Every event is recorded as it happens, so a reader can join late, re-join
   * after a dropped connection, or read the whole thing once the run is over.
   *
   * Deliberately **not** wired to a request signal: cancelling on disconnect is
   * the behaviour this exists to avoid. It also removes a real failure mode —
   * an ordinary streamed run cancelled by a disconnect saves nothing, so the
   * user loses the exchange they had already watched arrive.
   *
   * Uses {@link AgentConfig.streams}, or a bounded in-memory store when the
   * agent has none. In-memory is correct for one process and silently wrong
   * behind a load balancer; use `redisStreamStore` there.
   */
  resumable<TOutput = string>(
    input: AgentInput,
    options: ResumableOptions = {},
  ): ResumableRun<TOutput> {
    return startResumable<TOutput>(this.config, this.streamStore(), input, options)
  }

  /**
   * Re-attaches to a run started by {@link resumable}: replays what has already
   * happened, then follows the rest.
   *
   * A finished run resumes just as well as one still going — the recording is
   * the source of truth, not the process that produced it.
   */
  resume(streamId: string, options: FollowOptions = {}): ReturnType<typeof resumeStream> {
    return resumeStream(this.streamStore(), streamId, options)
  }

  /** Configured stream store, or this agent's own in-memory one. */
  private streamStore(): StreamStore {
    return this.config.streams ?? defaultStreamStore(this.config)
  }

  /**
   * A copy of this agent with some configuration replaced.
   *
   * The original is untouched, so this is the safe way to specialise a shared
   * agent per request — a different model for a cheaper tier, an extra tool for
   * a privileged user:
   *
   * ```ts
   * const cheap = agent.clone({ model: openrouter('anthropic/claude-haiku-4-5') })
   * ```
   */
  clone(overrides: Partial<AgentConfig>): Agent {
    return new Agent({ ...this.config, ...overrides })
  }

  /** A copy of this agent with additional tools appended. */
  withTools(...tools: readonly AnyTool[]): Agent {
    return this.clone({ tools: [...(this.config.tools ?? []), ...tools] })
  }

  /** The resolved configuration. Read-only; mutating it does nothing. */
  toConfig(): Readonly<AgentConfig> {
    return { ...this.config }
  }
}

/**
 * An agent bound to one conversation, returned by {@link Agent.session}.
 *
 * Sugar, not a second code path: `run` and `stream` are the agent's own with a
 * `sessionId` attached.
 */
export interface AgentSession {
  readonly sessionId: string

  /** The store backing this conversation, for direct access when you need it. */
  readonly store: SessionStore

  run<TOutput = string>(input: AgentInput, options?: RunOptions): Promise<RunResult<TOutput>>

  stream<TOutput = string>(input: AgentInput, options?: RunOptions): StreamedRun<TOutput>

  /**
   * The stored transcript, oldest first. Untrimmed — this is what was saved, not
   * what the model last saw. `{ limit }` returns only the newest N.
   */
  messages(options?: LoadOptions): Promise<ModelMessage[]>

  /** Forget the conversation. */
  clear(): Promise<void>

  /**
   * Removes and returns the last message — "undo".
   *
   * Two pops walk back a whole exchange, which is what "edit my message and
   * regenerate" needs:
   *
   * ```ts
   * await chat.pop()          // the assistant's reply
   * await chat.pop()          // the user's message
   * await chat.run(edited)    // ask again
   * ```
   *
   * Throws a `ConfigurationError` on a custom store that does not implement
   * `pop`.
   */
  pop(): Promise<ModelMessage | undefined>
}

/**
 * Functional shorthand for `new Agent(config).run(input)`.
 *
 * Handy for one-shot calls where an agent instance would not be reused.
 */
export async function run<TOutput = string>(
  config: AgentConfig,
  input: AgentInput,
  options: RunOptions = {},
): Promise<RunResult<TOutput>> {
  return new Agent(config).run<TOutput>(input, options)
}
