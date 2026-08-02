import type { FinishReason, ToolDefinition } from '../providers/provider.js'
import type { StopReason } from '../run/result.js'
import type { AgentError } from '../errors/errors.js'
import type { ToolCallPart, ToolResultPart, Usage } from '../types/messages.js'

/**
 * The runtime's observability surface.
 *
 * Every interesting moment in a run is an event. Tracing, streaming, progress
 * UIs, and cost dashboards are all consumers of this one stream rather than
 * separate features bolted onto the loop — which is why the loop emits events it
 * does not itself use.
 *
 * Events are additive: new members will be added to this union over time, so
 * consumers should switch on `type` with a `default` branch rather than assume
 * exhaustiveness.
 */

interface EventBase {
  readonly id: string
  /** Milliseconds since the epoch, when the event was emitted. */
  readonly timestamp: number
  readonly runId: string
  readonly agentName: string
}

/** The run has started. Always the first event. */
export interface RunStartEvent extends EventBase {
  readonly type: 'run.start'
  readonly modelId: string
  readonly input: string
  readonly toolNames: readonly string[]
}

/** About to call the model. */
export interface ModelRequestEvent extends EventBase {
  readonly type: 'model.request'
  readonly turn: number
  readonly modelId: string
  readonly messageCount: number
  readonly tools: readonly ToolDefinition[]
}

/** The model responded. Emitted before any tool runs. */
export interface ModelResponseEvent extends EventBase {
  readonly type: 'model.response'
  readonly turn: number
  readonly modelId: string
  readonly text: string
  readonly toolCalls: readonly ToolCallPart[]
  readonly finishReason: FinishReason
  readonly usage: Usage
  readonly durationMs: number
}

/** Streamed text. Emitted only on streaming runs. */
export interface TextDeltaEvent extends EventBase {
  readonly type: 'text.delta'
  readonly turn: number
  readonly delta: string
}

/**
 * A model call failed and will be attempted again against the same provider.
 *
 * Only fires when a retry is actually going to happen — the final, giving-up
 * failure surfaces as a thrown error, not as an event.
 */
export interface ModelRetryEvent extends EventBase {
  readonly type: 'model.retry'
  readonly turn: number
  readonly modelId: string
  readonly providerId: string
  /** 1-based index of the attempt that just failed. */
  readonly attempt: number
  /** Total attempts that will be made against this provider. */
  readonly maxAttempts: number
  readonly error: AgentError
  /** How long the runtime will wait before the next attempt, ms. */
  readonly delayMs: number
  /**
   * Text already delivered as `text.delta` for the failed attempt, and now void.
   *
   * Empty in the common case — a 429 or a connection refusal fails before any
   * bytes arrive. When it is not empty, a renderer that has already painted
   * those characters must remove exactly this many before the retry streams its
   * own text.
   */
  readonly discardedText: string
}

/** The provider chain moved on after the previous provider was exhausted. */
export interface ModelFallbackEvent extends EventBase {
  readonly type: 'model.fallback'
  readonly turn: number
  readonly fromModelId: string
  readonly fromProviderId: string
  readonly toModelId: string
  readonly toProviderId: string
  /** 0-based position of the new provider in `[model, ...fallbacks]`. */
  readonly index: number
  /** The error that exhausted the previous provider. */
  readonly error: AgentError
  /** See {@link ModelRetryEvent.discardedText}. */
  readonly discardedText: string
}

/** A tool is about to run, with arguments already validated. */
export interface ToolStartEvent extends EventBase {
  readonly type: 'tool.start'
  readonly turn: number
  readonly toolName: string
  readonly toolCallId: string
  readonly input: unknown
}

/** A tool finished — successfully or not. Check `isError`. */
export interface ToolEndEvent extends EventBase {
  readonly type: 'tool.end'
  readonly turn: number
  readonly toolName: string
  readonly toolCallId: string
  readonly result: ToolResultPart
  readonly isError: boolean
  readonly durationMs: number
}

/**
 * Prior conversation was loaded from a session store, before the first model
 * call.
 *
 * `droppedCount` is the reason this event exists: trimming an over-budget
 * history is the one thing the session layer does that silently changes what the
 * model sees, and "why did it forget?" is unanswerable without it.
 */
export interface SessionLoadEvent extends EventBase {
  readonly type: 'session.load'
  readonly sessionId: string
  /** Messages carried into the run, after trimming. */
  readonly messageCount: number
  /** Messages the context policy dropped from what was read. */
  readonly droppedCount: number
  /**
   * The *read* was bounded, so older messages exist beyond `droppedCount`.
   *
   * With a `maxMessages` policy the store is asked for a window rather than the
   * whole transcript, which makes `droppedCount` a lower bound rather than a
   * total. This flag is how you tell "nothing was lost" from "the beginning was
   * never fetched".
   */
  readonly truncated: boolean
  readonly durationMs: number
}

/**
 * Trimmed history was folded into a summary — or the attempt failed and plain
 * trimming was used instead.
 *
 * Emitted for both outcomes on purpose. A summary is a model call the runtime
 * makes on your behalf, so it costs money and can fail; neither should be
 * invisible.
 */
export interface SessionSummarizeEvent extends EventBase {
  readonly type: 'session.summarize'
  readonly sessionId: string
  /**
   * How many messages from the start of the stored log the summary now stands in
   * for — including any it inherited from an earlier fold.
   *
   * This is the number that answers "how much of this conversation is now a
   * recap", which is what a trace is being read for. On a failed attempt it is
   * what *would* have been covered.
   */
  readonly coveredCount: number
  /** Messages compressed by this particular call. */
  readonly foldedCount: number
  /** Messages kept verbatim after the summary. */
  readonly keptCount: number
  readonly durationMs: number
  /** Present when summarizing failed. The run continued with plain trimming. */
  readonly error?: AgentError
}

/** This run's new messages were written back to the session store. */
export interface SessionSaveEvent extends EventBase {
  readonly type: 'session.save'
  readonly sessionId: string
  readonly appendedCount: number
  readonly durationMs: number
}

/** The run finished. Always the last event on a successful run. */
export interface RunFinishEvent extends EventBase {
  readonly type: 'run.finish'
  readonly stopReason: StopReason
  readonly text: string
  readonly turns: number
  readonly usage: Usage
  readonly durationMs: number
}

/** The run is being abandoned by throwing. Always the last event when it fires. */
export interface RunErrorEvent extends EventBase {
  readonly type: 'run.error'
  readonly error: AgentError
  readonly turn: number
}

export type AgentEvent =
  | RunStartEvent
  | SessionLoadEvent
  | SessionSummarizeEvent
  | SessionSaveEvent
  | ModelRequestEvent
  | ModelResponseEvent
  | TextDeltaEvent
  | ModelRetryEvent
  | ModelFallbackEvent
  | ToolStartEvent
  | ToolEndEvent
  | RunFinishEvent
  | RunErrorEvent

export type AgentEventType = AgentEvent['type']

/** Narrows an event by its `type`, for typed handlers. */
export type EventOfType<T extends AgentEventType> = Extract<AgentEvent, { type: T }>

export type EventListener = (event: AgentEvent) => void
