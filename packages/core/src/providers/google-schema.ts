/**
 * JSON Schema → Gemini's OpenAPI 3.0 subset.
 *
 * This is not a nicety. Gemini rejects a schema carrying `$schema`,
 * `additionalProperties`, `$defs`, `const`, `allOf`, `oneOf`, and a dozen other
 * perfectly ordinary keywords — and *both* schema sources in this SDK emit at
 * least one of them: `EMPTY_OBJECT_SCHEMA` sets `additionalProperties: false`,
 * and Zod's `toJSONSchema()` emits `$schema` on every object. Without this pass
 * every tool would 400 against Gemini, every time.
 *
 * It lives in its own file because it is the one piece of the provider that can
 * be tested with no `fetch`, no `Agent`, and no network.
 *
 * The contract: **never throw**. A schema is a description, and a description
 * the translator cannot express should degrade to a looser one rather than take
 * down a run. Anything unrepresentable becomes `{ type: 'object' }`.
 */

import type { JsonSchema } from '../types/json-schema.js'

/**
 * Keywords Gemini rejects outright. Dropped wherever they appear.
 *
 * `additionalProperties` is the load-bearing entry: it is on every tool schema
 * this SDK produces.
 */
const DROPPED_KEYWORDS: ReadonlySet<string> = new Set([
  '$schema',
  '$id',
  '$comment',
  '$anchor',
  'additionalProperties',
  'unevaluatedProperties',
  'patternProperties',
  'dependentSchemas',
  'dependentRequired',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'examples',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'uniqueItems',
  'readOnly',
  'writeOnly',
  'deprecated',
  'const', // rewritten to `enum` before the drop; see below
  'allOf', // merged or inlined before the drop
  'oneOf', // renamed to `anyOf` before the drop
  'prefixItems', // renamed to `items` before the drop
  '$ref', // inlined before the drop
  '$defs',
  'definitions',
])

/**
 * Depth cap for the walk.
 *
 * A `$ref` cycle is caught by the visited set, but a pathological
 * machine-generated schema can nest legitimately and deeply, and a stack
 * overflow inside a provider is a much worse failure than a slightly lossy
 * schema.
 */
const MAX_DEPTH = 24

/**
 * Rewrites a JSON Schema into the subset Gemini accepts.
 *
 * Idempotent: a schema that is already clean passes through unchanged, so it is
 * safe to run over a hand-written Gemini schema.
 */
export function toGeminiSchema(schema: JsonSchema): Record<string, unknown> {
  const root = schema as Record<string, unknown>
  const definitions = collectDefinitions(root)
  const result = walk(root, definitions, MAX_DEPTH, new Set())

  // Gemini requires an object at the top level of `parameters`.
  return typeof result === 'object' && result !== null ? result : { type: 'object' }
}

function collectDefinitions(root: Record<string, unknown>): Record<string, unknown> {
  const defs = root['$defs'] ?? root['definitions']
  return isRecord(defs) ? defs : {}
}

function walk(
  node: Record<string, unknown>,
  definitions: Record<string, unknown>,
  depth: number,
  visiting: Set<string>,
): Record<string, unknown> {
  if (depth <= 0) return { type: 'object' }

  // `$ref` first: everything else on the node is meaningless until it resolves.
  const ref = node['$ref']
  if (typeof ref === 'string') {
    const resolved = resolveRef(ref, definitions, visiting)
    // A cycle or a dangling pointer degrades rather than recursing forever.
    if (!resolved) return { type: 'object' }

    visiting.add(ref)
    try {
      return walk(resolved, definitions, depth - 1, visiting)
    } finally {
      visiting.delete(ref)
    }
  }

  const out: Record<string, unknown> = {}

  for (const [keyword, value] of Object.entries(node)) {
    switch (keyword) {
      case 'properties': {
        if (!isRecord(value)) break
        const properties: Record<string, unknown> = {}
        for (const [name, child] of Object.entries(value)) {
          if (isRecord(child)) properties[name] = walk(child, definitions, depth - 1, visiting)
        }
        out['properties'] = properties
        break
      }

      case 'items':
      case 'prefixItems': {
        // Gemini has no tuple typing; the first positional schema is the closest
        // honest approximation of a `prefixItems` array.
        const first = Array.isArray(value) ? value[0] : value
        if (isRecord(first)) out['items'] = walk(first, definitions, depth - 1, visiting)
        break
      }

      case 'anyOf':
      case 'oneOf': {
        // `oneOf` is exactly-one and `anyOf` is at-least-one, so this widens the
        // schema. Gemini has no `oneOf`, and a widened union still describes the
        // shape well enough for the model to fill it in.
        if (!Array.isArray(value)) break
        const variants = value
          .filter(isRecord)
          .map((variant) => walk(variant, definitions, depth - 1, visiting))
        if (variants.length > 0) out['anyOf'] = variants
        break
      }

      case 'allOf': {
        // Shallow-merged rather than dropped: `allOf` is how most generators
        // express "this object, plus these fields", and losing it would lose the
        // fields entirely.
        if (!Array.isArray(value)) break
        for (const member of value) {
          if (!isRecord(member)) continue
          mergeInto(out, walk(member, definitions, depth - 1, visiting))
        }
        break
      }

      case 'const':
        // A single-member enum says the same thing in a keyword Gemini knows.
        out['enum'] = [value]
        break

      case 'required':
        if (Array.isArray(value) && value.length > 0) out['required'] = [...value]
        break

      default:
        if (!DROPPED_KEYWORDS.has(keyword)) out[keyword] = value
        break
    }
  }

  return out
}

/** Resolves a local `#/$defs/Name` pointer. Returns undefined on a cycle. */
function resolveRef(
  ref: string,
  definitions: Record<string, unknown>,
  visiting: Set<string>,
): Record<string, unknown> | undefined {
  if (visiting.has(ref)) return undefined

  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref)
  if (!match?.[1]) return undefined

  // JSON Pointer escapes, in the order the spec mandates.
  const name = decodeURIComponent(match[1]).replace(/~1/g, '/').replace(/~0/g, '~')
  const target = definitions[name]
  return isRecord(target) ? target : undefined
}

/**
 * Shallow-merges an `allOf` member into the accumulating node.
 *
 * `properties` and `required` are unioned rather than replaced — replacing them
 * is what turns a two-member `allOf` into a schema missing half its fields.
 */
function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [keyword, value] of Object.entries(source)) {
    if (keyword === 'properties' && isRecord(target['properties']) && isRecord(value)) {
      Object.assign(target['properties'], value)
    } else if (
      keyword === 'required' &&
      Array.isArray(target['required']) &&
      Array.isArray(value)
    ) {
      target['required'] = [...new Set([...target['required'], ...value])]
    } else {
      target[keyword] = value
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
