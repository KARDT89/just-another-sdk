import {
  AGENT_DEFAULTS,
  type AgentConfig,
  type AgentInput,
  type RunOptions,
} from '../agent/types.js'
import {
  AbortError,
  ApprovalRequiredError,
  ConfigurationError,
  InvalidOutputError,
  TimeoutError,
  toAgentError,
  type SchemaIssue,
} from '../errors/errors.js'
import { EventEmitter } from '../events/emitter.js'
import { applyInputGuardrails, applyOutputGuardrails } from '../guardrails/apply.js'
import type { ApprovalDecision } from '../guardrails/types.js'
import { briefing, refusalResult, repairPairing, resolveHandoffs } from '../handoffs/handoff.js'
import type { HandoffRefusal, ResolvedHandoff } from '../handoffs/types.js'
import { toolCallsOf, textOf } from '../providers/provider.js'
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ToolChoice,
  ToolDefinition,
} from '../providers/provider.js'
import { validate } from '../schema/standard-schema.js'
import { defaultSessionStore } from '../sessions/memory.js'
import type { SessionStore } from '../sessions/store.js'
import { applySummary, summarizeMessages, type SummarizeOptions } from '../sessions/summarize.js'
import { trimHistory, type ContextPolicy } from '../sessions/trim.js'
import {
  ApprovalPending,
  executeToolCalls,
  type ToolCallOutcome,
  type ToolGate,
} from '../tools/execute.js'
import { ToolRegistry } from '../tools/registry.js'
import { resolveAgentTools } from '../tools/resolve.js'
import {
  assistantMessage,
  messageText,
  toolMessage,
  userMessage,
  ZERO_USAGE,
} from '../types/messages.js'
import type { ModelMessage, ToolCallPart, ToolResultPart } from '../types/messages.js'
import { createRunId } from '../util/id.js'
import { safeStringify } from '../util/stringify.js'
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

  /**
   * Messages a suspended run produced, grafted on before the loop starts.
   *
   * Only `Agent.resumeApproval` sets this, and only for a session-backed
   * resume: the suspended run persisted nothing, so the store is missing the
   * user turn and the assistant tool-call turn that the pending calls belong
   * to. Without it the loaded history would not contain the calls being
   * approved.
   */
  readonly replay?: readonly ModelMessage[]
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
  const maxTurns = options.maxTurns ?? config.maxTurns ?? AGENT_DEFAULTS.maxTurns
  const maxHandoffs = options.maxHandoffs ?? config.maxHandoffs ?? AGENT_DEFAULTS.maxHandoffs

  const runId = internals.runId ?? options.runId ?? createRunId()
  const events = new EventEmitter(options.onEvent)

  // Every agent-derived value now goes through here rather than being hoisted,
  // because a handoff changes which agent the loop is running. Resolution is
  // memoized per config and *lazy*, so a five-agent graph costs nothing until
  // the run reaches a given agent — and a config-level cycle (A lists B, B lists
  // A) is harmless, since nothing walks the graph ahead of time.
  const resolveAgent = createAgentResolver(options)
  let active = await resolveAgent(config)

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
    toolNames: active.registry.names(),
  })

  // Loading happens after `run.start` so that event is always first, and in its
  // own try because there is no `RunState` to report against yet.
  //
  // Input guardrails run in the same try, and after the load rather than before
  // it: a guardrail that inspects the conversation needs the history, and a
  // store read costs no tokens. Being inside this try is what gives a rejection
  // its `run.error` event — nothing thrown above the main `try` below gets one.
  let history: readonly ModelMessage[]
  let turnMessages: readonly ModelMessage[]
  try {
    history = await loadHistory(config, options, session, events, runId, signal)
    turnMessages = await guardInput({
      config,
      events,
      runId,
      signal,
      history,
      input,
    })
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
    messages: [...history, ...(internals.replay ?? []), ...turnMessages],
  })

  // Run-scoped, deliberately **not** per agent. `outputSchema` is a promise the
  // *caller* made — `triage.run<Ticket>()` must return a `Ticket` no matter
  // which specialist ends up answering — so the initiating agent's schema
  // governs and a handoff target's own is ignored. Its instruction is joined
  // onto whichever agent is acting, so the specialist still knows the shape.
  const output = await resolveOutput(config, options)

  // With an `outputSchema` the model's only text *is* the JSON object, and half
  // an object is not something any UI can render — the same reasoning that
  // withholds partial tool arguments and keeps `model.request` out of the
  // browser. The transport still streams; the event is what we withhold.
  const emitTextDelta = output
    ? () => {}
    : (turn: number, delta: string) => {
        events.emit({ type: 'text.delta', runId, agentName: state.activeAgentName, turn, delta })
      }

  // Closed over the run's state and emitter once; the acting agent and the turn
  // are what vary, so they are arguments.
  const makeGate = buildGateFactory({ state, events, runId, signal })

  try {
    // Settles tool calls carried over from a suspended run, so the loop below
    // starts against a complete conversation. A no-op unless `approvals` were
    // passed. Inside the try so a re-suspension takes the same path as the
    // original one.
    const resumed = await settleApprovals({
      active,
      state,
      events,
      runId,
      signal,
      maxHandoffs,
      makeGate,
      approvals: options.approvals,
    })

    // An approved transfer must take effect *before* the first turn. Without
    // this the human said yes, the tool result says "transferred to billing",
    // and triage — still holding the conversation — answers the question it
    // just delegated.
    if (resumed) {
      active = await applyHandoff({
        accepted: resumed,
        active,
        state,
        resolveAgent,
        events,
        runId,
        turn: 0,
      })
    }

    let stopReason: StopReason = 'max_turns'

    while (state.turns < maxTurns) {
      throwIfAborted(signal)

      const turn = state.currentTurn
      const turnStartedAt = Date.now()
      const acting = active
      const system = systemOf(acting, output)

      const request: ModelRequest = {
        messages: state.view,
        ...(system ? { system } : {}),
        ...(acting.toolDefinitions ? { tools: acting.toolDefinitions } : {}),
        ...(acting.toolChoice !== undefined ? { toolChoice: acting.toolChoice } : {}),
        ...(output ? { responseFormat: output.responseFormat } : {}),
        ...(acting.config.maxOutputTokens !== undefined
          ? { maxOutputTokens: acting.config.maxOutputTokens }
          : {}),
        ...(acting.config.temperature !== undefined
          ? { temperature: acting.config.temperature }
          : {}),
        ...(acting.metadata ? { metadata: acting.metadata } : {}),
      }

      events.emit({
        type: 'model.request',
        runId,
        agentName: acting.name,
        turn,
        modelId: acting.config.model.modelId,
        messageCount: state.viewCount,
        tools: acting.toolDefinitions ?? [],
      })

      const modelStartedAt = Date.now()
      const outcome = await callModel({
        providers: acting.providers,
        request,
        signal,
        timeoutMs: acting.modelTimeoutMs,
        retry: acting.retryPolicy,
        streaming: internals.streaming,
        onTextDelta: (delta) => {
          emitTextDelta(turn, delta)
        },
        onRetry: (info) => {
          events.emit({
            type: 'model.retry',
            runId,
            agentName: acting.name,
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
            agentName: acting.name,
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
        agentName: acting.name,
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
          agentName: acting.name,
          turn,
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          input: call.input,
        })
      }

      const gate = makeGate(acting, turn)
      const executed = await executeToolCalls(toolCalls, {
        registry: acting.registry,
        runId,
        agentName: acting.name,
        turn,
        defaultTimeoutMs: acting.toolTimeoutMs,
        signal,
        ...(gate ? { gate } : {}),
      })

      // Decided *before* the results are emitted and appended, so a refused
      // transfer is reported once — as the tool result the model actually
      // receives — rather than as a success the trace then contradicts. The
      // transfer tool has no side effect, so deciding after it "ran" costs
      // nothing and keeps the limit checks out of tool execution.
      const decided = decideHandoff({ active: acting, state, maxHandoffs, outcomes: executed })
      const outcomes = decided.outcomes

      for (const outcome of outcomes) {
        events.emit({
          type: 'tool.end',
          runId,
          agentName: acting.name,
          turn,
          toolName: outcome.result.toolName,
          toolCallId: outcome.result.toolCallId,
          result: outcome.result,
          isError: outcome.result.isError === true,
          durationMs: outcome.durationMs,
        })
      }

      for (const refusal of decided.refused) {
        events.emit({
          type: 'handoff.refused',
          runId,
          agentName: acting.name,
          turn,
          from: acting.name,
          to: refusal.to,
          toolName: refusal.toolName,
          toolCallId: refusal.toolCallId,
          cause: refusal.cause,
          reason: refusal.reason,
        })
      }

      const results: ToolResultPart[] = outcomes.map((outcome) => outcome.result)
      state.append(toolMessage(results))

      // Recorded against the agent that made the calls, which is still the
      // acting one — the switch below is what changes that.
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

      if (acting.onToolError === 'throw') {
        const failure = outcomes.find((outcome) => outcome.error !== undefined)
        if (failure?.error) throw failure.error
      }

      // Last thing in the turn: the conversation and the step belong to the
      // agent that just acted, and everything from the next iteration on belongs
      // to the one taking over.
      if (decided.accepted) {
        active = await applyHandoff({
          accepted: decided.accepted,
          active: acting,
          state,
          resolveAgent,
          events,
          runId,
          turn,
        })
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
          active,
          events,
          runId,
          signal,
        })
      : undefined

    // Checked against the answer the caller is about to receive — the validated
    // object when there is an `outputSchema`, the text otherwise.
    //
    // **This must stay above the session save too**, for the same reason
    // `finalizeOutput` does: a rejected answer must not be persisted, and the
    // ordering is the only thing enforcing that.
    const guarded = await guardOutput({
      config,
      state,
      events,
      runId,
      signal,
      validated,
    })

    // Only a completed run is persisted, and only the messages it produced.
    //
    // A run that threw mid-turn can leave an assistant message holding tool
    // calls whose results never arrived; every provider rejects that on the next
    // request, so saving it would poison the session rather than preserve it.
    // `max_turns` is a completion — the conversation is valid, just unfinished.
    if (session) {
      const savedAt = Date.now()
      // `state.messages`, never `state.view`: a handoff `filter` narrows what a
      // specialist is *shown*, and letting it narrow what is *stored* would make
      // delegation a way to delete a user's history.
      const produced = state.messages.slice(history.length)
      await session.store.append(session.sessionId, produced)
      events.emit({
        type: 'session.save',
        runId,
        agentName: state.activeAgentName,
        sessionId: session.sessionId,
        appendedCount: produced.length,
        durationMs: Date.now() - savedAt,
      })
    }

    const result = buildResult<TOutput>(state, stopReason, systemOf(active, output), guarded)

    events.emit({
      type: 'run.finish',
      runId,
      agentName: result.agentName,
      stopReason,
      text: result.text,
      turns: result.turns,
      usage: result.usage,
      durationMs: result.durationMs,
      agentPath: result.agentPath,
    })

    return result
  } catch (cause) {
    // A suspension arrives here because `executeToolCalls` throws rather than
    // returning: it is not an outcome for one call, it cancels the whole turn.
    // Converting it here rather than at the throw site is what lets it carry the
    // conversation, which only this scope has.
    //
    // It rides the normal error path on purpose. Nothing is persisted (the save
    // is above), and "a run that does not return ends with `run.error`" stays
    // true for every SSE consumer and for `resumable.ts`.
    const error =
      cause instanceof ApprovalPending
        ? suspend({
            cause,
            state,
            events,
            runId,
            session,
            system: systemOf(active, output),
            historyLength: history.length,
          })
        : toAgentError(cause)

    events.emit({
      type: 'run.error',
      runId,
      agentName: state.activeAgentName,
      error,
      turn: state.currentTurn,
    })

    throw error
  } finally {
    dispose()
  }
}

/* ------------------------------------------------------------------------- */
/* The acting agent                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Everything the loop needs from whichever agent is currently holding the
 * conversation.
 *
 * Before handoffs these were a dozen `const`s above the loop. They are grouped
 * here for one reason: after a handoff they all change together, and a loop that
 * reads nine variables which must be swapped in lockstep is a loop with nine
 * chances to swap eight of them.
 *
 * @internal
 */
interface ActiveAgent {
  readonly config: AgentConfig<unknown>
  readonly name: string
  /** The agent's own tools **plus** a `transfer_to_*` tool per handoff target. */
  readonly registry: ToolRegistry
  readonly toolDefinitions: readonly ToolDefinition[] | undefined
  /** The developer's prompt alone. The schema instruction is added per request. */
  readonly instructions: string | undefined
  readonly providers: readonly ModelProvider[]
  /** Transfer tool name → target. Empty for an agent with no handoffs. */
  readonly handoffs: ReadonlyMap<string, ResolvedHandoff>
  readonly toolChoice: ToolChoice | undefined
  readonly metadata: Readonly<Record<string, string>> | undefined
  readonly modelTimeoutMs: number
  readonly toolTimeoutMs: number
  readonly onToolError: 'return' | 'throw'
  readonly retryPolicy: ResolvedRetryPolicy
}

type AgentResolver = (config: AgentConfig<unknown>) => Promise<ActiveAgent>

/**
 * Builds the per-run, memoized resolver.
 *
 * Memoized on the config object, so an agent reached twice in one run — legal,
 * as long as it is not a cycle — resolves once. Lazy, so the cost of a handoff
 * target (an instructions thunk, a JSON Schema conversion, possibly a dynamic
 * `import`) is paid only if the run actually gets there.
 *
 * Run options are folded in here rather than at the call site: `maxRetries`,
 * `toolChoice`, and `metadata` are per *run*, so they apply to every agent the
 * run passes through, not just the one it started with.
 */
function createAgentResolver(options: RunOptions): AgentResolver {
  const cache = new Map<AgentConfig<unknown>, Promise<ActiveAgent>>()

  const build = async (config: AgentConfig<unknown>): Promise<ActiveAgent> => {
    const handoffs = resolveHandoffs(config.handoffs, {
      name: config.name,
      toolNames: (config.tools ?? []).map((t) => t.name),
    })

    const registry = new ToolRegistry(resolveAgentTools(config, handoffs))

    return {
      config,
      name: config.name,
      registry,
      toolDefinitions: await registry.definitions(),
      instructions: await resolveInstructions(config),
      // Rebuilt from the primary at the start of every turn, so a transient
      // outage cannot permanently demote the preferred model.
      providers: [config.model, ...(config.fallbacks ?? [])],
      handoffs,
      toolChoice: options.toolChoice ?? config.toolChoice,
      metadata: mergeMetadata(config, options),
      modelTimeoutMs: config.modelTimeoutMs ?? AGENT_DEFAULTS.modelTimeoutMs,
      toolTimeoutMs: config.toolTimeoutMs ?? AGENT_DEFAULTS.toolTimeoutMs,
      onToolError: config.onToolError ?? AGENT_DEFAULTS.onToolError,
      retryPolicy: resolveRetryPolicy(config, options),
    }
  }

  return (config) => {
    const cached = cache.get(config)
    if (cached) return cached

    const pending = build(config)
    cache.set(config, pending)
    return pending
  }
}

/**
 * The system prompt in force: the acting agent's own, plus the run's schema
 * instruction when there is one.
 *
 * The instruction is layered on rather than merged into the request so that
 * `result.messages` carries exactly what the model saw. It follows the *acting*
 * agent across a handoff because the schema is the run's contract — a specialist
 * that inherits the obligation to produce a `Ticket` has to be told the shape.
 */
function systemOf(active: ActiveAgent, output: ResolvedOutput | undefined): string | undefined {
  return output ? joinInstructions(active.instructions, output.instruction) : active.instructions
}

/* ------------------------------------------------------------------------- */
/* Handoffs                                                                  */
/* ------------------------------------------------------------------------- */

/** A transfer that passed every limit and is about to happen. */
interface AcceptedHandoff {
  readonly resolved: ResolvedHandoff
  /** The call that asked for it, so the trace can be correlated to the turn. */
  readonly toolCallId: string
  /** What the model said when it called the transfer tool, if anything. */
  readonly reason: string | undefined
}

interface RefusedHandoff {
  readonly to: string
  readonly toolName: string
  readonly toolCallId: string
  readonly cause: HandoffRefusal
  readonly reason: string
}

/**
 * Decides what a turn's transfer calls are allowed to do.
 *
 * Three limits, and **none of them ends the run.** A refusal becomes an error
 * result the model reads — "you cannot transfer, answer this yourself" — which
 * is why handoffs added no `StopReason` and did not touch invariants 1 or 2. A
 * model that ignores the refusal and keeps trying is bounded by `maxTurns`,
 * which is shared across the whole chain because there is only ever one run.
 *
 * The refusal deliberately carries **no `error`** on the outcome, mirroring
 * `blockedBy`: the runner throws on any `outcome.error` under
 * `onToolError: 'throw'`, and a routing policy is not a tool failure.
 */
function decideHandoff(args: {
  active: ActiveAgent
  state: RunState
  maxHandoffs: number
  outcomes: readonly ToolCallOutcome[]
}): {
  outcomes: readonly ToolCallOutcome[]
  accepted: AcceptedHandoff | undefined
  refused: readonly RefusedHandoff[]
} {
  const { active, state, maxHandoffs, outcomes } = args

  if (active.handoffs.size === 0) return { outcomes, accepted: undefined, refused: [] }

  let accepted: AcceptedHandoff | undefined
  const refused: RefusedHandoff[] = []

  const rewritten = outcomes.map((outcome) => {
    const resolved = active.handoffs.get(outcome.result.toolName)
    if (!resolved) return outcome

    // A transfer a guardrail rejected, or one that failed on its way through
    // tool execution, never happened. Leave the outcome exactly as it is.
    if (outcome.result.isError === true || outcome.blockedBy) return outcome

    const to = resolved.config.name
    const call = { toolCallId: outcome.result.toolCallId, toolName: outcome.result.toolName }

    const refuse = (cause: HandoffRefusal, reason: string): ToolCallOutcome => {
      refused.push({ to, ...call, cause, reason })
      return { ...outcome, result: refusalResult(call, reason) }
    }

    // The model emitted two transfers in one turn. It cannot have both, and
    // picking the first is the only choice that does not depend on which
    // promise settled first.
    if (accepted) {
      return refuse(
        'already_transferring',
        `This conversation is already being transferred to "${accepted.resolved.config.name}". ` +
          'Only one transfer can happen per turn.',
      )
    }

    if (state.handoffCount >= maxHandoffs) {
      return refuse(
        'max_handoffs',
        `This conversation has already been transferred ${state.handoffCount} times, which is the limit. ` +
          'Answer the user directly with the information you have.',
      )
    }

    // A → B → A. The second A would see the same conversation that made it hand
    // off in the first place, so following it is how a routing graph becomes an
    // infinite loop that bills by the token.
    if (state.hasVisited(to)) {
      return refuse(
        'cycle',
        `"${to}" has already handled this conversation (${state.agentPath.join(' → ')}), so transferring back would loop. ` +
          'Answer the user directly, or transfer to a different agent.',
      )
    }

    accepted = {
      resolved,
      toolCallId: outcome.result.toolCallId,
      reason: reasonOf(outcome.result.output),
    }
    return outcome
  })

  return { outcomes: rewritten, accepted, refused }
}

/**
 * Performs an accepted transfer and returns the agent now holding the run.
 *
 * Called at the very end of a turn, after the tool results are appended and the
 * step is recorded — so the conversation and the trace attribute the transfer to
 * the agent that asked for it, and everything after belongs to the one taking
 * over.
 */
async function applyHandoff(args: {
  accepted: AcceptedHandoff
  active: ActiveAgent
  state: RunState
  resolveAgent: AgentResolver
  events: EventEmitter
  runId: string
  turn: number
}): Promise<ActiveAgent> {
  const { accepted, active, state, resolveAgent, events, runId, turn } = args
  const { resolved, reason } = accepted

  const next = await resolveAgent(resolved.config)

  // Applied to the full log, then repaired: a developer's slice can easily
  // orphan a tool result or leave a tool call unanswered, and either shape is a
  // 400 at every provider. Repairing beats throwing — a filter is a hint about
  // what the specialist needs, not a place to learn the message rules.
  const carried = resolved.filter ? repairPairing(resolved.filter(state.messages)) : undefined

  state.switchAgent(next.name, carried)

  // Appended *after* the switch so it lands in both logs, and as a `user`
  // message so it survives a filter that dropped the transfer itself. A
  // specialist that cannot see why it was called is a specialist guessing.
  const note = briefing({ from: active.name, resolved, reason })
  if (note) state.append(userMessage(note))

  events.emit({
    type: 'handoff.start',
    runId,
    // The transition belongs to the agent giving the conversation up; every
    // event after this one carries the receiver's name.
    agentName: active.name,
    turn,
    from: active.name,
    to: next.name,
    toolName: resolved.toolName,
    toolCallId: accepted.toolCallId,
    ...(reason !== undefined ? { reason } : {}),
    carriedCount: state.viewCount,
  })

  return next
}

/** The `reason` the transfer tool echoed back, if the model supplied one. */
function reasonOf(output: unknown): string | undefined {
  if (typeof output !== 'object' || output === null) return undefined
  const reason = (output as { reason?: unknown }).reason
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined
}

/* ------------------------------------------------------------------------- */
/* Guardrails                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Runs the input guardrails and returns this run's new messages.
 *
 * With no guardrails configured this is `normalizeInput(input)` and nothing
 * else — the same value the constructor used to receive inline.
 *
 * A `replace` collapses the turn to a single user message. When the input
 * arrived as a message array that loses its structure, which is documented and
 * rare: rewriting is for scrubbing and clamping text, and a guardrail that needs
 * finer control over a multi-message turn should reject and let the caller
 * rebuild it.
 */
async function guardInput(args: {
  config: AgentConfig<unknown>
  events: EventEmitter
  runId: string
  signal: AbortSignal
  history: readonly ModelMessage[]
  input: AgentInput
}): Promise<readonly ModelMessage[]> {
  const { config, events, runId, signal, history, input } = args
  const guardrails = config.inputGuardrails
  const messages = normalizeInput(input)

  if (!guardrails || guardrails.length === 0) return messages

  const original = typeof input === 'string' ? input : messagesText(messages)

  const guarded = await applyInputGuardrails({
    guardrails,
    input: original,
    context: {
      runId,
      agentName: config.name,
      turn: 1,
      messages: [...history, ...messages],
      signal,
    },
    reporter: { events, runId, agentName: config.name, turn: 1 },
  })

  return guarded === original ? messages : [userMessage(guarded)]
}

/**
 * Builds the {@link ToolGate} for one turn of one agent, or `undefined` when
 * that agent has nothing to gate.
 *
 * Per agent as well as per turn, because after a handoff the guardrails in force
 * are the receiving agent's. That is also what makes a **transfer** gateable
 * with no special case: the `transfer_to_*` tool is registered on the routing
 * agent, so the routing agent's `toolGuardrails` see it exactly like any other
 * call, and `requireApproval` on it puts a human in front of the delegation.
 *
 * `undefined` for an agent with no tool guardrails is what keeps
 * `executeToolCalls` on exactly the path it took before guardrails existed.
 */
function buildGateFactory(args: {
  state: RunState
  events: EventEmitter
  runId: string
  signal: AbortSignal
}): (active: ActiveAgent, turn: number) => ToolGate | undefined {
  const { state, events, runId, signal } = args

  return (active: ActiveAgent, turn: number) => {
    const guardrails = active.config.toolGuardrails
    if (!guardrails || guardrails.length === 0) return undefined

    return {
      guardrails,
      context: {
        runId,
        agentName: active.name,
        turn,
        // The full conversation, not the narrowed view: a guardrail deciding
        // whether an action is safe must see everything that happened, even the
        // part a handoff filter hid from the model.
        messages: state.messages,
        signal,
      },
      onTriggered: (event) => {
        events.emit({
          type: 'guardrail.triggered',
          runId,
          agentName: active.name,
          turn,
          stage: 'tool',
          guardrail: event.guardrail,
          action: event.action,
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
        })
      },
    }
  }
}

/**
 * Settles tool calls that a suspended run left outstanding, before the loop
 * starts.
 *
 * A resumed run is just "a run whose first turn's tools already happened", and
 * this is what makes that true. The conversation handed back by a suspension
 * ends with an assistant tool-call turn whose results never arrived — a shape
 * every provider rejects — so it has to be completed before a model call can be
 * made against it.
 *
 * The guardrails are **re-run**, not trusted. An `approved: true` decision can
 * only satisfy a `requireApproval`; a guardrail that would reject the call
 * outright still rejects it. And only this function reads `options.approvals` —
 * the in-loop gate never does, which is what makes an approval authorise one
 * call once rather than becoming standing permission for the rest of the run.
 *
 * Returns the transfer to perform when the approved call was a **handoff**. It
 * is returned rather than applied here so that both this prologue and the loop
 * take the same code path into {@link applyHandoff}.
 */
async function settleApprovals(args: {
  active: ActiveAgent
  state: RunState
  events: EventEmitter
  runId: string
  signal: AbortSignal
  maxHandoffs: number
  makeGate: (active: ActiveAgent, turn: number) => ToolGate | undefined
  approvals: readonly ApprovalDecision[] | undefined
}): Promise<AcceptedHandoff | undefined> {
  const { active, state, events, runId, signal, maxHandoffs, makeGate, approvals } = args
  const config = active.config
  const registry = active.registry

  const outstanding = outstandingToolCalls(state.messages)
  if (outstanding.length === 0) return undefined

  const decisions = new Map((approvals ?? []).map((decision) => [decision.toolCallId, decision]))

  // A decision naming a call that is not outstanding is a bug in the caller's
  // plumbing, not a request to ignore. Silently dropping it would re-suspend
  // with nothing to explain why.
  const known = new Set(outstanding.map((call) => call.toolCallId))
  for (const id of decisions.keys()) {
    if (known.has(id)) continue
    throw new ConfigurationError(`No pending tool call with id "${id}".`, {
      hint:
        `Outstanding ids for this suspension: ${[...known].join(', ') || '(none)'}. ` +
        'Pass the ids from `suspension.pending.calls`, unmodified.',
      details: { toolCallId: id, expected: [...known] },
    })
  }

  const startedAt = Date.now()
  const denied: ToolResultPart[] = []
  const approvedIds = new Set<string>()

  for (const call of outstanding) {
    const decision = decisions.get(call.toolCallId)
    if (!decision) continue

    events.emit({
      type: 'approval.resolved',
      runId,
      agentName: config.name,
      turn: 0,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      approved: decision.approved,
      ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    })

    if (decision.approved) {
      approvedIds.add(call.toolCallId)
      continue
    }

    denied.push({
      type: 'tool-result',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      isError: true,
      output: {
        error: decision.reason ?? 'A human declined this action.',
        code: 'approval_denied',
      },
    })
  }

  // Everything not explicitly denied goes through the ordinary path, guardrails
  // included. Three things fall out of that for free:
  //
  //   • a call no guardrail ever gated just runs — it never needed a decision;
  //   • an approval satisfies `requireApproval` but cannot bypass a `reject`,
  //     because only the former is downgraded;
  //   • a gated call with no decision makes `executeToolCalls` throw
  //     `ApprovalPending` exactly as it did the first time, so the run
  //     re-suspends naming precisely the calls still outstanding.
  const deniedIds = new Set(denied.map((result) => result.toolCallId))
  const attempt = outstanding.filter((call) => !deniedIds.has(call.toolCallId))

  const gate = makeGate(active, 0)
  const executed =
    attempt.length > 0
      ? await executeToolCalls(attempt, {
          registry,
          runId,
          agentName: config.name,
          turn: 0,
          defaultTimeoutMs: active.toolTimeoutMs,
          signal,
          ...(gate ? { gate: approvedGate(gate, approvedIds) } : {}),
        })
      : []

  // The same limits the loop applies, applied to a transfer a human approved.
  // An approval says "yes, delegate this" — it does not say "and ignore the
  // cycle you were about to make".
  //
  // The depth counter is necessarily 0 here: a suspension carries messages, not
  // counters, so a resumed run starts its budget over. That is a property of
  // stateless approval rather than an oversight — see the docs.
  const decided = decideHandoff({ active, state, maxHandoffs, outcomes: executed })
  const outcomes = decided.outcomes

  for (const outcome of outcomes) {
    events.emit({
      type: 'tool.end',
      runId,
      agentName: config.name,
      turn: 0,
      toolName: outcome.result.toolName,
      toolCallId: outcome.result.toolCallId,
      result: outcome.result,
      isError: outcome.result.isError === true,
      durationMs: outcome.durationMs,
    })
  }

  for (const refusal of decided.refused) {
    events.emit({
      type: 'handoff.refused',
      runId,
      agentName: config.name,
      turn: 0,
      from: config.name,
      to: refusal.to,
      toolName: refusal.toolName,
      toolCallId: refusal.toolCallId,
      cause: refusal.cause,
      reason: refusal.reason,
    })
  }

  // Results are appended in the original call order, so the conversation matches
  // the order the model asked in.
  const byId = new Map(outcomes.map((outcome) => [outcome.result.toolCallId, outcome.result]))
  const ordered = outstanding.map(
    (call) => byId.get(call.toolCallId) ?? denied.find((r) => r.toolCallId === call.toolCallId),
  )

  state.append(toolMessage(ordered.filter((r): r is ToolResultPart => r !== undefined)))

  state.completeResume({
    turn: 0,
    text: '',
    toolCalls: outstanding,
    toolResults: ordered.filter((r): r is ToolResultPart => r !== undefined),
    finishReason: 'tool_calls',
    usage: ZERO_USAGE,
    durationMs: Date.now() - startedAt,
    modelId: state.modelId,
  })

  return decided.accepted
}

/**
 * A gate that honours the decisions a human already made.
 *
 * `requireApproval` is downgraded to `allow` **only for the ids in
 * `approvedIds`** — otherwise a guardrail would ask for the same call again and
 * the run would suspend forever. Every other verdict is left alone, which is
 * what makes an approval unable to override an outright `reject`, and is the
 * whole reason the guardrails are re-run rather than trusted.
 */
function approvedGate(gate: ToolGate, approvedIds: ReadonlySet<string>): ToolGate {
  return {
    ...gate,
    guardrails: gate.guardrails.map((guardrail) => ({
      ...guardrail,
      check: async (subject, context) => {
        const verdict = await guardrail.check(subject, context)
        if ('requireApproval' in verdict && approvedIds.has(subject.toolCallId)) {
          return { allow: true }
        }
        return verdict
      },
    })),
  }
}

/**
 * Tool calls on the trailing assistant message that have no matching result.
 *
 * This is how a resumed run finds what it is resuming: the shape is unambiguous
 * because a conversation is only ever left this way by a suspension.
 */
function outstandingToolCalls(messages: readonly ModelMessage[]): readonly ToolCallPart[] {
  const last = messages.at(-1)
  if (last?.role !== 'assistant') return []

  const calls = last.content.filter((part): part is ToolCallPart => part.type === 'tool-call')
  return calls
}

/**
 * Turns an internal {@link ApprovalPending} into the public error, capturing
 * everything a resume will need.
 *
 * Emits `approval.required` on the way through, so a UI watching the event
 * stream can render the prompt without waiting for the promise to reject.
 */
function suspend(args: {
  cause: ApprovalPending
  state: RunState
  events: EventEmitter
  runId: string
  session: ResolvedSession | undefined
  system: string | undefined
  historyLength: number
}): ApprovalRequiredError {
  const { cause, state, events, runId, session, system, historyLength } = args
  const turn = state.currentTurn
  const agentName = state.activeAgentName

  events.emit({
    type: 'approval.required',
    runId,
    agentName,
    turn,
    calls: cause.calls,
  })

  // The system message is prepended for the same reason `buildResult` does it:
  // handing `messages` back to `run()` must reproduce the same conversation.
  const messages: ModelMessage[] = system
    ? [{ role: 'system', content: system }, ...state.messages]
    : [...state.messages]

  return new ApprovalRequiredError({
    runId,
    agentName,
    messages,
    produced: state.messages.slice(historyLength),
    ...(session ? { sessionId: session.sessionId } : {}),
    pending: { turn, calls: cause.calls },
  })
}

/** Flattens a multi-message turn so a text guardrail has something to inspect. */
function messagesText(messages: readonly ModelMessage[]): string {
  return messages.map((message) => messageText(message)).join('\n')
}

/**
 * Runs the output guardrails against the answer, and applies any rewrite to the
 * transcript as well as to the result.
 *
 * Returns the box `buildResult` consumes. With no `outputSchema` the subject is
 * the raw text and a rewrite replaces it; with one, the subject is the validated
 * object and a rewrite is re-serialized so `result.text` and `result.messages`
 * stay consistent with `result.output`.
 */
async function guardOutput(args: {
  config: AgentConfig<unknown>
  state: RunState
  events: EventEmitter
  runId: string
  signal: AbortSignal
  validated: ValidatedOutput | undefined
}): Promise<ValidatedOutput | undefined> {
  const { config, state, events, runId, signal, validated } = args

  // The **initiating** agent's guardrails, not the acting one's. An output
  // guardrail is a promise to the caller about what leaves the run — a
  // specialist reached by a handoff cannot be the one who decides whether the
  // answer is allowed out, or delegation would be a way around the policy.
  const guardrails = config.outputGuardrails
  if (!guardrails || guardrails.length === 0) return validated

  const text = state.finalText()
  const turn = state.turns
  const agentName = state.activeAgentName

  const { value, replaced } = await applyOutputGuardrails<unknown>({
    // The runner only ever knows `unknown` here; it never inspects the value,
    // it hands it to the caller's own guardrail and stores whatever comes back.
    guardrails,
    output: validated ? validated.value : text,
    context: {
      runId,
      agentName,
      turn,
      messages: state.messages,
      signal,
      text,
    },
    reporter: { events, runId, agentName, turn },
  })

  if (!replaced) return validated

  state.replaceFinalText(validated ? safeStringify(value) : String(value))
  return { value }
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
  /** Whichever agent produced the answer — it is also the one asked to fix it. */
  active: ActiveAgent
  events: EventEmitter
  runId: string
  signal: AbortSignal
}): Promise<ValidatedOutput> {
  const { output, state, events, runId, signal } = args
  const agentName = state.activeAgentName

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
      agentName,
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
  active: ActiveAgent
  events: EventEmitter
  runId: string
  signal: AbortSignal
  output: ResolvedOutput
  turn: number
  issues: readonly SchemaIssue[]
}): Promise<string> {
  const { state, active, events, runId, signal, output, turn, issues } = args
  const config = active.config
  const agentName = state.activeAgentName
  const system = systemOf(active, output)

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
    // The view, like every other request: a repair after a handoff must not
    // hand the specialist back the history its `filter` deliberately removed.
    messages: state.view,
    ...(system ? { system } : {}),
    responseFormat: output.responseFormat,
    ...(config.maxOutputTokens !== undefined ? { maxOutputTokens: config.maxOutputTokens } : {}),
    ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
    ...(active.metadata ? { metadata: active.metadata } : {}),
  }

  events.emit({
    type: 'model.request',
    runId,
    agentName,
    turn,
    modelId: config.model.modelId,
    messageCount: state.viewCount,
    tools: [],
  })

  const outcome = await callModel({
    providers: active.providers,
    request,
    signal,
    timeoutMs: active.modelTimeoutMs,
    retry: active.retryPolicy,
    // A repair answer is a JSON object that is withheld from `text.delta`
    // anyway, so streaming it would buy nothing but a second code path.
    streaming: false,
    onTextDelta: () => {},
    onRetry: (info) => {
      events.emit({
        type: 'model.retry',
        runId,
        agentName,
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
        agentName,
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
    agentName,
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
    // The agent that *answered*, which after a handoff is not the one the caller
    // invoked. `agentPath` is how you see both.
    agentName: state.activeAgentName,
    agentPath: state.agentPath,
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
