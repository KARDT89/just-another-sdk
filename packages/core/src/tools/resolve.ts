import type { AgentConfig } from '../agent/types.js'
import { handoffTools } from '../handoffs/handoff.js'
import type { ResolvedHandoff } from '../handoffs/types.js'
import { PURE_BUILTINS } from './builtin/pure.js'
import type { AnyTool } from './tool.js'

/**
 * The complete tool list for one agent: the developer's own, the built-ins, and
 * one `transfer_to_*` tool per handoff.
 *
 * **One function, called from two places.** `Agent` builds a registry to
 * validate at construction time and the runner builds one per acting agent, and
 * before this existed they assembled the list independently — which is exactly
 * how the set of tools an agent validates against drifts from the set it
 * actually runs.
 */
export function resolveAgentTools(
  config: AgentConfig<unknown>,
  handoffs: ReadonlyMap<string, ResolvedHandoff>,
): readonly AnyTool[] {
  const own = config.tools ?? []
  return [...own, ...builtinsFor(config, own), ...handoffTools(handoffs)]
}

/**
 * The automatic tools, minus any the developer has already claimed the name of.
 *
 * **A developer's own tool always wins, silently.** `ToolRegistry` rejects
 * duplicate names by throwing, so without this filter shipping a new built-in
 * would break — at construction, on upgrade — every agent that already had a
 * tool called `calculate`. Overriding a built-in by defining your own is a
 * feature, not a collision.
 */
function builtinsFor(config: AgentConfig<unknown>, own: readonly AnyTool[]): readonly AnyTool[] {
  if (config.builtins === false) return []

  const claimed = new Set(own.map((t) => t.name))
  return PURE_BUILTINS.filter((builtin) => !claimed.has(builtin.name))
}
