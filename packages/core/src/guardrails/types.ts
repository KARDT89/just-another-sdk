/**
 * Guardrails — the policy layer around a run.
 *
 * Three kinds, one shape. An **input** guardrail sees the user's turn before a
 * single token is spent; an **output** guardrail sees the final answer before it
 * reaches the caller or the session; a **tool** guardrail sees a tool call's
 * arguments after they validate and before the handler runs.
 *
 * Each can allow, rewrite, or reject — and a tool guardrail can additionally ask
 * for a human. Nothing here executes anything or emits an event: the runner
 * drives these, exactly as it drives `run/output.ts`.
 */

import type { ModelMessage } from '../types/messages.js'

/* ------------------------------------------------------------------------- */
/* Verdicts                                                                  */
/* ------------------------------------------------------------------------- */

/** Let it through unchanged. */
export interface GuardrailAllow {
  readonly allow: true
}

/**
 * Let it through, but use this value instead.
 *
 * The replacement is **not** re-validated against anything. For input and output
 * that is fine — they are text or an already-validated object. Tool guardrails
 * deliberately cannot rewrite; see {@link ToolGuardrailVerdict}.
 */
export interface GuardrailRewrite<TValue> extends GuardrailAllow {
  readonly replace: TValue
}

/** Stop the run. `reject` is the reason, and it becomes the error's message. */
export interface GuardrailReject {
  readonly reject: string
  /** Safe-to-log context. Lands on `error.details`, so keep it small and free of secrets. */
  readonly details?: Readonly<Record<string, unknown>>
}

/** Tool guardrails only: suspend the run and hand this call to a human. */
export interface GuardrailRequireApproval {
  readonly requireApproval: true
  /** Shown to whoever decides. Defaults to the tool name. */
  readonly reason?: string
}

export type GuardrailVerdict<TValue> = GuardrailAllow | GuardrailRewrite<TValue> | GuardrailReject

/**
 * A tool guardrail's verdict.
 *
 * Note what is missing: **no `replace`.** The seam sits after the tool's own
 * schema has validated and coerced the arguments, precisely so a guardrail sees
 * values it can trust. Letting it write back would either bypass that schema or
 * demand a second validation pass with its own failure mode and its own error
 * type. Clamping a value belongs in the schema (`z.number().max(100)`) or in the
 * handler; a guardrail decides *whether*, not *what*.
 */
export type ToolGuardrailVerdict = GuardrailAllow | GuardrailReject | GuardrailRequireApproval

/* ------------------------------------------------------------------------- */
/* Context                                                                   */
/* ------------------------------------------------------------------------- */

/** What a guardrail knows about the run it is inspecting. */
export interface GuardrailContext {
  readonly runId: string
  readonly agentName: string
  /** 1-based turn. Always `1` for an input guardrail, which runs before turn 1. */
  readonly turn: number
  /** The conversation as it stands, including any loaded session history. */
  readonly messages: readonly ModelMessage[]
  /** The run's signal, so a guardrail that calls out honours cancellation. */
  readonly signal: AbortSignal
}

/** Adds the raw text, for a schema-backed agent that wants to scan the JSON. */
export interface OutputGuardrailContext extends GuardrailContext {
  readonly text: string
}

/** The tool call a guardrail is deciding about. */
export interface ToolGuardrailSubject<TInput = unknown> {
  readonly toolName: string
  readonly toolCallId: string
  /** Arguments **after** the tool's schema validated and coerced them. */
  readonly input: TInput
}

/* ------------------------------------------------------------------------- */
/* The three kinds                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Guardrails are named objects rather than bare functions.
 *
 * The name is not decoration: the brief requires "guardrail triggered" to be
 * visible in a trace, and `guardrail #1 triggered` is useless when you are
 * reading production logs at 3am. `tool()` set the same precedent — anything
 * that shows up in a trace carries a name.
 *
 * There is no `guardrail()` factory to go with `tool()`. That helper exists to
 * infer a handler's input from a schema and to memoize JSON Schema derivation;
 * a guardrail needs neither, so `const g: InputGuardrail = { … }` is the whole
 * story and adds no API surface.
 */
export interface InputGuardrail {
  readonly name: string
  /**
   * `input` is the text of this run's new user turn. Returning `replace`
   * rewrites it before the model ever sees it.
   */
  check(
    input: string,
    context: GuardrailContext,
  ): GuardrailVerdict<string> | Promise<GuardrailVerdict<string>>
}

/**
 * Runs against the **validated** output, not the raw text.
 *
 * `AgentConfig<TOutput>` already carries the output type, so an agent with an
 * `outputSchema: Ticket` gets a guardrail over `Ticket` and an agent without one
 * gets a guardrail over `string`. A rewrite therefore cannot break the schema
 * contract by construction. `context.text` is still there when you want the raw
 * JSON.
 */
export interface OutputGuardrail<TOutput = string> {
  readonly name: string
  check(
    output: TOutput,
    context: OutputGuardrailContext,
  ): GuardrailVerdict<TOutput> | Promise<GuardrailVerdict<TOutput>>
}

export interface ToolGuardrail<TInput = unknown> {
  readonly name: string
  /**
   * Tool names this guardrail applies to. **Omit it to gate every tool.**
   *
   * A name here that is not a registered tool is rejected by the `Agent`
   * constructor rather than ignored — a typo in a security control must not
   * silently fail open.
   */
  readonly tools?: readonly string[]
  check(
    subject: ToolGuardrailSubject<TInput>,
    context: GuardrailContext,
  ): ToolGuardrailVerdict | Promise<ToolGuardrailVerdict>
}

/**
 * A tool guardrail of unknown input type, for storing them together.
 *
 * Same bivariance argument as {@link AnyTool}: a `readonly ToolGuardrail<X>[]`
 * cannot hold guardrails for different tools without it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
export type AnyToolGuardrail = ToolGuardrail<any>

/* ------------------------------------------------------------------------- */
/* Approval                                                                  */
/* ------------------------------------------------------------------------- */

/** One tool call waiting on a human. */
export interface PendingToolCall {
  /** Matches a `ToolCallPart.toolCallId` in the suspension's `messages`. */
  readonly toolCallId: string
  readonly toolName: string
  /** Validated arguments — an approval UI needs these to say "refund $500?". */
  readonly input: unknown
  /** Which guardrail asked. */
  readonly guardrail: string
  readonly reason: string | undefined
}

export interface PendingApproval {
  readonly turn: number
  readonly calls: readonly PendingToolCall[]
}

/**
 * Everything needed to resume a suspended run, and nothing that is not JSON.
 *
 * Deliberately plain data. Approval is stateless: there is no `ApprovalStore` to
 * implement per backend, and nothing is written mid-run — which is what keeps
 * the "only a completed run is persisted" invariant true without a special case.
 * Hold this wherever you like and hand it back to `agent.resumeApproval()`.
 *
 * **Keep it server-side.** It contains the whole conversation. Send a client
 * only `pending`, which does not.
 */
export interface ApprovalSuspension {
  readonly runId: string
  readonly agentName: string
  /** The full conversation, system message first — round-trips like `RunResult.messages`. */
  readonly messages: readonly ModelMessage[]
  /**
   * Only the messages this run added on top of stored history.
   *
   * Present because the suspended run persisted *nothing*: on a session-backed
   * resume the store still lacks the user turn and the assistant tool-call turn,
   * so the resume grafts this tail on rather than replaying history it already
   * has. `messages` alone would work only without a session; this alone only
   * with one.
   */
  readonly produced: readonly ModelMessage[]
  readonly sessionId?: string
  readonly pending: PendingApproval
}

/** A human's answer about one gated call. */
export interface ApprovalDecision {
  readonly toolCallId: string
  readonly approved: boolean
  /** Shown to the model when denied, so it can explain rather than just fail. */
  readonly reason?: string
}
