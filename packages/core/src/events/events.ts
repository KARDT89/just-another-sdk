import type { FinishReason, ToolDefinition } from '../providers/provider.js'
import type { StopReason } from '../run/result.js'
import type { AgentError, SchemaIssue } from '../errors/errors.js'
import type { PendingToolCall } from '../guardrails/types.js'
import type { HandoffRefusal } from '../handoffs/types.js'
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
 * The conversation has been transferred to another agent.
 *
 * Emitted after the transfer tool's `tool.end` and before the receiving agent's
 * first `model.request`, so a trace reads in the order things happened. Every
 * event after it carries the receiving agent's name.
 *
 * There is deliberately **no `handoff.end`**. A handoff in this runtime is a
 * transition, not a nested scope: the receiving agent holds the conversation
 * until the run ends or it transfers onward, so the only honest close is
 * `run.finish` — which carries `agentPath`.
 */
export interface HandoffStartEvent extends EventBase {
  readonly type: 'handoff.start'
  readonly turn: number
  /** The agent giving up the conversation. Same as `agentName` on this event. */
  readonly from: string
  /** The agent taking it over. `agentName` on every event after this one. */
  readonly to: string
  readonly toolName: string
  readonly toolCallId: string
  /** What the model gave as its reason for transferring, if it gave one. */
  readonly reason?: string
  /** Messages the receiving agent will see, after any `filter`. */
  readonly carriedCount: number
}

/**
 * A transfer was refused by a loop-prevention limit.
 *
 * The run does **not** end. The model receives an error result and answers the
 * user with the agent it already has, which is why this is an event rather than
 * a `StopReason`.
 */
export interface HandoffRefusedEvent extends EventBase {
  readonly type: 'handoff.refused'
  readonly turn: number
  readonly from: string
  readonly to: string
  readonly toolName: string
  readonly toolCallId: string
  readonly cause: HandoffRefusal
  /** The message the model receives in place of the transfer. */
  readonly reason: string
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

/**
 * The final answer failed the agent's `outputSchema`.
 *
 * Fires on *every* failed attempt including the last, unlike `model.retry`,
 * which only fires when another attempt is actually coming. Here the attempt
 * that is not coming is the interesting one — the run is about to throw — and a
 * trace that went silent at exactly that moment would be useless.
 *
 * The raw model text is deliberately absent: events cross an SSE boundary to
 * browsers, and model output is unbounded and can echo back whatever the user
 * pasted in. `InvalidOutputError.rawText` carries it to the process that can be
 * trusted with it.
 */
export interface OutputInvalidEvent extends EventBase {
  readonly type: 'output.invalid'
  /** The turn whose answer failed. */
  readonly turn: number
  /** 1-based index of the validation attempt that just failed. */
  readonly attempt: number
  /** Total attempts that will be made — `maxOutputRetries + 1`. */
  readonly maxAttempts: number
  /** Empty when the text was not JSON at all. */
  readonly issues: readonly SchemaIssue[]
  /** True when a repair request is about to be sent. */
  readonly repairing: boolean
}

/**
 * A guardrail did something other than wave a value through.
 *
 * `guardrail` is why guardrails carry a name at all — the brief requires a
 * triggered guardrail to be identifiable in a trace, and an index would not be.
 *
 * The value being judged is deliberately absent, for the same reason
 * {@link OutputInvalidEvent} omits the raw text: events cross an SSE boundary to
 * browsers, and a rejected input is unbounded and often user-supplied.
 */
export interface GuardrailTriggeredEvent extends EventBase {
  readonly type: 'guardrail.triggered'
  readonly guardrail: string
  readonly stage: 'input' | 'output' | 'tool'
  readonly action: 'reject' | 'replace' | 'require_approval'
  /** Present only for a tool guardrail. */
  readonly toolName?: string
  readonly toolCallId?: string
  /** The rejection message, or the approval reason. Absent for a replace. */
  readonly reason?: string
  /** 1-based. `1` for an input guardrail, which runs before turn 1. */
  readonly turn: number
}

/**
 * The run is suspending to wait on a human. Emitted before `run.error`.
 *
 * Unlike most events this *does* carry the tool arguments, because an approval
 * UI cannot render "approve this refund?" without them. `tool.start` already
 * ships `input` over SSE, and every payload is redacted on the way out.
 */
export interface ApprovalRequiredEvent extends EventBase {
  readonly type: 'approval.required'
  readonly turn: number
  readonly calls: readonly PendingToolCall[]
}

/** A human's decision was applied while resuming. */
export interface ApprovalResolvedEvent extends EventBase {
  readonly type: 'approval.resolved'
  readonly turn: number
  readonly toolCallId: string
  readonly toolName: string
  readonly approved: boolean
  readonly reason?: string
}

/** The run finished. Always the last event on a successful run. */
export interface RunFinishEvent extends EventBase {
  readonly type: 'run.finish'
  readonly stopReason: StopReason
  readonly text: string
  readonly turns: number
  readonly usage: Usage
  readonly durationMs: number
  /** Every agent that acted, in order. `[agentName]` when nothing was handed off. */
  readonly agentPath: readonly string[]
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
  | HandoffStartEvent
  | HandoffRefusedEvent
  | GuardrailTriggeredEvent
  | ApprovalRequiredEvent
  | ApprovalResolvedEvent
  | OutputInvalidEvent
  | RunFinishEvent
  | RunErrorEvent

export type AgentEventType = AgentEvent['type']

/** Narrows an event by its `type`, for typed handlers. */
export type EventOfType<T extends AgentEventType> = Extract<AgentEvent, { type: T }>

export type EventListener = (event: AgentEvent) => void
