/**
 * Structured output: asking the model for JSON, finding it, and checking it.
 *
 * Pure, like `retry.ts` — nothing here calls a model or emits an event. The
 * runner drives it, which keeps the loop's only new responsibility a single
 * `resolveOutput()` call before the loop and a validation pass after it.
 *
 * Three layers, applied in order, because no single one is enough:
 *   1. `responseFormat` — native constrained decoding, where the vendor has it.
 *   2. A schema instruction in the system prompt — for every provider that
 *      silently ignores the first.
 *   3. `extractJson` + validation + a bounded repair — for when both fail.
 */

import { AGENT_DEFAULTS, type AgentConfig, type RunOptions } from '../agent/types.js'
import type { SchemaIssue } from '../errors/errors.js'
import type { ResponseFormat } from '../providers/provider.js'
import { OUTPUT_SUBJECT, resolveJsonSchema } from '../schema/standard-schema.js'
import type { StandardSchemaV1 } from '../schema/standard-schema.js'
import type { ObjectJsonSchema } from '../types/json-schema.js'

/** Everything a run needs to ask for, find, and check a typed answer. */
export interface ResolvedOutput {
  readonly schema: StandardSchemaV1
  readonly jsonSchema: ObjectJsonSchema
  readonly responseFormat: ResponseFormat
  /** Appended to the system prompt. Precomputed — the schema cannot change. */
  readonly instruction: string
  /** Repair attempts after the first failure. */
  readonly maxRetries: number
}

/**
 * Resolves an agent's `outputSchema` into everything the run needs, or
 * `undefined` when the agent has none.
 *
 * Called once per run beside the tool definitions, for the same reason: the
 * first derivation may pay for a dynamic `import('zod')`, and the schema does
 * not change between turns.
 */
export async function resolveOutput(
  config: AgentConfig<unknown>,
  options: RunOptions,
): Promise<ResolvedOutput | undefined> {
  const schema = config.outputSchema
  if (!schema) return undefined

  const jsonSchema = await resolveJsonSchema(schema, OUTPUT_SUBJECT, config.outputJsonSchema)

  return {
    schema,
    jsonSchema,
    responseFormat: { type: 'json', schema: jsonSchema, name: 'output' },
    instruction: outputInstruction(jsonSchema),
    maxRetries: Math.max(
      0,
      options.maxOutputRetries ?? config.maxOutputRetries ?? AGENT_DEFAULTS.maxOutputRetries,
    ),
  }
}

/**
 * The schema, spelled out for the model in the system prompt.
 *
 * Always appended, never gated on a provider capability flag. `ModelProvider`
 * has no capability surface to consult, and gateways are the problem anyway —
 * Ollama, older vLLM builds, and some OpenRouter upstreams accept
 * `response_format` and silently drop it. Sixty tokens once per run is the
 * cheapest possible insurance against a class of failure that is otherwise
 * invisible until a user reports it.
 */
export function outputInstruction(jsonSchema: ObjectJsonSchema): string {
  return (
    'Respond with a single JSON object that conforms to this JSON Schema.\n' +
    'Output only the JSON: no prose before or after it, and no code fences.\n\n' +
    JSON.stringify(jsonSchema, null, 2)
  )
}

/** Combines the developer's instructions with the schema instruction. */
export function joinInstructions(instructions: string | undefined, instruction: string): string {
  return instructions ? `${instructions}\n\n${instruction}` : instruction
}

/**
 * What to say to a model whose answer did not validate.
 *
 * Deliberately does **not** reuse `formatIssues` from `errors.ts`. That string
 * is read by a human looking at a stack trace; this one is a prompt. Sharing
 * them means a wording tweak intended for one silently rewrites the other, and
 * one of the two is load-bearing for correctness.
 */
export function repairRequest(issues: readonly SchemaIssue[]): string {
  const detail =
    issues.length > 0
      ? issues
          .map(
            (issue) =>
              `  • ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
          )
          .join('\n')
      : '  • The response was not valid JSON.'

  return (
    'Your previous response did not match the required JSON Schema.\n\n' +
    `${detail}\n\n` +
    'Reply with only the corrected JSON object. No prose, no code fences.'
  )
}

/* ------------------------------------------------------------------------- */
/* Extraction                                                                */
/* ------------------------------------------------------------------------- */

export type ExtractResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

/**
 * Finds the JSON value in a model's answer.
 *
 * A discriminated result rather than `unknown | undefined`, mirroring
 * `ValidationResult`, so a legitimate top-level `null` is not mistaken for a
 * parse failure.
 *
 * Three strategies, cheapest first:
 *   1. The whole string. Native `response_format` lands here every time.
 *   2. The first fenced block — what a chatty model produces despite the
 *      instruction not to.
 *   3. The first balanced `{…}` or `[…]`, scanned rather than matched.
 */
export function extractJson(text: string): ExtractResult {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: false }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const whole = parse(trimmed)
    if (whole.ok) return whole
  }

  const fenced = FENCE_PATTERN.exec(trimmed)
  if (fenced?.[1]) {
    const inner = parse(fenced[1].trim())
    if (inner.ok) return inner
  }

  const balanced = sliceBalanced(trimmed)
  if (balanced !== undefined) return parse(balanced)

  return { ok: false }
}

const FENCE_PATTERN = /```(?:json)?\s*\n?([\s\S]*?)```/

function parse(candidate: string): ExtractResult {
  try {
    return { ok: true, value: JSON.parse(candidate) }
  } catch {
    return { ok: false }
  }
}

/**
 * The first balanced `{…}` or `[…]` in a string, or `undefined`.
 *
 * Scanned with a depth counter that tracks string literals and backslash
 * escapes, which is the whole reason this is not a regex. A greedy
 * `/\{[\s\S]*\}/` returns `{a} and {b}` for `Here is {a} and {b}`, and a lazy
 * one truncates `{"note": "use } sparingly"}` at the brace inside the string.
 * Both produce a parse failure that looks like the model misbehaving.
 */
function sliceBalanced(text: string): string | undefined {
  const start = firstOpener(text)
  if (start === undefined) return undefined

  const opener = text[start]
  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i += 1) {
    const char = text[i]

    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      // Only meaningful inside a string, but harmless outside one: JSON has no
      // other use for a backslash.
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (char === opener) depth += 1
    else if (char === closer) {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return undefined
}

function firstOpener(text: string): number | undefined {
  const brace = text.indexOf('{')
  const bracket = text.indexOf('[')
  if (brace === -1 && bracket === -1) return undefined
  if (brace === -1) return bracket
  if (bracket === -1) return brace
  return Math.min(brace, bracket)
}
