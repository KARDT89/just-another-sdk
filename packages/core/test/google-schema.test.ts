import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { toGeminiSchema } from '../src/providers/google-schema.js'
import { EMPTY_OBJECT_SCHEMA } from '../src/types/json-schema.js'
import type { JsonSchema } from '../src/types/json-schema.js'

/**
 * The sanitizer is pure — no `fetch`, no `Agent`, no network — which is exactly
 * why it lives in its own file. It is also the highest-risk piece of the Gemini
 * provider: Gemini accepts only an OpenAPI 3.0 subset, and *both* schema sources
 * in this SDK emit keywords outside it.
 */

/** Every keyword Gemini rejects, hunted recursively. */
function findForbidden(node: unknown, path = '$'): string[] {
  const forbidden = [
    '$schema',
    '$id',
    '$ref',
    '$defs',
    'definitions',
    'additionalProperties',
    'const',
    'allOf',
    'oneOf',
    'not',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'patternProperties',
    'prefixItems',
  ]

  if (Array.isArray(node)) {
    return node.flatMap((item, index) => findForbidden(item, `${path}[${index}]`))
  }
  if (typeof node !== 'object' || node === null) return []

  const hits: string[] = []
  for (const [key, value] of Object.entries(node)) {
    if (forbidden.includes(key)) hits.push(`${path}.${key}`)
    hits.push(...findForbidden(value, `${path}.${key}`))
  }
  return hits
}

describe('toGeminiSchema', () => {
  /**
   * The failure this whole module exists to prevent. `EMPTY_OBJECT_SCHEMA` is
   * on every no-argument tool in the package, and it carries
   * `additionalProperties` — which alone would 400 every such tool.
   */
  it('cleans the SDK’s own empty-object schema', () => {
    const result = toGeminiSchema(EMPTY_OBJECT_SCHEMA)

    expect(result).not.toHaveProperty('additionalProperties')
    expect(result['type']).toBe('object')
    expect(result['properties']).toEqual({})
  })

  it('strips every unsupported keyword, at any depth', () => {
    const schema: JsonSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'urn:test',
      type: 'object',
      additionalProperties: false,
      examples: [{ city: 'Paris' }],
      properties: {
        city: { type: 'string', minLength: 1, patternProperties: {} },
        age: { type: 'integer', exclusiveMinimum: 0, multipleOf: 1 },
        tags: {
          type: 'array',
          uniqueItems: true,
          items: { type: 'string', additionalProperties: false },
        },
      },
      required: ['city'],
    }

    const result = toGeminiSchema(schema)

    expect(findForbidden(result)).toEqual([])
    // Supported keywords survive.
    expect(result['required']).toEqual(['city'])
    expect(result['properties']).toMatchObject({
      city: { type: 'string', minLength: 1 },
      tags: { type: 'array', items: { type: 'string' } },
    })
  })

  it('inlines a $ref against $defs', () => {
    const schema: JsonSchema = {
      type: 'object',
      $defs: {
        Address: {
          type: 'object',
          properties: { street: { type: 'string' } },
          additionalProperties: false,
        },
      },
      properties: { home: { $ref: '#/$defs/Address' } },
    }

    const result = toGeminiSchema(schema)
    const properties = result['properties'] as Record<string, Record<string, unknown>>

    expect(findForbidden(result)).toEqual([])
    expect(properties['home']).toEqual({
      type: 'object',
      properties: { street: { type: 'string' } },
    })
  })

  /** A cycle must degrade, not hang or blow the stack. */
  it('degrades a cyclic $ref to a plain object', () => {
    const schema: JsonSchema = {
      type: 'object',
      $defs: {
        Node: {
          type: 'object',
          properties: { next: { $ref: '#/$defs/Node' } },
        },
      },
      properties: { root: { $ref: '#/$defs/Node' } },
    }

    const result = toGeminiSchema(schema)
    const root = (result['properties'] as Record<string, Record<string, unknown>>)['root']!
    const next = (root['properties'] as Record<string, unknown>)['next']

    expect(next).toEqual({ type: 'object' })
    expect(findForbidden(result)).toEqual([])
  })

  it('degrades a dangling $ref rather than throwing', () => {
    expect(toGeminiSchema({ $ref: '#/$defs/Missing' })).toEqual({ type: 'object' })
  })

  it('rewrites const to a single-member enum', () => {
    const result = toGeminiSchema({
      type: 'object',
      properties: { kind: { const: 'user' } },
    })

    const properties = result['properties'] as Record<string, Record<string, unknown>>
    expect(properties['kind']).toEqual({ enum: ['user'] })
  })

  it('renames oneOf to anyOf and recurses into the variants', () => {
    const result = toGeminiSchema({
      oneOf: [
        { type: 'string', const: 'a' },
        { type: 'object', additionalProperties: false, properties: {} },
      ],
    })

    expect(result['anyOf']).toEqual([
      { type: 'string', enum: ['a'] },
      { type: 'object', properties: {} },
    ])
    expect(result).not.toHaveProperty('oneOf')
  })

  /** Dropping `allOf` would lose the fields it contributes, not just the keyword. */
  it('merges allOf members instead of discarding them', () => {
    const result = toGeminiSchema({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    })

    expect(result['properties']).toEqual({ a: { type: 'string' }, b: { type: 'number' } })
    expect(result['required']).toEqual(['a', 'b'])
  })

  it('collapses prefixItems to items', () => {
    const result = toGeminiSchema({
      type: 'array',
      prefixItems: [{ type: 'string' }, { type: 'number' }],
    })

    expect(result['items']).toEqual({ type: 'string' })
    expect(result).not.toHaveProperty('prefixItems')
  })

  it('is idempotent on an already-clean schema', () => {
    const clean = {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    } as JsonSchema

    const once = toGeminiSchema(clean)
    expect(once).toEqual(clean)
    expect(toGeminiSchema(once as JsonSchema)).toEqual(once)
  })

  it('never returns a non-object at the top level', () => {
    expect(toGeminiSchema({ type: 'string' })).toEqual({ type: 'string' })
    expect(toGeminiSchema({})).toEqual({})
  })

  /**
   * The end-to-end case that matters: real Zod output, converted the way the
   * tool layer converts it, walked for anything Gemini would reject.
   */
  it('produces a Gemini-safe schema from real Zod output', () => {
    const schema = z.toJSONSchema(
      z.object({
        city: z.string().describe('City name'),
        units: z.enum(['c', 'f']).optional(),
        nested: z.object({ depth: z.number() }),
      }),
    ) as JsonSchema

    // Guard the premise: Zod really does emit something Gemini rejects.
    expect(findForbidden(schema).length).toBeGreaterThan(0)

    const result = toGeminiSchema(schema)
    expect(findForbidden(result)).toEqual([])
    expect((result['properties'] as Record<string, unknown>)['city']).toMatchObject({
      type: 'string',
      description: 'City name',
    })
  })
})
