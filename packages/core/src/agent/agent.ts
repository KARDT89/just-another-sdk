import { ConfigurationError } from '../errors/errors.js'
import type { RunResult } from '../run/result.js'
import { runAgent } from '../run/runner.js'
import { ToolRegistry } from '../tools/registry.js'
import type { AnyTool } from '../tools/tool.js'
import type { AgentConfig, AgentInput, RunOptions } from './types.js'

/**
 * An agent: a name, instructions, a model, and some tools.
 *
 * An `Agent` is **immutable configuration**, not a session. It holds no
 * conversation, no counters, and no mutable state, which means a single instance
 * is safe to create once at module scope and share across every concurrent
 * request in your server. Per-run state lives in `RunState`; persisted state will
 * live in `Session`.
 *
 * ```ts
 * import { Agent, tool } from 'just-another-sdk'
 * import { openrouter } from 'just-another-sdk/providers'
 * import * as z from 'zod'
 *
 * const agent = new Agent({
 *   name: 'weather-assistant',
 *   instructions: 'You are concise. Use the tools available to you.',
 *   model: openrouter('anthropic/claude-opus-5'),
 *   tools: [
 *     tool({
 *       name: 'get_weather',
 *       description: 'Get the current weather for a city.',
 *       inputSchema: z.object({ city: z.string() }),
 *       execute: async ({ city }) => ({ tempC: 18, summary: 'clear' }),
 *     }),
 *   ],
 * })
 *
 * const result = await agent.run('What is it like in Paris?')
 * console.log(result.output)
 * ```
 */
export class Agent {
  readonly name: string
  private readonly config: AgentConfig
  private readonly registry: ToolRegistry

  constructor(config: AgentConfig) {
    if (!config.name || config.name.trim().length === 0) {
      throw new ConfigurationError('An agent needs a name.', {
        hint: 'The name identifies the agent in events, traces, and handoffs.',
      })
    }

    if (!config.model || typeof config.model.generate !== 'function') {
      throw new ConfigurationError(`Agent "${config.name}" has no valid model.`, {
        hint:
          "Pass a provider, e.g. model: openrouter('anthropic/claude-opus-5') " +
          "imported from 'just-another-sdk/providers'.",
      })
    }

    if (config.maxTurns !== undefined && config.maxTurns < 1) {
      throw new ConfigurationError(`maxTurns must be at least 1, got ${config.maxTurns}.`, {
        details: { maxTurns: config.maxTurns },
      })
    }

    // Constructing the registry here surfaces duplicate tool names immediately,
    // at the point the developer wrote the mistake, rather than on first run.
    this.registry = new ToolRegistry(config.tools)
    this.config = config
    this.name = config.name
  }

  /** The model bound to this agent. */
  get modelId(): string {
    return this.config.model.modelId
  }

  /** Registered tool names, in declaration order. */
  get toolNames(): readonly string[] {
    return this.registry.names()
  }

  /**
   * Runs the agent to completion and resolves with the final result.
   *
   * Resolves when the model produces an answer or `maxTurns` is hit; rejects with
   * an `AgentError` on cancellation, a provider failure, or a tool failure under
   * `onToolError: 'throw'`.
   *
   * Continue a conversation by passing the previous messages back:
   *
   * ```ts
   * const first = await agent.run('My name is Ada.')
   * const second = await agent.run('What is my name?', { messages: first.messages })
   * ```
   */
  async run<TOutput = string>(
    input: AgentInput,
    options: RunOptions = {},
  ): Promise<RunResult<TOutput>> {
    return runAgent<TOutput>(this.config, input, options)
  }

  /**
   * A copy of this agent with some configuration replaced.
   *
   * The original is untouched, so this is the safe way to specialise a shared
   * agent per request — a different model for a cheaper tier, an extra tool for
   * a privileged user:
   *
   * ```ts
   * const cheap = agent.clone({ model: openrouter('anthropic/claude-haiku-4-5') })
   * ```
   */
  clone(overrides: Partial<AgentConfig>): Agent {
    return new Agent({ ...this.config, ...overrides })
  }

  /** A copy of this agent with additional tools appended. */
  withTools(...tools: readonly AnyTool[]): Agent {
    return this.clone({ tools: [...(this.config.tools ?? []), ...tools] })
  }

  /** The resolved configuration. Read-only; mutating it does nothing. */
  toConfig(): Readonly<AgentConfig> {
    return { ...this.config }
  }
}

/**
 * Functional shorthand for `new Agent(config).run(input)`.
 *
 * Handy for one-shot calls where an agent instance would not be reused.
 */
export async function run<TOutput = string>(
  config: AgentConfig,
  input: AgentInput,
  options: RunOptions = {},
): Promise<RunResult<TOutput>> {
  return new Agent(config).run<TOutput>(input, options)
}
