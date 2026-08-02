import type { AgentConfig } from '../agent/types.js'
import type { ModelMessage } from '../types/messages.js'

/**
 * Anything that can receive a handoff: an `Agent` instance, or the bare
 * configuration one is built from.
 *
 * Typed structurally rather than as `Agent` on purpose. `AgentConfig` cannot
 * import the `Agent` class without a cycle, and this file is imported by
 * `agent/types.ts` — so the class is recognised by the one method it exposes
 * rather than by its identity. Duck-typing here is what keeps the module graph
 * acyclic at runtime.
 */
export interface AgentLike {
  toConfig(): Readonly<AgentConfig<unknown>>
}

/**
 * A handoff target with its transfer rules.
 *
 * The bare form — passing the agent itself — means "hand over the whole
 * conversation, describe the target from its own instructions". Everything here
 * is a narrowing of that default.
 */
export interface HandoffSpec {
  /** The agent to transfer to. */
  readonly agent: AgentLike | AgentConfig<unknown>

  /**
   * Narrows what the receiving agent sees.
   *
   * Useful when the specialist should not see everything, or when the
   * transcript is long enough to cost real money:
   *
   * ```ts
   * { agent: billing, filter: (messages) => messages.slice(-4) }
   * ```
   *
   * The filter shapes only what is **sent to the model**. The run's own
   * `messages`, and anything a session persists, stay complete — a handoff must
   * not be able to delete history.
   *
   * A filtered array is repaired before use: a tool result whose originating
   * call was dropped is a protocol error at every provider, so it is dropped
   * too. See {@link repairPairing}.
   */
  readonly filter?: (messages: readonly ModelMessage[]) => readonly ModelMessage[]

  /**
   * A briefing note from the routing agent, handed to the receiving one as a
   * message.
   *
   * It survives a `filter` that drops the transfer itself, which is the point:
   * a specialist that cannot see why it was called is a specialist guessing.
   */
  readonly describe?: string

  /**
   * Overrides the synthesized tool name. Default `transfer_to_<agent name>`,
   * lowercased with non-identifier characters collapsed to `_`.
   *
   * Set it when two agents in the same graph would otherwise collide, or when a
   * name reads badly to the model.
   */
  readonly toolName?: string

  /** Overrides the tool description the model reads when deciding to transfer. */
  readonly description?: string
}

/** An agent, or an agent plus its transfer rules. */
export type HandoffTarget = AgentLike | AgentConfig<unknown> | HandoffSpec

/**
 * A target after resolution: the tool name is settled, and `config` is a plain
 * `AgentConfig` regardless of which form the developer wrote.
 *
 * @internal
 */
export interface ResolvedHandoff {
  readonly toolName: string
  readonly config: AgentConfig<unknown>
  readonly filter?: (messages: readonly ModelMessage[]) => readonly ModelMessage[]
  readonly describe?: string
  readonly description?: string
}

/** Why a transfer was refused. Carried on `handoff.refused`. */
export type HandoffRefusal =
  /** `maxHandoffs` is already spent. */
  | 'max_handoffs'
  /** The target has already acted in this run — A → B → A. */
  | 'cycle'
  /** A transfer in the same turn was accepted first. */
  | 'already_transferring'
