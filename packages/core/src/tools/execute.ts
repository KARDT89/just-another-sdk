import {
  AbortError,
  AgentError,
  InvalidToolInputError,
  TimeoutError,
  ToolExecutionError,
  ToolNotFoundError,
} from '../errors/errors.js'
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
}

export interface ToolCallOutcome {
  /** Always produced — even for a failure, so the model can see and recover. */
  readonly result: ToolResultPart
  /** Present when the call failed. The loop decides whether to throw it. */
  readonly error?: AgentError
  readonly durationMs: number
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
  const startedAt = Date.now()
  const finish = (result: ToolResultPart, error?: AgentError): ToolCallOutcome => ({
    result,
    ...(error ? { error } : {}),
    durationMs: Date.now() - startedAt,
  })

  const tool = options.registry.get(call.toolName)
  if (!tool) {
    const error = new ToolNotFoundError(call.toolName, options.registry.names())
    return finish(errorResult(call, error), error)
  }

  // 1. Validate. A tool with no schema accepts anything and receives `{}`.
  let input: unknown = call.input ?? {}
  if (tool.inputSchema) {
    const validated = await validate(tool.inputSchema, input)
    if (!validated.ok) {
      const error = new InvalidToolInputError(call.toolName, validated.issues)
      return finish(errorResult(call, error), error)
    }
    input = validated.value
  }

  // 2. Invoke under a deadline, linked to the run's signal.
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
  return Promise.all(calls.map((call) => executeToolCall(call, options)))
}

/**
 * The envelope a failing tool sends back to the model.
 *
 * It is plain, readable text on purpose — the model has to act on it, and models
 * recover from "Invalid input: city is required" far more reliably than from a
 * stack trace or an opaque error code.
 */
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
