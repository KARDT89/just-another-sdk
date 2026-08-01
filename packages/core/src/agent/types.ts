import type { ModelProvider, ToolChoice } from '../providers/provider.js'
import type { AnyTool } from '../tools/tool.js'
import type { AgentEvent } from '../events/events.js'
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

  /** Free-form tags passed to providers that support them, and to traces. */
  readonly metadata?: Readonly<Record<string, string>>
}

/** Per-run overrides and hooks. Nothing here mutates the agent. */
export interface RunOptions {
  /**
   * Prior conversation to continue. Pass `previousResult.messages` for a
   * multi-turn chat. The system message is re-derived, so strip it or leave it —
   * either works.
   */
  readonly messages?: readonly ModelMessage[]

  /** Cancels the run: in-flight model call and pending tools are aborted. */
  readonly signal?: AbortSignal

  /** Deadline for the entire run in ms. Unset means no overall limit. */
  readonly timeoutMs?: number

  /** Overrides {@link AgentConfig.maxTurns} for this run only. */
  readonly maxTurns?: number

  /** Overrides {@link AgentConfig.toolChoice} for this run only. */
  readonly toolChoice?: ToolChoice

  /**
   * Observe the run as it happens. Synchronous and fire-and-forget: a throwing
   * listener is swallowed so instrumentation can never break a run.
   */
  readonly onEvent?: (event: AgentEvent) => void

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
} = Object.freeze({
  maxTurns: 10,
  toolTimeoutMs: 30_000,
  modelTimeoutMs: 120_000,
  onToolError: 'return',
})
