import type { FinishReason } from '../providers/provider.js'
import type { ModelMessage, ToolCallPart, ToolResultPart, Usage } from '../types/messages.js'

/**
 * Why the loop stopped.
 *
 * These are the only two ways a run *returns*. Everything else — cancellation, a
 * provider outage, `onToolError: 'throw'` — rejects the promise with an
 * `AgentError` instead, so a `RunResult` in hand always means the agent produced
 * something. Subscribe with `onEvent` if you need partial state from a run that
 * failed midway.
 */
export type StopReason =
  /** The model produced a final answer with no further tool calls. */
  | 'finish'
  /**
   * `maxTurns` was reached while the model was still calling tools. The last
   * assistant text is still returned, but the task may be unfinished — check
   * this before trusting `output` in an autonomous pipeline.
   */
  | 'max_turns'

/** One model call plus any tool work it triggered. The unit of a trace. */
export interface RunStep {
  /**
   * Why this model call was made.
   * - `'turn'`   — an ordinary loop turn.
   * - `'repair'` — a re-ask after the final answer failed the agent's
   *   `outputSchema`.
   *
   * Repairs are recorded because they cost tokens and can be served by a
   * fallback model, but they are not loop turns: `result.turns` counts `'turn'`
   * steps only, so `maxTurns` stays the ceiling it claims to be. A repair
   * carries the `turn` number of the answer it is repairing, so steps still
   * group by exchange.
   */
  readonly kind: 'turn' | 'repair'
  /** 1-based turn number within the run. */
  readonly turn: number
  /** Text the model produced this turn (may be empty on a pure tool turn). */
  readonly text: string
  readonly toolCalls: readonly ToolCallPart[]
  readonly toolResults: readonly ToolResultPart[]
  readonly finishReason: FinishReason
  readonly usage: Usage
  /** Wall-clock duration of the model call plus tool execution, ms. */
  readonly durationMs: number
  /**
   * The model that actually served this turn. Differs from the agent's
   * configured model when a `fallbacks` entry took over, which is how a fallback
   * becomes visible in a trace after the fact.
   */
  readonly modelId: string
}

/**
 * Everything a caller needs after `run()` resolves.
 *
 * `output` is the answer. Everything else exists so you can debug, bill, trace,
 * or persist the run without re-deriving it.
 */
export interface RunResult<TOutput = string> {
  /** Stable id for this run. Appears in every event and trace line. */
  readonly runId: string
  readonly agentName: string
  /** The final answer — a string, or a parsed object once structured output lands. */
  readonly output: TOutput
  /** Raw final assistant text, always present even for typed output. */
  readonly text: string
  readonly stopReason: StopReason
  /**
   * The full conversation, including the system message, every assistant turn,
   * and every tool result. Feed straight back in to continue the conversation.
   */
  readonly messages: readonly ModelMessage[]
  readonly steps: readonly RunStep[]
  /** Summed across every model call in the run. */
  readonly usage: Usage
  readonly turns: number
  readonly durationMs: number
  /** The model that served the final turn. */
  readonly modelId: string
}

/** True when the run ended cleanly with a model-authored answer. */
export function isComplete(result: RunResult<unknown>): boolean {
  return result.stopReason === 'finish'
}
