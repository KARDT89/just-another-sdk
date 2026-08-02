import type { AgentError } from '../errors/errors.js'
import type { ModelProvider, ToolChoice } from '../providers/provider.js'
import type { AnyTool } from '../tools/tool.js'
import type { AgentEvent } from '../events/events.js'
import type { SessionStore } from '../sessions/store.js'
import type { StreamStore } from '../streams/store.js'
import type { ContextPolicy } from '../sessions/trim.js'
import type {
  AnyToolGuardrail,
  ApprovalDecision,
  InputGuardrail,
  OutputGuardrail,
} from '../guardrails/types.js'
import type { StandardSchemaV1 } from '../schema/standard-schema.js'
import type { ObjectJsonSchema } from '../types/json-schema.js'
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
export interface AgentConfig<TOutput = string> {
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

  /**
   * Make `result.output` a validated object instead of a string.
   *
   * Any Standard Schema validator — the same interop `tool()` uses, so no
   * validator becomes a dependency of yours or ours. The type flows through:
   *
   * ```ts
   * const Ticket = z.object({ severity: z.number(), summary: z.string() })
   * const agent = new Agent({ name: 'triage', model, outputSchema: Ticket })
   *
   * const result = await agent.run(email)
   * result.output.severity   // number — inferred, no cast
   * ```
   *
   * Composes with `tools`: the loop runs exactly as it always does, and only the
   * final answer is validated. `result.text` still holds the raw JSON.
   */
  readonly outputSchema?: StandardSchemaV1<unknown, TOutput>

  /**
   * The JSON Schema sent to the model, bypassing automatic derivation.
   *
   * The same escape hatch `tool()` calls `parameters`. Two uses: a validator the
   * SDK cannot convert, and satisfying a provider's strict mode — see
   * {@link ResponseFormat.strict}.
   */
  readonly outputJsonSchema?: ObjectJsonSchema

  /**
   * Attempts to repair a final answer that failed `outputSchema`. Default 1, so
   * a run makes at most two tries at the schema. Set 0 to fail on the first.
   *
   * Deliberately *not* {@link AgentConfig.maxRetries}: that budget re-sends an
   * identical request after a transport failure, from inside the model call.
   * This one sends a *different* request — the conversation plus the validation
   * errors — from outside it. The two are additive, never multiplicative.
   */
  readonly maxOutputRetries?: number

  /**
   * Checked before a single token is spent. Each can allow, rewrite, or reject.
   *
   * ```ts
   * inputGuardrails: [{
   *   name: 'max-length',
   *   check: (input) =>
   *     input.length > 10_000 ? { reject: 'Message too long.' } : { allow: true },
   * }]
   * ```
   *
   * Run in declaration order, one at a time — a rewrite must be visible to the
   * next guardrail. The first rejection wins and throws a `GuardrailError`.
   */
  readonly inputGuardrails?: readonly InputGuardrail[]

  /**
   * Checked against the final answer, before it reaches you or the session.
   *
   * Typed on `TOutput`, so with an `outputSchema` a guardrail receives the
   * validated object rather than raw text — and a rewrite cannot break the
   * schema contract. `context.text` still carries the raw JSON.
   *
   * A rewrite also updates the transcript, so a scrubbed answer stays scrubbed
   * in the session rather than coming back on the next turn.
   */
  readonly outputGuardrails?: readonly OutputGuardrail<TOutput>[]

  /**
   * Checked for each tool call, after its arguments validate and before the
   * handler runs.
   *
   * ```ts
   * toolGuardrails: [
   *   { name: 'refund-cap', tools: ['refund_order'],
   *     check: ({ input }) => input.amount > 100 ? { requireApproval: true } : { allow: true } },
   *   { name: 'confirm-writes', check: ({ toolName }) => … },  // every tool
   * ]
   * ```
   *
   * A rejection is **not** a run failure: the model receives an error result and
   * routes around it, even under `onToolError: 'throw'`. A `requireApproval`
   * suspends the run before *any* tool in that turn executes.
   */
  readonly toolGuardrails?: readonly AnyToolGuardrail[]

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
   * Overrides {@link AgentConfig.maxOutputRetries} for this run only.
   *
   * There is no per-run `outputSchema` to go with it: a schema changes the
   * *return type*, and `RunOptions` is shared by `AgentSession`, resumable runs,
   * and the HTTP helpers, none of which could carry that type through. Use
   * `agent.clone({ outputSchema })` for a per-request schema — it infers.
   */
  readonly maxOutputRetries?: number

  /**
   * Human decisions about tool calls a guardrail suspended the run for.
   *
   * You rarely pass this directly — {@link Agent.resumeApproval} is the
   * ergonomic form. Only the resume prologue reads it, never the loop, which is
   * what makes an approval authorise one call once rather than becoming standing
   * permission for the rest of the run.
   */
  readonly approvals?: readonly ApprovalDecision[]

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
  readonly maxOutputRetries: number
} = Object.freeze({
  maxTurns: 10,
  toolTimeoutMs: 30_000,
  modelTimeoutMs: 120_000,
  onToolError: 'return',
  maxRetries: 2,
  retryDelayMs: 250,
  maxRetryDelayMs: 10_000,
  // One, not two like `maxRetries`. A transport retry replays an identical
  // request cheaply; a repair replays the whole conversation *plus* the bad
  // answer *plus* the issue list, and it is the most expensive retry in the SDK.
  // One catches the common failures — a prose wrapper, a code fence, one coerced
  // field. A model that got the shape wrong twice does not know the shape.
  maxOutputRetries: 1,
})
