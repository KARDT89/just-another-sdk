import type { AgentError } from '../errors/errors.js'
import type { ModelProvider, ToolChoice } from '../providers/provider.js'
import type { AnyTool } from '../tools/tool.js'
import type { AgentEvent } from '../events/events.js'
import type { SessionStore } from '../sessions/store.js'
import type { StreamStore } from '../streams/store.js'
import type { ContextPolicy } from '../sessions/trim.js'
import type { ModelMessage } from '../types/messages.js'

/**
 * What a tool failure should do.
 * - `'return'` (default) — feed the error back to the model as a tool result so
 *   it can apologise, retry with different arguments, or route around it. The
 *   run still completes.
 * - `'throw'` — abort the run and throw. Use when a tool failure means the whole
 *   task is void.
 */
export type ToolErrorPolicy = 'return' | 'throw'

/**
 * An agent's *configuration*. Immutable and reusable across any number of runs.
 *
 * This type deliberately contains no conversation, no message list, and no
 * counters — that is `RunState` (per run) and, later, `Session` (persisted).
 * Keeping the three apart is what lets one agent serve many concurrent users.
 */
export interface AgentConfig {
  /** Human-readable name. Appears in events, traces, and handoff decisions. */
  readonly name: string

  /**
   * The system prompt. A function is resolved once per run, which is enough to
   * inject a timestamp or per-request context without mutating the agent.
   */
  readonly instructions?: string | (() => string | Promise<string>)

  /** The bound model, e.g. `openrouter('anthropic/claude-opus-5')`. */
  readonly model: ModelProvider

  /** Tools the model may call. Names must be unique. */
  readonly tools?: readonly AnyTool[]

  /**
   * Hard ceiling on model calls per run. Reaching it ends the run with
   * `stopReason: 'max_turns'` rather than throwing or looping. Default 10.
   */
  readonly maxTurns?: number

  readonly maxOutputTokens?: number
  readonly temperature?: number
  readonly toolChoice?: ToolChoice

  /** Default `'return'`. See {@link ToolErrorPolicy}. */
  readonly onToolError?: ToolErrorPolicy

  /** Per-tool-call deadline in ms. Default 30_000. */
  readonly toolTimeoutMs?: number

  /** Deadline for a single model call in ms. Default 120_000. */
  readonly modelTimeoutMs?: number

  /**
   * Extra attempts per model call after the first. Default 2, so a call is made
   * at most 3 times. Set 0 to disable retries entirely.
   *
   * Only errors whose `retryable` flag is set are retried, and cancellation
   * never is. See {@link AgentConfig.retryOn} to change the predicate.
   */
  readonly maxRetries?: number

  /** Base of the exponential backoff curve in ms. Default 250. */
  readonly retryDelayMs?: number

  /**
   * Ceiling on any single backoff wait in ms. Default 10_000.
   *
   * Also the limit on how far a provider's `Retry-After` will be honoured: one
   * asking for longer than this fails immediately rather than blocking the
   * caller's `await`, with `retryAfterMs` still on the error so you can
   * reschedule it yourself.
   */
  readonly maxRetryDelayMs?: number

  /**
   * Replaces the default predicate (`error.retryable`) entirely. `attempt` is
   * 1-based. Cancellation is never retried regardless of what this returns.
   */
  readonly retryOn?: (error: AgentError, attempt: number) => boolean

  /**
   * Models to try, in order, once the primary has exhausted its retries.
   *
   * A fallback also takes over on a *non*-retryable failure — a bad key or an
   * unknown model on the primary is exactly when a second vendor should serve.
   * The chain resets to the primary at the start of every turn, so a transient
   * outage cannot permanently demote the preferred model. Which model served a
   * given turn is recorded on `steps[].modelId`.
   */
  readonly fallbacks?: readonly ModelProvider[]

  /**
   * Where conversations are persisted between runs.
   *
   * Pair it with a `sessionId` on the run and multi-turn stops being your
   * problem — history is loaded before the loop and the new turns are appended
   * after it:
   *
   * ```ts
   * const agent = new Agent({ name: 'support', model, session: fileSession('./.sessions') })
   *
   * await agent.run('My name is Ada.',  { sessionId: 'user_123' })
   * await agent.run('What is my name?', { sessionId: 'user_123' })   // "Ada"
   * ```
   *
   * Omit it and a `sessionId` still works, against a bounded in-memory store
   * created for this agent — enough for a prototype, gone on restart.
   */
  readonly session?: SessionStore

  /**
   * How much prior conversation to carry into a run. Without one, a long session
   * costs more every turn until the provider rejects the request.
   *
   * Applies to `options.messages` too, so it is useful without a session store.
   */
  readonly context?: ContextPolicy

  /**
   * Where resumable runs record themselves, for {@link Agent.resumable}.
   *
   * Omit it and resumable runs still work, against a bounded in-memory store
   * owned by this agent — correct for one process, silently wrong behind a load
   * balancer. Use `redisStreamStore(client)` there.
   */
  readonly streams?: StreamStore

  /** Free-form tags passed to providers that support them, and to traces. */
  readonly metadata?: Readonly<Record<string, string>>
}

/** Per-run overrides and hooks. Nothing here mutates the agent. */
export interface RunOptions {
  /**
   * Prior conversation to continue. Pass `previousResult.messages` for a
   * multi-turn chat. The system message is re-derived, so strip it or leave it —
   * either works.
   *
   * Mutually exclusive with {@link RunOptions.sessionId}: passing both would
   * concatenate two versions of the same conversation, so it throws instead.
   */
  readonly messages?: readonly ModelMessage[]

  /**
   * Continue a persisted conversation. History is loaded before the run and this
   * run's new messages are appended after it.
   *
   * ```ts
   * await agent.run('My name is Ada.',  { sessionId: 'user_123' })
   * await agent.run('What is my name?', { sessionId: 'user_123' })
   * ```
   *
   * Uses {@link AgentConfig.session}, or a bounded in-memory store when the agent
   * has none.
   */
  readonly sessionId?: string

  /** Cancels the run: in-flight model call and pending tools are aborted. */
  readonly signal?: AbortSignal

  /** Deadline for the entire run in ms. Unset means no overall limit. */
  readonly timeoutMs?: number

  /** Overrides {@link AgentConfig.maxTurns} for this run only. */
  readonly maxTurns?: number

  /** Overrides {@link AgentConfig.toolChoice} for this run only. */
  readonly toolChoice?: ToolChoice

  /** Overrides {@link AgentConfig.maxRetries} for this run only. */
  readonly maxRetries?: number

  /**
   * Observe the run as it happens. Synchronous and fire-and-forget: a throwing
   * listener is swallowed so instrumentation can never break a run.
   */
  readonly onEvent?: (event: AgentEvent) => void

  /**
   * Use this id for the run instead of a generated one.
   *
   * For correlating a run with a request id you already have. It must be unique
   * per run — reusing one makes two runs indistinguishable in a trace.
   */
  readonly runId?: string

  /** Merged over {@link AgentConfig.metadata}. */
  readonly metadata?: Readonly<Record<string, string>>
}

/** What you can hand to `run()` as the user's turn. */
export type AgentInput = string | readonly ModelMessage[]

/** Defaults applied when a config or run option is omitted. */
export const AGENT_DEFAULTS: {
  readonly maxTurns: number
  readonly toolTimeoutMs: number
  readonly modelTimeoutMs: number
  readonly onToolError: ToolErrorPolicy
  readonly maxRetries: number
  readonly retryDelayMs: number
  readonly maxRetryDelayMs: number
} = Object.freeze({
  maxTurns: 10,
  toolTimeoutMs: 30_000,
  modelTimeoutMs: 120_000,
  onToolError: 'return',
  maxRetries: 2,
  retryDelayMs: 250,
  maxRetryDelayMs: 10_000,
})
