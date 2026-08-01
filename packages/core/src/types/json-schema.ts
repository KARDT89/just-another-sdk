/**
 * A deliberately loose JSON Schema type.
 *
 * We only ever *produce* JSON Schema (to describe tool parameters to a model)
 * and pass it through to the wire — we never interpret it. Modelling the full
 * spec would add types without adding safety, so this covers the keywords we
 * emit and allows the rest.
 */
export interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  const?: unknown
  anyOf?: JsonSchema[]
  allOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  additionalProperties?: boolean | JsonSchema
  $defs?: Record<string, JsonSchema>
  $ref?: string
  [keyword: string]: unknown
}

/**
 * The parameter schema every tool must resolve to before it can be sent to a
 * model. Providers require a top-level object schema.
 */
export interface ObjectJsonSchema extends JsonSchema {
  type: 'object'
  properties: Record<string, JsonSchema>
}

/** An empty, valid, no-argument parameter schema. */
export const EMPTY_OBJECT_SCHEMA: ObjectJsonSchema = Object.freeze({
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
})
