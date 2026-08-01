import {
  AGENT_DEFAULTS,
  type AgentConfig,
  type AgentInput,
  type RunOptions,
} from '../agent/types.js'
import { AbortError, AgentError, TimeoutError } from '../errors/errors.js'
import { EventEmitter } from '../events/emitter.js'
import { toolCallsOf, textOf } from '../providers/provider.js'
import type { ModelRequest, ModelResponse } from '../providers/provider.js'
import { executeToolCalls } from '../tools/execute.js'
import { ToolRegistry } from '../tools/registry.js'
import { assistantMessage, toolMessage, userMessage } from '../types/messages.js'
import type { ModelMessage, ToolResultPart } from '../types/messages.js'
import { createRunId } from '../util/id.js'
import type { RunResult, StopReason } from './result.js'
import { RunState } from './run-state.js'

/**
 * The agent loop.
 *
 * ```text
 *   build state ──▶ ┌─────────────────────────────────────┐
 *                   │  call the model                     │
 *                   │  no tool calls?  ──▶ stop: finish   │
 *                   │  execute tools (in parallel)        │
 *                   │  append results, next turn          │
 *                   └──────────────┬──────────────────────┘
 *                                  │ turns exhausted
 *                                  ▼
 *                            stop: max_turns
 * ```
 *
 * Three invariants hold, and the tests assert each one:
 *
 *   1. **It always terminates.** Every path out of the loop sets a `StopReason`.
 *      There is no `while (true)` without a bounded counter, so a model that
 *      calls tools forever costs at most `maxTurns` requests.
 *
 *   2. **A completed run does not throw.** Tool failures become tool results the
 *      model can read and recover from. Only an unrecoverable condition —
 *      provider outage, cancellation, or an explicit `onToolError: 'throw'` —
 *      rejects the promise.
 *
 *   3. **Every turn is recorded.** `steps`, `usage`, and `messages` are complete
 *      even when the run stopped early, so tracing and billing never need to
 *      re-derive what happened.
 */
export async function runAgent<TOutput = string>(
  config: AgentConfig,
  input: AgentInput,
  options: RunOptions = {},
): Promise<RunResult<TOutput>> {
  const registry = new ToolRegistry(config.tools)
  const maxTurns = options.maxTurns ?? config.maxTurns ?? AGENT_DEFAULTS.maxTurns
  const onToolError = config.onToolError ?? AGENT_DEFAULTS.onToolError

  const runId = createRunId()
  const events = new EventEmitter(options.onEvent)

  const instructions = await resolveInstructions(config)
  const state = new RunState({
    runId,
    agentName: config.name,
    modelId: config.model.modelId,
    messages: [...normalizeHistory(options.messages), ...normalizeInput(input)],
  })

  // One controller for the whole run: the caller's signal and the overall
  // timeout both feed into it, and it is what every model call and tool sees.
  const { signal, dispose } = createRunSignal(options)

  events.emit({
    type: 'run.start',
    runId,
    agentName: config.name,
    modelId: config.model.modelId,
    input: typeof input === 'string' ? input : '(messages)',
    toolNames: registry.names(),
  })

  const toolDefinitions = await registry.definitions()

  // Resolved once: these do not change between turns, and rebuilding them per
  // turn would be pure waste in the hottest part of the loop.
  const toolChoice = options.toolChoice ?? config.toolChoice
  const metadata = mergeMetadata(config, options)
  const modelTimeoutMs = config.modelTimeoutMs ?? AGENT_DEFAULTS.modelTimeoutMs

  try {
    let stopReason: StopReason = 'max_turns'

    while (state.turns < maxTurns) {
      throwIfAborted(signal)

      const turn = state.currentTurn
      const turnStartedAt = Date.now()

      const request: ModelRequest = {
        messages: state.messages,
        ...(instructions ? { system: instructions } : {}),
        ...(toolDefinitions ? { tools: toolDefinitions } : {}),
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        ...(config.maxOutputTokens !== undefined
          ? { maxOutputTokens: config.maxOutputTokens }
          : {}),
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(metadata ? { metadata } : {}),
      }

      events.emit({
        type: 'model.request',
        runId,
        agentName: config.name,
        turn,
        modelId: config.model.modelId,
        messageCount: state.messageCount,
        tools: toolDefinitions ?? [],
      })

      const modelStartedAt = Date.now()
      const response: ModelResponse = await config.model.generate(request, {
        signal,
        timeoutMs: modelTimeoutMs,
      })
      const modelDurationMs = Date.now() - modelStartedAt

      const text = textOf(response)
      const toolCalls = toolCallsOf(response)

      // The assistant turn is appended *before* tools run, so the conversation
      // stays valid even if a tool throws: providers reject a tool result whose
      // originating tool_use message is missing.
      state.append(assistantMessage(response.content))

      events.emit({
        type: 'model.response',
        runId,
        agentName: config.name,
        turn,
        modelId: response.modelId,
        text,
        toolCalls,
        finishReason: response.finishReason,
        usage: response.usage,
        durationMs: modelDurationMs,
      })

      // No tool calls means the model has answered: this is the exit.
      if (toolCalls.length === 0) {
        state.completeTurn(
          {
            turn,
            text,
            toolCalls: [],
            toolResults: [],
            finishReason: response.finishReason,
            usage: response.usage,
            durationMs: Date.now() - turnStartedAt,
          },
          response.modelId,
        )
        stopReason = 'finish'
        break
      }

      for (const call of toolCalls) {
        events.emit({
          type: 'tool.start',
          runId,
          agentName: config.name,
          turn,
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          input: call.input,
        })
      }

      const outcomes = await executeToolCalls(toolCalls, {
        registry,
        runId,
        agentName: config.name,
        turn,
        defaultTimeoutMs: config.toolTimeoutMs ?? AGENT_DEFAULTS.toolTimeoutMs,
        signal,
      })

      for (const outcome of outcomes) {
        events.emit({
          type: 'tool.end',
          runId,
          agentName: config.name,
          turn,
          toolName: outcome.result.toolName,
          toolCallId: outcome.result.toolCallId,
          result: outcome.result,
          isError: outcome.result.isError === true,
          durationMs: outcome.durationMs,
        })
      }

      const results: ToolResultPart[] = outcomes.map((outcome) => outcome.result)
      state.append(toolMessage(results))

      state.completeTurn(
        {
          turn,
          text,
          toolCalls,
          toolResults: results,
          finishReason: response.finishReason,
          usage: response.usage,
          durationMs: Date.now() - turnStartedAt,
        },
        response.modelId,
      )

      // A cancelled run must not silently continue into another model call.
      const aborted = outcomes.find((outcome) => outcome.error?.code === 'aborted')
      if (aborted?.error) throw aborted.error

      if (onToolError === 'throw') {
        const failure = outcomes.find((outcome) => outcome.error !== undefined)
        if (failure?.error) throw failure.error
      }
    }

    const result = buildResult<TOutput>(state, config, stopReason, instructions)

    events.emit({
      type: 'run.finish',
      runId,
      agentName: config.name,
      stopReason,
      text: result.text,
      turns: result.turns,
      usage: result.usage,
      durationMs: result.durationMs,
    })

    return result
  } catch (cause) {
    const error = toAgentError(cause)

    events.emit({
      type: 'run.error',
      runId,
      agentName: config.name,
      error,
      turn: state.currentTurn,
    })

    throw error
  } finally {
    dispose()
  }
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

function buildResult<TOutput>(
  state: RunState,
  config: AgentConfig,
  stopReason: StopReason,
  instructions: string | undefined,
): RunResult<TOutput> {
  const text = state.finalText()

  // The system message is prepended for round-tripping: passing `result.messages`
  // straight back into `run()` must reproduce the same conversation.
  const messages: ModelMessage[] = instructions
    ? [{ role: 'system', content: instructions }, ...state.messages]
    : [...state.messages]

  return {
    runId: state.runId,
    agentName: config.name,
    // Until structured output lands, the output *is* the text. The generic keeps
    // the signature stable so adding it later is not a breaking change.
    output: text as unknown as TOutput,
    text,
    stopReason,
    messages,
    steps: state.steps,
    usage: state.usage,
    turns: state.turns,
    durationMs: state.elapsedMs,
    modelId: state.modelId,
  }
}

async function resolveInstructions(config: AgentConfig): Promise<string | undefined> {
  if (config.instructions === undefined) return undefined
  if (typeof config.instructions === 'string') {
    return config.instructions.length > 0 ? config.instructions : undefined
  }
  const resolved = await config.instructions()
  return resolved.length > 0 ? resolved : undefined
}

function normalizeInput(input: AgentInput): readonly ModelMessage[] {
  if (typeof input === 'string') return [userMessage(input)]
  return input.filter((message) => message.role !== 'system')
}

/**
 * Strips the system message from prior history: instructions are re-derived from
 * the agent on every run, so keeping the old one would duplicate it.
 */
function normalizeHistory(messages: readonly ModelMessage[] | undefined): readonly ModelMessage[] {
  if (!messages) return []
  return messages.filter((message) => message.role !== 'system')
}

function mergeMetadata(
  config: AgentConfig,
  options: RunOptions,
): Readonly<Record<string, string>> | undefined {
  if (!config.metadata && !options.metadata) return undefined
  return { ...config.metadata, ...options.metadata }
}

/**
 * Builds the signal every model call and tool observes.
 *
 * Composing the caller's signal with the run-level timeout here means the loop
 * body never has to reason about cancellation, and `dispose()` guarantees no
 * listener is left attached to a long-lived caller signal.
 */
function createRunSignal(options: RunOptions): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const cleanups: (() => void)[] = []

  if (options.signal) {
    const callerSignal = options.signal
    if (callerSignal.aborted) {
      controller.abort(new AbortError())
    } else {
      const onAbort = () => controller.abort(new AbortError())
      callerSignal.addEventListener('abort', onAbort, { once: true })
      cleanups.push(() => callerSignal.removeEventListener('abort', onAbort))
    }
  }

  if (options.timeoutMs !== undefined) {
    const timer = setTimeout(
      () => controller.abort(new TimeoutError(`The run exceeded ${options.timeoutMs}ms.`)),
      options.timeoutMs,
    )
    cleanups.push(() => clearTimeout(timer))
  }

  return {
    signal: controller.signal,
    dispose: () => {
      for (const cleanup of cleanups) cleanup()
    },
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  throw signal.reason instanceof AgentError ? signal.reason : new AbortError()
}

/** Guarantees callers only ever catch an `AgentError`. */
function toAgentError(cause: unknown): AgentError {
  if (cause instanceof AgentError) return cause
  return new AgentError(cause instanceof Error ? cause.message : String(cause), {
    code: 'provider_error',
    cause,
  })
}
