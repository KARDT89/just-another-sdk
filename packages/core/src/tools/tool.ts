import type { ObjectJsonSchema } from '../types/json-schema.js'
import type { ToolDefinition } from '../providers/provider.js'
import { EMPTY_OBJECT_SCHEMA } from '../types/json-schema.js'
import {
  type InferSchemaOutput,
  type StandardSchemaV1,
  isStandardSchema,
  resolveJsonSchema,
} from '../schema/standard-schema.js'
import { ConfigurationError } from '../errors/errors.js'

/** Context handed to every tool handler. */
export interface ToolContext {
  /** The run this call belongs to. Use it to correlate your own logs. */
  readonly runId: string
  /** Provider-assigned id of this specific call. */
  readonly toolCallId: string
  /** The agent that invoked the tool. */
  readonly agentName: string
  /** 1-based turn number within the run. */
  readonly turn: number
  /**
   * Aborted when the run is cancelled or this call exceeds its timeout.
   * Long-running handlers should forward it to `fetch` and honour it.
   */
  readonly signal: AbortSignal
}

export type ToolHandler<TInput, TOutput> = (
  input: TInput,
  context: ToolContext,
) => TOutput | Promise<TOutput>

/**
 * A tool: a name, a description the model reads to decide when to call it, a
 * schema its arguments are validated against, and an async function to run.
 */
export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string
  readonly description: string
  /** The validator. Absent for a no-argument tool. */
  readonly inputSchema?: StandardSchemaV1<unknown, TInput>
  readonly execute: ToolHandler<TInput, TOutput>
  /** Per-call deadline, overriding the agent's `toolTimeoutMs`. */
  readonly timeoutMs?: number
  /**
   * Resolves the JSON Schema shown to the model. Memoized — the underlying
   * conversion (and any dynamic import) happens at most once per tool.
   */
  toDefinition(): Promise<ToolDefinition>
}

/**
 * Any tool, regardless of its input/output types.
 *
 * `any` is deliberate here and cannot be `unknown`: a heterogeneous
 * `readonly AnyTool[]` needs bivariant handler parameters, and `Tool<unknown,
 * unknown>` would reject every concretely-typed tool assigned into it.
 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
export type AnyTool = Tool<any, any>

export interface ToolSpec<TSchema extends StandardSchemaV1, TOutput> {
  /**
   * Unique, snake_case by convention. This is the identifier the model emits, so
   * make it descriptive: `get_weather` beats `weather`.
   */
  readonly name: string
  /**
   * Written for the model, not for your teammates. State *when* to call it, not
   * just what it does — this single string drives most of the tool-selection
   * quality you will observe.
   */
  readonly description: string
  /** Any Standard Schema validator: Zod, Valibot, ArkType, … */
  readonly inputSchema?: TSchema
  /**
   * Explicit JSON Schema for the model, bypassing automatic derivation. Required
   * only for validators the SDK cannot convert on its own.
   */
  readonly parameters?: ObjectJsonSchema
  readonly execute: ToolHandler<InferSchemaOutput<TSchema>, TOutput>
  readonly timeoutMs?: number
}

/** A tool that takes no arguments. */
export interface NullaryToolSpec<TOutput> {
  readonly name: string
  readonly description: string
  readonly inputSchema?: undefined
  readonly parameters?: ObjectJsonSchema
  readonly execute: ToolHandler<Record<string, never>, TOutput>
  readonly timeoutMs?: number
}

/**
 * Defines a tool.
 *
 * The handler's `input` is typed from `inputSchema`, so a mismatch is a compile
 * error rather than a runtime surprise:
 *
 * ```ts
 * const getWeather = tool({
 *   name: 'get_weather',
 *   description: 'Look up the current weather. Call this whenever the user asks about conditions in a place.',
 *   inputSchema: z.object({ city: z.string().describe('City name, e.g. "Paris"') }),
 *   execute: async ({ city }) => {          //  ← city: string, inferred
 *     const res = await fetch(`https://api.example.com/weather?city=${city}`)
 *     return res.json()
 *   },
 * })
 * ```
 *
 * The returned object is inert — defining a tool performs no I/O and touches no
 * global state, so tools are safe to declare at module scope and share between
 * agents.
 */
export function tool<TOutput>(spec: NullaryToolSpec<TOutput>): Tool<Record<string, never>, TOutput>
export function tool<TSchema extends StandardSchemaV1, TOutput>(
  spec: ToolSpec<TSchema, TOutput>,
): Tool<InferSchemaOutput<TSchema>, TOutput>
export function tool(
  spec: ToolSpec<StandardSchemaV1, unknown> | NullaryToolSpec<unknown>,
): AnyTool {
  assertValidName(spec.name)

  if (!spec.description || spec.description.trim().length === 0) {
    throw new ConfigurationError(`Tool "${spec.name}" has no description.`, {
      hint:
        'The description is how the model decides whether to call this tool. ' +
        'Describe when it should be used, not just what it does.',
    })
  }

  if (spec.inputSchema !== undefined && !isStandardSchema(spec.inputSchema)) {
    throw new ConfigurationError(
      `The inputSchema for tool "${spec.name}" is not a Standard Schema validator.`,
      {
        hint:
          'Use Zod 3.25+/4, Valibot 1+, ArkType 2+, or any validator implementing ' +
          'the Standard Schema spec — or omit inputSchema and pass `parameters` instead.',
      },
    )
  }

  const { name, description, inputSchema, parameters, execute, timeoutMs } = spec

  let definition: Promise<ToolDefinition> | undefined

  return {
    name,
    description,
    ...(inputSchema ? { inputSchema } : {}),
    execute: execute as ToolHandler<unknown, unknown>,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),

    toDefinition(): Promise<ToolDefinition> {
      // Memoized on the promise, so concurrent turns share one resolution and a
      // failed conversion is not retried on every model call.
      definition ??= buildDefinition({ name, description, inputSchema, parameters })
      return definition
    },
  }
}

async function buildDefinition(args: {
  name: string
  description: string
  inputSchema: StandardSchemaV1 | undefined
  parameters: ObjectJsonSchema | undefined
}): Promise<ToolDefinition> {
  const { name, description, inputSchema, parameters } = args

  const resolved = inputSchema
    ? await resolveJsonSchema(inputSchema, name, parameters)
    : (parameters ?? EMPTY_OBJECT_SCHEMA)

  return { name, description, parameters: resolved }
}

/**
 * Providers agree on this much: 1–64 characters of `[A-Za-z0-9_-]`. Validating
 * here turns a confusing provider 400 into a clear error at definition time.
 */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function assertValidName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ConfigurationError(`"${name}" is not a valid tool name.`, {
      hint: 'Use 1–64 characters of letters, digits, underscores, or hyphens — e.g. "get_weather".',
      details: { name },
    })
  }
}
