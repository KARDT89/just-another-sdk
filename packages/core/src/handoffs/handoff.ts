import { ConfigurationError } from '../errors/errors.js'
import { tool, type AnyTool } from '../tools/tool.js'
import type { ObjectJsonSchema } from '../types/json-schema.js'
import type { ModelMessage, ToolResultPart } from '../types/messages.js'
import type { AgentConfig } from '../agent/types.js'
import type { AgentLike, HandoffSpec, HandoffTarget, ResolvedHandoff } from './types.js'

/**
 * A handoff is a **tool**.
 *
 * That is not an implementation shortcut, it is the design. From the model's
 * point of view transferring the conversation *is* a capability it chooses to
 * invoke, and from the runtime's point of view it means a transfer travels the
 * path that already exists: it is validated, it is subject to the acting agent's
 * tool guardrails, it can be gated behind human approval, it times out, and it
 * shows up in a trace — none of which needed a line of new code.
 *
 * The synthesized tool has **no side effect**. It returns a marker and nothing
 * else, which is what lets the runner execute it and *then* decide whether the
 * transfer is allowed: refusing after the fact costs nothing, so the limit
 * checks do not have to be threaded into tool execution.
 */

/**
 * Resolves an agent's `handoffs` into a name-indexed map.
 *
 * Duplicate tool names are rejected here rather than at first run, for the same
 * reason `ToolRegistry` rejects duplicate tools: the developer wrote the mistake
 * at construction time and that is where they should read about it.
 *
 * `parentTools` is the acting agent's own tool names — a transfer tool that
 * shadows a real tool would silently replace it in the registry, so it is a
 * construction error too.
 */
export function resolveHandoffs(
  targets: readonly HandoffTarget[] | undefined,
  parent: { readonly name: string; readonly toolNames: readonly string[] },
): ReadonlyMap<string, ResolvedHandoff> {
  const resolved = new Map<string, ResolvedHandoff>()
  if (!targets || targets.length === 0) return resolved

  const ownTools = new Set(parent.toolNames)

  for (const target of targets) {
    const spec = toSpec(target)
    const config = toConfig(spec.agent, parent.name)

    if (!config.name || config.name.trim().length === 0) {
      throw new ConfigurationError(`A handoff target of agent "${parent.name}" has no name.`, {
        hint: 'Every agent needs a name — it is what the transfer tool is named after.',
      })
    }

    if (!config.model || typeof config.model.generate !== 'function') {
      throw new ConfigurationError(
        `Handoff target "${config.name}" of agent "${parent.name}" has no valid model.`,
        {
          hint:
            'A handoff target runs the rest of the conversation, so it needs its own model. ' +
            "Pass one, e.g. model: openrouter('anthropic/claude-opus-5').",
          details: { agent: parent.name, target: config.name },
        },
      )
    }

    const toolName = spec.toolName ?? defaultToolName(config.name)

    if (ownTools.has(toolName)) {
      throw new ConfigurationError(
        `The handoff to "${config.name}" would be named "${toolName}", which is already a tool on agent "${parent.name}".`,
        {
          hint: 'Set `toolName` on the handoff, or rename the tool.',
          details: { agent: parent.name, target: config.name, toolName },
        },
      )
    }

    const clash = resolved.get(toolName)
    if (clash) {
      throw new ConfigurationError(
        `Agent "${parent.name}" has two handoffs both named "${toolName}".`,
        {
          hint:
            `"${clash.config.name}" and "${config.name}" resolve to the same transfer tool. ` +
            'Set `toolName` on one of them.',
          details: { agent: parent.name, toolName },
        },
      )
    }

    resolved.set(toolName, {
      toolName,
      config,
      ...(spec.filter ? { filter: spec.filter } : {}),
      ...(spec.describe !== undefined ? { describe: spec.describe } : {}),
      ...(spec.description !== undefined ? { description: spec.description } : {}),
    })
  }

  return resolved
}

/**
 * The tools an agent's handoffs contribute to its registry.
 *
 * Built fresh per resolution rather than memoized on the target: the same agent
 * can be a handoff target of several parents with different `describe` text, and
 * a shared tool object would leak one parent's briefing into another's prompt.
 */
export function handoffTools(handoffs: ReadonlyMap<string, ResolvedHandoff>): readonly AnyTool[] {
  return [...handoffs.values()].map((resolved) => handoffTool(resolved))
}

/**
 * One transfer tool.
 *
 * Its parameters are written as raw JSON Schema rather than a validator: the SDK
 * has **zero runtime dependencies**, so it cannot import Zod to describe its own
 * single optional string. `tool()` supports exactly this via `parameters`.
 */
export function handoffTool(resolved: ResolvedHandoff & { description?: string }): AnyTool {
  const target = resolved.config.name

  return tool({
    name: resolved.toolName,
    description: resolved.description ?? describeTarget(resolved),
    parameters: HANDOFF_PARAMETERS,
    execute: (input: unknown) => ({
      transferred_to: target,
      ...(resolved.describe !== undefined ? { note: resolved.describe } : {}),
      ...(reasonOf(input) !== undefined ? { reason: reasonOf(input) } : {}),
    }),
  })
}

const HANDOFF_PARAMETERS: ObjectJsonSchema = Object.freeze<ObjectJsonSchema>({
  type: 'object',
  properties: {
    reason: {
      type: 'string',
      description:
        'Why this conversation is being transferred. The receiving agent reads it, ' +
        'so summarise what the user needs rather than repeating their words.',
    },
  },
  required: [],
  additionalProperties: false,
})

/**
 * What the model reads when deciding whether to transfer.
 *
 * Derived from the target's own instructions when no description is given,
 * because the alternative — "Transfer to billing." — tells the model the name of
 * a door and nothing about the room behind it.
 */
function describeTarget(resolved: ResolvedHandoff): string {
  const summary = resolved.describe ?? firstSentence(instructionsOf(resolved.config))
  const base = `Transfer the conversation to the "${resolved.config.name}" agent, which takes over from here.`
  return summary ? `${base} ${summary}` : base
}

/** Only a literal string is readable at construction time; a thunk is not. */
function instructionsOf(config: AgentConfig<unknown>): string | undefined {
  return typeof config.instructions === 'string' ? config.instructions : undefined
}

function firstSentence(text: string | undefined): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  const stop = trimmed.search(/[.!?](\s|$)/u)
  return stop === -1 ? truncateWords(trimmed) : trimmed.slice(0, stop + 1)
}

function truncateWords(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`
}

function reasonOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const reason = (input as { reason?: unknown }).reason
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : undefined
}

/**
 * `transfer_to_billing_support` from `billing support`.
 *
 * Constrained to what every provider accepts as a tool name, which
 * {@link tool} then re-validates — so a pathological agent name fails with a
 * message about tool names rather than a provider 400.
 */
export function defaultToolName(agentName: string): string {
  const slug = agentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')

  return `transfer_to_${slug || 'agent'}`.slice(0, 64)
}

/* ------------------------------------------------------------------------- */
/* Context transfer                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Makes an arbitrary message array safe to send to a provider.
 *
 * A developer's `filter` can return any subset it likes, and two of those
 * subsets are protocol errors everywhere:
 *
 *   1. a `tool` result whose originating assistant `tool-call` was dropped;
 *   2. a trailing assistant turn holding tool calls whose results were dropped —
 *      the same shape a suspended run leaves behind, which the next model call
 *      rejects.
 *
 * Both are repaired by removal rather than by throwing. A filter is a hint about
 * what the specialist needs, not a place to learn the provider's message rules,
 * and failing a live run over an off-by-one slice would be the wrong trade.
 *
 * The same rule `trimHistory` enforces for its head-slice, generalised.
 */
export function repairPairing(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  const called = new Set<string>()
  const kept: ModelMessage[] = []

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'tool-call') called.add(part.toolCallId)
      }
      kept.push(message)
      continue
    }

    if (message.role !== 'tool') {
      kept.push(message)
      continue
    }

    const answered = message.content.filter((part) => called.has(part.toolCallId))
    if (answered.length > 0) kept.push({ role: 'tool', content: answered })
  }

  return dropUnansweredTail(kept)
}

/**
 * Removes a trailing assistant turn whose tool calls have no results.
 *
 * Runs after the orphan pass because that pass can *create* the condition: drop
 * the results and the calls are suddenly unanswered.
 */
function dropUnansweredTail(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const part of message.content) answered.add(part.toolCallId)
  }

  let end = messages.length
  while (end > 0) {
    const message = messages[end - 1]
    if (message?.role !== 'assistant') break

    const pending = message.content.filter(
      (part): part is Extract<typeof part, { type: 'tool-call' }> =>
        part.type === 'tool-call' && !answered.has(part.toolCallId),
    )
    if (pending.length === 0) break

    // The turn may carry text alongside the unanswered calls. Keep the text —
    // it is what the model said — and drop only the dangling calls.
    const text = message.content.filter((part) => part.type === 'text')
    if (text.length > 0) {
      return [...messages.slice(0, end - 1), { role: 'assistant', content: text }]
    }

    end -= 1
  }

  return end === messages.length ? messages : messages.slice(0, end)
}

/**
 * The briefing the receiving agent starts from.
 *
 * A `user` message rather than a second `system` one: several providers ignore
 * or reject a mid-conversation system message, and a `tool` message would need a
 * `toolCallId` that does not belong to it.
 *
 * Returns `undefined` when there is nothing to say, so the common case appends
 * nothing at all.
 */
export function briefing(args: {
  from: string
  resolved: ResolvedHandoff
  reason: string | undefined
}): string | undefined {
  const { from, resolved, reason } = args
  const parts: string[] = []

  if (resolved.describe) parts.push(resolved.describe)
  if (reason) parts.push(reason)
  if (parts.length === 0) return undefined

  return `[Handed off from "${from}"] ${parts.join(' ')}`
}

/** What the model sees in place of a transfer it was not allowed to make. */
export function refusalResult(
  call: { toolCallId: string; toolName: string },
  reason: string,
): ToolResultPart {
  return {
    type: 'tool-result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    isError: true,
    output: { error: reason, code: 'handoff_refused' },
  }
}

/* ------------------------------------------------------------------------- */
/* Normalisation                                                             */
/* ------------------------------------------------------------------------- */

function toSpec(target: HandoffTarget): HandoffSpec {
  return isSpec(target) ? target : { agent: target }
}

function isSpec(target: HandoffTarget): target is HandoffSpec {
  return typeof target === 'object' && target !== null && 'agent' in target
}

/** Accepts an `Agent` or a bare `AgentConfig`, without importing the class. */
function toConfig(
  agent: AgentLike | AgentConfig<unknown>,
  parentName: string,
): AgentConfig<unknown> {
  if (typeof (agent as AgentLike).toConfig === 'function') {
    return (agent as AgentLike).toConfig()
  }

  const config = agent as AgentConfig<unknown>
  if (typeof config !== 'object' || config === null) {
    throw new ConfigurationError(`A handoff target of agent "${parentName}" is not an agent.`, {
      hint: 'Pass an Agent, an AgentConfig, or { agent, filter?, describe? }.',
    })
  }

  return config
}
