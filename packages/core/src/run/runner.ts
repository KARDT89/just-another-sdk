import {
  AGENT_DEFAULTS,
  type AgentConfig,
  type AgentInput,
  type RunOptions,
} from '../agent/types.js'
import {
  AbortError,
  ConfigurationError,
  InvalidOutputError,
  TimeoutError,
  toAgentError,
  type SchemaIssue,
} from '../errors/errors.js'
import { EventEmitter } from '../events/emitter.js'
import { toolCallsOf, textOf } from '../providers/provider.js'
import type { ModelProvider, ModelRequest, ModelResponse } from '../providers/provider.js'
import { validate } from '../schema/standard-schema.js'
import { defaultSessionStore } from '../sessions/memory.js'
import type { SessionStore } from '../sessions/store.js'
import { applySummary, summarizeMessages, type SummarizeOptions } from '../sessions/summarize.js'
import { trimHistory, type ContextPolicy } from '../sessions/trim.js'
import { executeToolCalls } from '../tools/execute.js'
import { ToolRegistry } from '../tools/registry.js'
import { assistantMessage, toolMessage, userMessage } from '../types/messages.js'
import type { ModelMessage, ToolResultPart } from '../types/messages.js'
import { createRunId } from '../util/id.js'
import { callModel } from './model-call.js'
import {
  extractJson,
  joinInstructions,
  repairRequest,
  resolveOutput,
  type ResolvedOutput,
} from './output.js'
import type { RunResult, StopReason } from './result.js'
import { resolveRetryPolicy, throwIfAborted, type ResolvedRetryPolicy } from './retry.js'
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
  config: AgentConfig<unknown>,
  input: AgentInput,
  options: RunOptions = {},
): Promise<RunResult<TOutput>> {
  return executeRun<TOutput>(config, input, options, { streaming: false })
}

/**
 * Knobs the loop needs that are not the caller's business.
 *
 * Keeping `streaming` here rather than on `RunOptions` means there is exactly
 * one loop implementation without exposing a flag that only the SDK's own
 * `agent.stream()` should ever set.
 *
 * @internal
 */
export interface RunInternals {
  /** Prefer `provider.stream()` when the provider implements it. */
  readonly streaming: boolean

  /**
   * Use this id rather than minting one.
   *
   * `agent.stream()` needs the id *before* the run produces its first event, so
   * that `toResponse()` can put it in a header and a resumable run can be keyed
   * by it. Generating it one level up is the only way to have it that early.
   */
  readonly runId?: string
}

/**
 * The loop itself. Imported by `run/stream.ts`; never exported from the package
 * root.
 *
 * @internal
 */
export async function executeRun<TOutput = string>(
  config: AgentConfig<unknown>,
  input: AgentInput,
  options: RunOptions,
  internals: RunInternals,
): Promise<RunResult<TOutput>> {
  const registry = new ToolRegistry(config.tools)
  const maxTurns = options.maxTurns ?? config.maxTurns ?? AGENT_DEFAULTS.maxTurns
  const onToolError = config.onToolError ?? AGENT_DEFAULTS.onToolError

  const runId = internals.runId ?? options.runId ?? createRunId()
  const events = new EventEmitter(options.onEvent)

  const instructions = await resolveInstructions(config)
  const session = resolveSession(config, options)

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

  // Loading happens after `run.start` so that event is always first, and in its
  // own try because there is no `RunState` to report against yet.
  let history: readonly ModelMessage[]
  try {
    history = await loadHistory(config, options, session, events, runId, signal)
  } catch (cause) {
    const error = toAgentError(cause)
    events.emit({ type: 'run.error', runId, agentName: config.name, error, turn: 1 })
    dispose()
    throw error
  }

  const state = new RunState({
    runId,
    agentName: config.name,
    modelId: config.model.modelId,
    messages: [...history, ...normalizeInput(input)],
  })

  const toolDefinitions = await registry.definitions()

  // Resolved beside the tool definitions and for the same reason: the first
  // derivation can pay for a dynamic `import('zod')`, and neither the schema nor
  // its instruction changes between turns.
  const output = await resolveOutput(config, options)

  // The schema instruction is layered on top of the developer's prompt rather
  // than merged into the request, so `result.messages` carries exactly what the
  // model saw. `resolveInstructions` stays the developer's prompt alone — a
  // function instruction is still called exactly once, and an agent with no
  // instructions still gets a system message here rather than losing the schema.
  const system = output ? joinInstructions(instructions, output.instruction) : instructions

  // Hoisted so the loop body stays literal. With an `outputSchema` the model's
  // only text *is* the JSON object, and half an object is not something any UI
  // can render — the same reasoning that withholds partial tool arguments and
  // keeps `model.request` out of the browser. The transport still streams; the
  // event is what we withhold.
  const emitTextDelta = output
    ? () => {}
    : (turn: number, delta: string) => {
        events.emit({ type: 'text.delta', runId, agentName: config.name, turn, delta })
      }

  // Resolved once: these do not change between turns, and rebuilding them per
  // turn would be pure waste in the hottest part of the loop.
  const toolChoice = options.toolChoice ?? config.toolChoice
  const metadata = mergeMetadata(config, options)
  const modelTimeoutMs = config.modelTimeoutMs ?? AGENT_DEFAULTS.modelTimeoutMs

  // The chain is rebuilt from the primary at the start of every turn, so a
  // transient outage cannot permanently demote the preferred model.
  const providers = [config.model, ...(config.fallbacks ?? [])]
  const retryPolicy = resolveRetryPolicy(config, options)

  try {
    let stopReason: StopReason = 'max_turns'

    while (state.turns < maxTurns) {
      throwIfAborted(signal)

      const turn = state.currentTurn
      const turnStartedAt = Date.now()

      const request: ModelRequest = {
        messages: state.messages,
        ...(system ? { system } : {}),
        ...(toolDefinitions ? { tools: toolDefinitions } : {}),
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        ...(output ? { responseFormat: output.responseFormat } : {}),
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
      const outcome = await callModel({
        providers,
        request,
        signal,
        timeoutMs: modelTimeoutMs,
        retry: retryPolicy,
        streaming: internals.streaming,
        onTextDelta: (delta) => {
          emitTextDelta(turn, delta)
        },
        onRetry: (info) => {
          events.emit({
            type: 'model.retry',
            runId,
            agentName: config.name,
            turn,
            modelId: info.provider.modelId,
            providerId: info.provider.providerId,
            attempt: info.attempt,
            maxAttempts: info.maxAttempts,
            error: info.error,
            delayMs: info.delayMs,
            discardedText: info.discardedText,
          })
        },
        onFallback: (info) => {
          events.emit({
            type: 'model.fallback',
            runId,
            agentName: config.name,
            turn,
            fromModelId: info.from.modelId,
            fromProviderId: info.from.providerId,
            toModelId: info.to.modelId,
            toProviderId: info.to.providerId,
            index: info.index,
            error: info.error,
            discardedText: info.discardedText,
          })
        },
      })
      const response: ModelResponse = outcome.response
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
        state.completeTurn({
          turn,
          text,
          toolCalls: [],
          toolResults: [],
          finishReason: response.finishReason,
          usage: response.usage,
          durationMs: Date.now() - turnStartedAt,
          modelId: response.modelId,
        })
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

      state.completeTurn({
        turn,
        text,
        toolCalls,
        toolResults: results,
        finishReason: response.finishReason,
        usage: response.usage,
        durationMs: Date.now() - turnStartedAt,
        modelId: response.modelId,
      })

      // A cancelled run must not silently continue into another model call.
      const aborted = outcomes.find((outcome) => outcome.error?.code === 'aborted')
      if (aborted?.error) throw aborted.error

      if (onToolError === 'throw') {
        const failure = outcomes.find((outcome) => outcome.error !== undefined)
        if (failure?.error) throw failure.error
      }
    }

    // Validated on every exit path, `max_turns` included: `outputSchema` is a
    // type contract, and returning a `RunResult<Ticket>` whose `output` is
    // really a string is worse than an error naming the field that failed.
    //
    // **This must stay above the session save.** Throwing here is what keeps the
    // "only a completed run is persisted" invariant true for a run that never
    // produced a valid answer — there is no extra code enforcing it, only this
    // ordering. Moving the call below the save would break it silently.
    const validated = output
      ? await finalizeOutput({
          output,
          state,
          config,
          events,
          runId,
          signal,
          providers,
          retryPolicy,
          modelTimeoutMs,
          system,
          metadata,
        })
      : undefined

    // Only a completed run is persisted, and only the messages it produced.
    //
    // A run that threw mid-turn can leave an assistant message holding tool
    // calls whose results never arrived; every provider rejects that on the next
    // request, so saving it would poison the session rather than preserve it.
    // `max_turns` is a completion — the conversation is valid, just unfinished.
    if (session) {
      const savedAt = Date.now()
      const produced = state.messages.slice(history.length)
      await session.store.append(session.sessionId, produced)
      events.emit({
        type: 'session.save',
        runId,
        agentName: config.name,
        sessionId: session.sessionId,
        appendedCount: produced.length,
        durationMs: Date.now() - savedAt,
      })
    }

    const result = buildResult<TOutput>(state, config, stopReason, system, validated)

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
/* Structured output                                                         */
/* ------------------------------------------------------------------------- */

/** A validated final answer, boxed so `undefined` stays a legal output value. */
interface ValidatedOutput {
  readonly value: unknown
}

/**
 * Turns the model's final text into a value that satisfies `outputSchema`,
 * re-asking a bounded number of times if it does not.
 *
 * Runs *outside* the loop, which is the whole design: the repair budget is
 * additive to `maxTurns` rather than carved out of it, and it cannot interact
 * with the transport retry inside `callModel` because that one re-sends an
 * identical request while this one sends a different conversation.
 *
 * Throws {@link InvalidOutputError} when the budget is spent.
 */
async function finalizeOutput(args: {
  output: ResolvedOutput
  state: RunState
  config: AgentConfig<unknown>
  events: EventEmitter
  runId: string
  signal: AbortSignal
  providers: readonly ModelProvider[]
  retryPolicy: ResolvedRetryPolicy
  modelTimeoutMs: number
  system: string | undefined
  metadata: Readonly<Record<string, string>> | undefined
}): Promise<ValidatedOutput> {
  const { output, state, config, events, runId, signal } = args

  // The turn being repaired. Repair steps carry it too, so `steps` still group
  // by exchange rather than inventing turn numbers that never happened.
  const turn = state.turns
  const maxAttempts = output.maxRetries + 1

  let text = state.finalText()
  let issues: readonly SchemaIssue[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(signal)

    const extracted = extractJson(text)
    if (extracted.ok) {
      const result = await validate(output.schema, extracted.value)
      if (result.ok) return { value: result.value }
      issues = result.issues
    } else {
      // No issues to report: the validator never saw a value. The repair prompt
      // and the error both say so rather than inventing a path.
      issues = []
    }

    const repairing = attempt < maxAttempts

    events.emit({
      type: 'output.invalid',
      runId,
      agentName: config.name,
      turn,
      attempt,
      maxAttempts,
      issues,
      repairing,
    })

    if (!repairing) break

    text = await requestRepair({ ...args, turn, issues })
  }

  throw new InvalidOutputError(issues, text, { attempts: output.maxRetries })
}

/**
 * One repair call: shows the model its own invalid answer plus what was wrong
 * with it, and returns the new text.
 *
 * Goes through `callModel` like every other model call, so retries, fallbacks,
 * timeouts, cancellation, and the `model.retry` / `model.fallback` events all
 * keep working during a repair.
 */
async function requestRepair(args: {
  state: RunState
  config: AgentConfig<unknown>
  events: EventEmitter
  runId: string
  signal: AbortSignal
  providers: readonly ModelProvider[]
  retryPolicy: ResolvedRetryPolicy
  modelTimeoutMs: number
  system: string | undefined
  metadata: Readonly<Record<string, string>> | undefined
  output: ResolvedOutput
  turn: number
  issues: readonly SchemaIssue[]
}): Promise<string> {
  const { state, config, events, runId, signal, output, turn, issues } = args

  // The invalid assistant turn is already in the log — the loop appended it
  // before taking the exit branch — so the model can see what it said. This adds
  // only the correction, as a `user` message: a second mid-conversation `system`
  // message is ignored or rejected by several providers, and a tool message
  // would need a `toolCallId` that does not exist here.
  state.append(userMessage(repairRequest(issues)))

  const startedAt = Date.now()

  // No `tools` on a repair request. We are outside the loop, so a tool call
  // could not be executed if the model made one; omitting the definitions is
  // what guarantees the answer is text. Not `toolChoice: 'none'` — some
  // OpenAI-compatible servers reject a choice sent without tools.
  const request: ModelRequest = {
    messages: state.messages,
    ...(args.system ? { system: args.system } : {}),
    responseFormat: output.responseFormat,
    ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(args.metadata ? { metadata: args.metadata } : {}),
  }

  events.emit({
    type: 'model.request',
    runId,
    agentName: config.name,
    turn,
    modelId: config.model.modelId,
    messageCount: state.messageCount,
    tools: [],
  })

  const outcome = await callModel({
    providers: args.providers,
    request,
    signal,
    timeoutMs: args.modelTimeoutMs,
    retry: args.retryPolicy,
    // A repair answer is a JSON object that is withheld from `text.delta`
    // anyway, so streaming it would buy nothing but a second code path.
    streaming: false,
    onTextDelta: () => {},
    onRetry: (info) => {
      events.emit({
        type: 'model.retry',
        runId,
        agentName: config.name,
        turn,
        modelId: info.provider.modelId,
        providerId: info.provider.providerId,
        attempt: info.attempt,
        maxAttempts: info.maxAttempts,
        error: info.error,
        delayMs: info.delayMs,
        discardedText: info.discardedText,
      })
    },
    onFallback: (info) => {
      events.emit({
        type: 'model.fallback',
        runId,
        agentName: config.name,
        turn,
        fromModelId: info.from.modelId,
        fromProviderId: info.from.providerId,
        toModelId: info.to.modelId,
        toProviderId: info.to.providerId,
        index: info.index,
        error: info.error,
        discardedText: info.discardedText,
      })
    },
  })

  const response = outcome.response
  const text = textOf(response)
  const durationMs = Date.now() - startedAt

  state.append(assistantMessage(response.content))

  events.emit({
    type: 'model.response',
    runId,
    agentName: config.name,
    turn,
    modelId: response.modelId,
    text,
    toolCalls: [],
    finishReason: response.finishReason,
    usage: response.usage,
    durationMs,
  })

  // Recorded as a step but not as a turn: it costs tokens and can be served by a
  // fallback, so leaving it out would make `usage` wrong — but it is not a loop
  // turn, so counting it would push `turns` past `maxTurns`.
  state.completeRepair({
    turn,
    text,
    toolCalls: [],
    toolResults: [],
    finishReason: response.finishReason,
    usage: response.usage,
    durationMs,
    modelId: response.modelId,
  })

  return text
}

/* ------------------------------------------------------------------------- */
/* Sessions                                                                  */
/* ------------------------------------------------------------------------- */

/** A store bound to the id this run is continuing. */
interface ResolvedSession {
  readonly store: SessionStore
  readonly sessionId: string
}

/**
 * Decides whether this run is part of a persisted conversation, and against
 * which store.
 *
 * An agent with no `session` still honours a `sessionId`, against a bounded
 * in-memory store owned by that agent. Multi-turn therefore works with no
 * imports and no setup, and moving to real persistence is one config line.
 */
function resolveSession(
  config: AgentConfig<unknown>,
  options: RunOptions,
): ResolvedSession | undefined {
  const sessionId = options.sessionId
  if (sessionId === undefined) return undefined

  if (options.messages && options.messages.length > 0) {
    throw new ConfigurationError('Pass either `sessionId` or `messages`, not both.', {
      hint:
        'A session already holds the conversation. Passing `messages` as well would ' +
        'send two overlapping copies of it to the model. Use `sessionId` alone to ' +
        'continue a stored conversation, or `messages` alone to manage history yourself.',
      details: { sessionId, messageCount: options.messages.length },
    })
  }

  return { store: config.session ?? defaultSessionStore(config), sessionId }
}

/**
 * The conversation this run starts from: stored history when there is a session,
 * the caller's `messages` otherwise, trimmed to the context policy either way.
 *
 * Trimming is not destructive — the store keeps everything, and only what the
 * model sees is bounded. A later run with a larger budget sees the full history
 * again.
 */
async function loadHistory(
  config: AgentConfig<unknown>,
  options: RunOptions,
  session: ResolvedSession | undefined,
  events: EventEmitter,
  runId: string,
  signal: AbortSignal,
): Promise<readonly ModelMessage[]> {
  if (!session) return trimHistory(normalizeHistory(options.messages), config.context)

  const policy = config.context
  const startedAt = Date.now()

  // `maxMessages` is the only policy that yields a safe row count, so it is the
  // only one that bounds the read. A `maxTokens` budget has no message count to
  // derive one from, and guessing low would silently drop context the policy
  // would have kept. The store may ignore this — trimming below is the
  // guarantee, this is only the optimisation.
  //
  // One *more* than the budget is requested on purpose. Asking for exactly
  // `maxMessages` would make a truncated read indistinguishable from a complete
  // one, and `session.load` would report `droppedCount: 0` for a conversation
  // whose beginning had just been cut off — precisely the silent context loss
  // that event exists to expose. The extra row costs nothing and answers the
  // question.
  //
  // Summarizing turns the window off. A summary records *how many messages from
  // the start of the log* it stands in for, and a windowed read cannot know
  // that — it would compute the watermark against the window and produce a
  // summary claiming to cover 1 message when it covers 40. The next load would
  // then replay everything between, duplicating history on every run. Correct
  // beats fast; `maxMessages` without `summarize` still bounds the read.
  const windowSize = policy?.summarize ? undefined : policy?.maxMessages
  const raw = await session.store.load(
    session.sessionId,
    windowSize === undefined ? undefined : { limit: windowSize + 1 },
  )
  const truncated = windowSize !== undefined && raw.length > windowSize

  const stored = normalizeHistory(raw)

  // A stored summary stands in for the messages it covers, so the window starts
  // from it rather than from the top of the log.
  const base = policy?.summarize ? applySummary(stored) : stored
  const trimmed = trimHistory(base, policy)

  const history =
    trimmed.length === base.length
      ? trimmed
      : await summarizeDropped({
          config,
          session,
          events,
          runId,
          signal,
          storedCount: stored.length,
          base,
        })

  // Emitted last, so it describes what the run actually starts with rather than
  // an intermediate state that summarizing may have replaced.
  events.emit({
    type: 'session.load',
    runId,
    agentName: config.name,
    sessionId: session.sessionId,
    messageCount: history.length,
    droppedCount: base.length - history.length,
    truncated,
    durationMs: Date.now() - startedAt,
  })

  return history
}

/**
 * Replaces aged-out history with a recap, and persists it so the cost is paid
 * once rather than every run.
 *
 * Returns plain trimmed history when summarizing is off or fails — **the run
 * must survive a failed summary.** A recap is an optimisation on cost and
 * continuity; losing it must never lose the answer.
 */
async function summarizeDropped(args: {
  config: AgentConfig<unknown>
  session: ResolvedSession
  events: EventEmitter
  runId: string
  signal: AbortSignal
  storedCount: number
  base: readonly ModelMessage[]
}): Promise<readonly ModelMessage[]> {
  const { config, session, events, runId, signal, storedCount, base } = args
  const policy = config.context
  const setting = policy?.summarize

  if (!setting) return trimHistory(base, policy)

  const options: SummarizeOptions = setting === true ? {} : setting

  // Folded back to *half* the budget rather than to the budget itself. Folding
  // to the limit leaves no headroom, so the very next turn is over it again and
  // buys another summary — one extra model call per turn, forever. Halving
  // means a fold lasts for several turns of growth.
  const kept = trimHistory(base, foldTarget(policy, options))
  const dropped = base.slice(0, base.length - kept.length)
  if (dropped.length === 0) return kept

  // What the summary stands in for: everything except the tail kept verbatim.
  // Derived from the *stored* length rather than the window's, because that is
  // the number a later run slices the log at.
  const covered = storedCount - kept.length
  const startedAt = Date.now()

  try {
    const summary = await summarizeMessages({
      messages: dropped,
      covered,
      model: options.model ?? config.model,
      options,
      signal,
    })

    await session.store.append(session.sessionId, [summary])

    events.emit({
      type: 'session.summarize',
      runId,
      agentName: config.name,
      sessionId: session.sessionId,
      coveredCount: covered,
      foldedCount: dropped.length,
      keptCount: kept.length,
      durationMs: Date.now() - startedAt,
    })

    return [summary, ...kept]
  } catch (cause) {
    const error = toAgentError(cause)

    // Cancellation is the run ending, not a summary failing — do not swallow it.
    if (error.code === 'aborted') throw error

    events.emit({
      type: 'session.summarize',
      runId,
      agentName: config.name,
      sessionId: session.sessionId,
      coveredCount: covered,
      foldedCount: dropped.length,
      keptCount: kept.length,
      durationMs: Date.now() - startedAt,
      error,
    })

    // Fall back to what the policy alone would have kept.
    return trimHistory(base, policy)
  }
}

/** The tighter budget a fold compacts down to. See {@link SummarizeOptions.keepRecent}. */
function foldTarget(
  policy: ContextPolicy | undefined,
  options: SummarizeOptions,
): ContextPolicy | undefined {
  const keepRecent = options.keepRecent
  const half = (value: number): number => Math.max(1, Math.floor(value / 2))

  if (policy?.maxMessages !== undefined) {
    return { maxMessages: keepRecent ?? half(policy.maxMessages) }
  }

  if (policy?.maxTokens !== undefined) {
    return {
      maxTokens: keepRecent ?? half(policy.maxTokens),
      ...(policy.countTokens ? { countTokens: policy.countTokens } : {}),
    }
  }

  return policy
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

function buildResult<TOutput>(
  state: RunState,
  config: AgentConfig<unknown>,
  stopReason: StopReason,
  instructions: string | undefined,
  validated: ValidatedOutput | undefined,
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
    // With an `outputSchema` this is the value the validator produced, and the
    // cast is sound: `TOutput` was inferred from that same schema.
    //
    // Without one the output *is* the text, and the cast is the caller's own
    // assertion — `run<T>()` with no schema promises a `T` that nothing checks.
    // That is why an unchecked `T` and a schema-derived one are different casts
    // rather than one shared line.
    output: (validated ? validated.value : text) as TOutput,
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

async function resolveInstructions(config: AgentConfig<unknown>): Promise<string | undefined> {
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
  config: AgentConfig<unknown>,
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
