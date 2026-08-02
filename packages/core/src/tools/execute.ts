import {
  AbortError,
  AgentError,
  InvalidToolInputError,
  TimeoutError,
  ToolExecutionError,
  ToolNotFoundError,
} from '../errors/errors.js'
import type { AnyToolGuardrail, GuardrailContext, PendingToolCall } from '../guardrails/types.js'
import { validate } from '../schema/standard-schema.js'
import { safeStringify } from '../util/stringify.js'
import type { ToolCallPart, ToolResultPart } from '../types/messages.js'
import type { ToolRegistry } from './registry.js'
import type { ToolContext } from './tool.js'

export interface ExecuteToolCallOptions {
  readonly registry: ToolRegistry
  readonly runId: string
  readonly agentName: string
  readonly turn: number
  /** Default deadline; a tool's own `timeoutMs` wins when set. */
  readonly defaultTimeoutMs: number
  /** The run's signal. Aborting it aborts every in-flight tool. */
  readonly signal: AbortSignal
  /**
   * Guardrails to consult before any handler runs. Absent means no gating, and
   * the whole prepare phase collapses to validation exactly as it always did.
   */
  readonly gate?: ToolGate
}

/** What `executeToolCalls` needs in order to consult guardrails. */
export interface ToolGate {
  readonly guardrails: readonly AnyToolGuardrail[]
  readonly context: GuardrailContext
  /** Emits `guardrail.triggered`. */
  readonly onTriggered: (event: {
    guardrail: string
    action: 'reject' | 'require_approval'
    toolName: string
    toolCallId: string
    reason?: string
  }) => void
}

export interface ToolCallOutcome {
  /** Always produced — even for a failure, so the model can see and recover. */
  readonly result: ToolResultPart
  /** Present when the call failed. The loop decides whether to throw it. */
  readonly error?: AgentError

  /**
   * Set when a tool guardrail vetoed this call.
   *
   * Deliberately **not** `error`. The runner throws on any `outcome.error` under
   * `onToolError: 'throw'`, and a policy decision is not a tool failure — a user
   * who set that flag so a broken database aborts the run must not have their
   * run aborted by a guardrail doing its job. The model still sees
   * `isError: true` and routes around it.
   */
  readonly blockedBy?: { readonly guardrail: string; readonly reason: string }

  readonly durationMs: number
}

/**
 * Thrown out of `executeToolCalls` when a guardrail wants a human.
 *
 * Internal: the runner catches it and converts it into the public
 * `ApprovalRequiredError` once it can attach the conversation. It is thrown
 * rather than returned because it is not an outcome for *one* call — it cancels
 * the whole turn.
 *
 * @internal
 */
export class ApprovalPending extends Error {
  readonly calls: readonly PendingToolCall[]

  constructor(calls: readonly PendingToolCall[]) {
    super('A tool guardrail requires approval.')
    this.name = 'ApprovalPending'
    this.calls = calls
    Object.setPrototypeOf(this, ApprovalPending.prototype)
  }
}

/**
 * Runs one tool call end to end:
 *
 *   1. look the tool up               → `ToolNotFoundError`
 *   2. validate arguments             → `InvalidToolInputError`
 *   3. invoke with a deadline         → `TimeoutError` / `ToolExecutionError`
 *
 * Never throws. Every failure becomes a `tool-result` with `isError: true`
 * *and* a structured error on the outcome, which is what lets the caller choose
 * between "show the model the error and let it recover" and "abort the run".
 */
export async function executeToolCall(
  call: ToolCallPart,
  options: ExecuteToolCallOptions,
): Promise<ToolCallOutcome> {
  const prepared = await prepareToolCall(call, options)

  if (prepared.kind === 'settled') return prepared.outcome
  if (prepared.kind === 'pending') throw new ApprovalPending([prepared.pending])

  return invokePrepared(prepared, options)
}

/**
 * A call that has been looked up, validated, and cleared by the guardrails —
 * everything up to the point of no return, and nothing past it.
 */
interface PreparedCall {
  readonly kind: 'ready'
  readonly call: ToolCallPart
  readonly tool: NonNullable<ReturnType<ToolRegistry['get']>>
  readonly input: unknown
  readonly startedAt: number
}

type Preparation =
  | PreparedCall
  | { readonly kind: 'settled'; readonly outcome: ToolCallOutcome }
  | { readonly kind: 'pending'; readonly pending: PendingToolCall }

/**
 * Everything that can be decided *without* side effects: does the tool exist, do
 * its arguments validate, and do the guardrails allow it.
 *
 * Separated from invocation so a turn can be evaluated as a whole before any
 * handler runs — see {@link executeToolCalls} for why that matters.
 */
async function prepareToolCall(
  call: ToolCallPart,
  options: ExecuteToolCallOptions,
): Promise<Preparation> {
  const startedAt = Date.now()
  const settle = (result: ToolResultPart, extra?: Partial<ToolCallOutcome>): Preparation => ({
    kind: 'settled',
    outcome: { result, ...extra, durationMs: Date.now() - startedAt },
  })

  const tool = options.registry.get(call.toolName)
  if (!tool) {
    const error = new ToolNotFoundError(call.toolName, options.registry.names())
    return settle(errorResult(call, error), { error })
  }

  // 1. Validate. A tool with no schema accepts anything and receives `{}`.
  let input: unknown = call.input ?? {}
  if (tool.inputSchema) {
    const validated = await validate(tool.inputSchema, input)
    if (!validated.ok) {
      const error = new InvalidToolInputError(call.toolName, validated.issues)
      return settle(errorResult(call, error), { error })
    }
    input = validated.value
  }

  // 2. Consult the guardrails. This runs *after* validation on purpose, so a
  // guardrail inspects coerced values it can trust rather than raw model JSON.
  if (options.gate) {
    const verdict = await evaluateGate(call, input, options.gate)

    if (verdict.kind === 'reject') {
      options.gate.onTriggered({
        guardrail: verdict.guardrail,
        action: 'reject',
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        reason: verdict.reason,
      })
      // No `error` on the outcome — see `ToolCallOutcome.blockedBy`.
      return settle(blockedResult(call, verdict.reason), {
        blockedBy: { guardrail: verdict.guardrail, reason: verdict.reason },
      })
    }

    if (verdict.kind === 'approval') {
      options.gate.onTriggered({
        guardrail: verdict.guardrail,
        action: 'require_approval',
        toolName: call.toolName,
        toolCallId: call.toolCallId,
        ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      })
      return {
        kind: 'pending',
        pending: {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input,
          guardrail: verdict.guardrail,
          reason: verdict.reason,
        },
      }
    }
  }

  return { kind: 'ready', call, tool, input, startedAt }
}

/**
 * Runs the tool guardrails that apply to one call, in declaration order.
 *
 * A guardrail that throws **fails closed**: it becomes a rejection naming it,
 * never a silent allow. Same rule as input and output guardrails, and the same
 * reason — a broken safety control must not wave traffic through.
 */
async function evaluateGate(
  call: ToolCallPart,
  input: unknown,
  gate: ToolGate,
): Promise<
  | { kind: 'allow' }
  | { kind: 'reject'; guardrail: string; reason: string }
  | { kind: 'approval'; guardrail: string; reason: string | undefined }
> {
  const subject = { toolName: call.toolName, toolCallId: call.toolCallId, input }

  for (const guardrail of gate.guardrails) {
    if (guardrail.tools && !guardrail.tools.includes(call.toolName)) continue

    let verdict
    try {
      verdict = await guardrail.check(subject, gate.context)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      return {
        kind: 'reject',
        guardrail: guardrail.name,
        reason: `the guardrail itself failed (${reason})`,
      }
    }

    if ('reject' in verdict) {
      return { kind: 'reject', guardrail: guardrail.name, reason: verdict.reject }
    }
    if ('requireApproval' in verdict) {
      return { kind: 'approval', guardrail: guardrail.name, reason: verdict.reason }
    }
  }

  return { kind: 'allow' }
}

/** The point of no return: everything from here can have a side effect. */
async function invokePrepared(
  prepared: PreparedCall,
  options: ExecuteToolCallOptions,
): Promise<ToolCallOutcome> {
  const { call, tool, input, startedAt } = prepared
  const finish = (result: ToolResultPart, error?: AgentError): ToolCallOutcome => ({
    result,
    ...(error ? { error } : {}),
    durationMs: Date.now() - startedAt,
  })

  const timeoutMs = tool.timeoutMs ?? options.defaultTimeoutMs
  const controller = new AbortController()
  const onAbort = () => controller.abort(options.signal.reason)

  if (options.signal.aborted) {
    const error = new AbortError()
    return finish(errorResult(call, error), error)
  }
  options.signal.addEventListener('abort', onAbort, { once: true })

  const timer = setTimeout(
    () => controller.abort(new TimeoutError(`Tool "${call.toolName}" timed out.`)),
    timeoutMs,
  )

  const context: ToolContext = {
    runId: options.runId,
    toolCallId: call.toolCallId,
    agentName: options.agentName,
    turn: options.turn,
    signal: controller.signal,
  }

  try {
    const output = await Promise.race([
      Promise.resolve(tool.execute(input, context)),
      abortPromise(controller.signal),
    ])

    return finish({
      type: 'tool-result',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      output,
    })
  } catch (cause) {
    const error = toAgentError(call.toolName, cause, timeoutMs, options.signal)
    return finish(errorResult(call, error), error)
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Runs every call from one assistant turn concurrently.
 *
 * Concurrency is the correct default: the model emitted these calls together
 * precisely because they are independent, and serializing them would multiply
 * latency for no benefit. Results are returned in the original call order so the
 * conversation stays deterministic regardless of which finished first.
 */
export async function executeToolCalls(
  calls: readonly ToolCallPart[],
  options: ExecuteToolCallOptions,
): Promise<readonly ToolCallOutcome[]> {
  // Two phases, and the barrier between them is load-bearing.
  //
  // If a turn holds two tool calls and only one is gated, running them together
  // would execute the ungated one, suspend for approval, and then execute it a
  // *second* time when the run resumes — a duplicated side effect, which is
  // precisely what an approval gate exists to prevent. So: if any call in a turn
  // needs a human, no tool in that turn runs.
  const prepared = await Promise.all(calls.map((call) => prepareToolCall(call, options)))

  const pending = prepared.flatMap((item) => (item.kind === 'pending' ? [item.pending] : []))
  if (pending.length > 0) throw new ApprovalPending(pending)

  // The throw above has already eliminated every `pending`, but the compiler
  // cannot see that through the array, so narrow it explicitly.
  const runnable = prepared.filter(
    (item): item is Exclude<Preparation, { kind: 'pending' }> => item.kind !== 'pending',
  )

  return Promise.all(
    runnable.map(async (item) =>
      item.kind === 'settled' ? item.outcome : invokePrepared(item, options),
    ),
  )
}

/**
 * The envelope a failing tool sends back to the model.
 *
 * It is plain, readable text on purpose — the model has to act on it, and models
 * recover from "Invalid input: city is required" far more reliably than from a
 * stack trace or an opaque error code.
 */
/**
 * What the model sees when a guardrail refuses a call.
 *
 * Shaped like {@link errorResult} so the tracer and the model treat it the same
 * way, but the code says `guardrail_blocked` rather than a tool failure — the
 * tool never ran, and nothing is broken.
 */
function blockedResult(call: ToolCallPart, reason: string): ToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    isError: true,
    output: { error: reason, code: 'guardrail_blocked' },
  }
}

function errorResult(call: ToolCallPart, error: AgentError): ToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    isError: true,
    output: { error: error.message, code: error.code },
  }
}

function toAgentError(
  toolName: string,
  cause: unknown,
  timeoutMs: number,
  runSignal: AbortSignal,
): AgentError {
  if (cause instanceof TimeoutError) return cause
  if (cause instanceof AgentError) return cause

  // A handler that forwards `context.signal` to fetch surfaces the abort as a
  // DOMException, which we translate back into the reason it was aborted for.
  if (isAbortLike(cause)) {
    return runSignal.aborted
      ? new AbortError(`Tool "${toolName}" was aborted because the run was cancelled.`)
      : new TimeoutError(`Tool "${toolName}" timed out after ${timeoutMs}ms.`, {
          hint: 'Raise `timeoutMs` on the tool, or make the handler faster.',
          details: { toolName, timeoutMs },
        })
  }

  return new ToolExecutionError(toolName, { cause })
}

function isAbortLike(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    (value as { name?: unknown }).name === 'AbortError'
  )
}

/**
 * Rejects as soon as `signal` aborts.
 *
 * Always rejects with an `Error`: an `AbortSignal.reason` is typed `any` and can
 * be an arbitrary value, but normalizing it here means every `catch` downstream —
 * including a user's — can rely on getting an Error.
 */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const rejectWithReason = () => reject(asAbortError(signal.reason))

    if (signal.aborted) {
      rejectWithReason()
      return
    }
    signal.addEventListener('abort', rejectWithReason, { once: true })
  })
}

function asAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  if (reason === undefined || reason === null) return new AbortError()
  return new AbortError(`The operation was aborted: ${safeStringify(reason)}`)
}
