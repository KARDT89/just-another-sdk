/**
 * A minimal Standard Schema implementation, for the SDK's own built-in tools.
 *
 * **Why this exists.** Every built-in tool needs its arguments validated before
 * its handler runs — a filesystem path or a URL arriving unchecked from a model
 * is exactly the input you cannot trust. But the SDK has **zero runtime
 * dependencies**, so it cannot import Zod to describe its own parameters.
 *
 * The escape hatch used in step 6 — passing raw `parameters` JSON Schema with no
 * `inputSchema` — was fine for one optional string and is not fine for a path.
 * So: roughly a hundred lines implementing the same
 * [Standard Schema](https://standardschema.dev) interface every supported
 * validator implements, covering only the shapes built-in tools actually use.
 *
 * Each node carries **both** its validator and its own JSON Schema, so a tool
 * passes `inputSchema` *and* `parameters` and
 * {@link resolveJsonSchema} returns the override without needing a converter.
 * Built-in tools therefore get `InvalidToolInputError` with per-field messages
 * through the path that already exists in `prepareToolCall`.
 *
 * Deliberately internal. It is not a validation library and should not grow into
 * one — anything it cannot express is a sign the tool wants a real validator,
 * which is what `inputSchema` accepts from consumers anyway.
 *
 * ```ts
 * const input = s.object({
 *   path: s.string({ describe: 'Path relative to the root directory.' }),
 *   maxBytes: s.integer({ describe: 'Cap on bytes read.', min: 1, default: 65_536 }),
 * })
 * // input: MiniType<{ path: string; maxBytes: number }>
 * ```
 */

import type { JsonSchema, ObjectJsonSchema } from '../types/json-schema.js'
import type { StandardSchemaV1, StandardSchemaV1Issue } from './standard-schema.js'

/** The vendor name reported to anything inspecting `~standard`. */
const VENDOR = 'just-another-sdk/mini'

/**
 * A schema node: a Standard Schema validator that also knows how to describe
 * itself to a model.
 */
export interface MiniType<T> extends StandardSchemaV1<unknown, T> {
  readonly jsonSchema: JsonSchema
  /** Absent from the JSON Schema's `required` list when true. */
  readonly isOptional: boolean
  /**
   * The self-conversion hook {@link resolveJsonSchema} already looks for.
   *
   * Implementing it rather than registering a converter is what lets a built-in
   * tool pass `inputSchema` alone — no `parameters` duplicate to keep in sync,
   * and no setup for a consumer who reaches for `s` themselves.
   */
  toJSONSchema(): JsonSchema
}

/** A top-level object node, whose JSON Schema is usable as tool `parameters`. */
export interface MiniObject<T> extends MiniType<T> {
  readonly jsonSchema: ObjectJsonSchema
}

type Checked<T> = { ok: true; value: T } | { ok: false; issues: StandardSchemaV1Issue[] }

/** Validates one value at one location. Path is carried so issues can name a field. */
type Check<T> = (value: unknown, path: readonly PropertyKey[]) => Checked<T>

/* ------------------------------------------------------------------------- */
/* Type inference                                                            */
/* ------------------------------------------------------------------------- */

type Infer<S> = S extends MiniType<infer T> ? T : never

type Shape = Record<string, MiniType<unknown>>

/**
 * Keys whose value may be absent.
 *
 * Derived from whether `undefined` is in the output type rather than from a
 * separate flag, so a `default` — which always produces a value — correctly
 * stays **required** in the result type while being optional on the wire.
 */
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: undefined extends Infer<S[K]> ? K : never
}[keyof S]

type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>

type ObjectOutput<S extends Shape> = {
  [K in RequiredKeys<S>]: Infer<S[K]>
} & {
  [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>
}

/** Flattens the intersection above so hover text shows one object, not two. */
type Simplify<T> = { [K in keyof T]: T[K] } & {}

/* ------------------------------------------------------------------------- */
/* Construction                                                              */
/* ------------------------------------------------------------------------- */

function node<T>(jsonSchema: JsonSchema, check: Check<T>, isOptional = false): MiniType<T> {
  return {
    jsonSchema,
    isOptional,
    toJSONSchema: () => jsonSchema,
    '~standard': {
      version: 1,
      vendor: VENDOR,
      validate: (value: unknown) => {
        const result = check(value, [])
        return result.ok ? { value: result.value } : { issues: result.issues }
      },
    },
  }
}

function fail(path: readonly PropertyKey[], message: string): Checked<never> {
  return { ok: false, issues: [{ message, path: [...path] }] }
}

/** Reads better in a message than `typeof null === 'object'`. */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/* ------------------------------------------------------------------------- */
/* Leaves                                                                    */
/* ------------------------------------------------------------------------- */

export interface StringOptions {
  /** Shown to the model. Worth writing well — it drives argument quality. */
  readonly describe?: string
  readonly minLength?: number
  readonly maxLength?: number
  /** Value used when the key is absent. Implies the key is not required. */
  readonly default?: string
}

function string(options: StringOptions = {}): MiniType<string> {
  const jsonSchema: JsonSchema = {
    type: 'string',
    ...(options.describe !== undefined ? { description: options.describe } : {}),
    ...(options.minLength !== undefined ? { minLength: options.minLength } : {}),
    ...(options.maxLength !== undefined ? { maxLength: options.maxLength } : {}),
    ...(options.default !== undefined ? { default: options.default } : {}),
  }

  return node<string>(
    jsonSchema,
    (value, path) => {
      if (value === undefined && options.default !== undefined) {
        return { ok: true, value: options.default }
      }
      if (typeof value !== 'string')
        return fail(path, `Expected a string, received ${describe(value)}.`)
      if (options.minLength !== undefined && value.length < options.minLength) {
        return fail(
          path,
          `Expected at least ${options.minLength} characters, received ${value.length}.`,
        )
      }
      if (options.maxLength !== undefined && value.length > options.maxLength) {
        return fail(
          path,
          `Expected at most ${options.maxLength} characters, received ${value.length}.`,
        )
      }
      return { ok: true, value }
    },
    options.default !== undefined,
  )
}

export interface NumberOptions {
  readonly describe?: string
  readonly min?: number
  readonly max?: number
  readonly default?: number
}

function numeric(integer: boolean, options: NumberOptions = {}): MiniType<number> {
  const jsonSchema: JsonSchema = {
    type: integer ? 'integer' : 'number',
    ...(options.describe !== undefined ? { description: options.describe } : {}),
    ...(options.min !== undefined ? { minimum: options.min } : {}),
    ...(options.max !== undefined ? { maximum: options.max } : {}),
    ...(options.default !== undefined ? { default: options.default } : {}),
  }

  return node<number>(
    jsonSchema,
    (value, path) => {
      if (value === undefined && options.default !== undefined) {
        return { ok: true, value: options.default }
      }

      // Models routinely send "3" where a number belongs, and refusing it would
      // burn a turn to fix a difference the developer does not care about.
      // Coerced rather than rejected, exactly as `z.coerce.number()` would.
      const coerced =
        typeof value === 'string' && value.trim() !== '' ? Number(value) : (value as number)

      if (typeof coerced !== 'number' || !Number.isFinite(coerced)) {
        return fail(
          path,
          `Expected a ${integer ? 'whole ' : ''}number, received ${describe(value)}.`,
        )
      }
      if (integer && !Number.isInteger(coerced)) {
        return fail(path, `Expected a whole number, received ${coerced}.`)
      }
      if (options.min !== undefined && coerced < options.min) {
        return fail(path, `Expected at least ${options.min}, received ${coerced}.`)
      }
      if (options.max !== undefined && coerced > options.max) {
        return fail(path, `Expected at most ${options.max}, received ${coerced}.`)
      }
      return { ok: true, value: coerced }
    },
    options.default !== undefined,
  )
}

export interface BooleanOptions {
  readonly describe?: string
  readonly default?: boolean
}

function boolean(options: BooleanOptions = {}): MiniType<boolean> {
  const jsonSchema: JsonSchema = {
    type: 'boolean',
    ...(options.describe !== undefined ? { description: options.describe } : {}),
    ...(options.default !== undefined ? { default: options.default } : {}),
  }

  return node<boolean>(
    jsonSchema,
    (value, path) => {
      if (value === undefined && options.default !== undefined) {
        return { ok: true, value: options.default }
      }
      if (typeof value === 'boolean') return { ok: true, value }
      if (value === 'true') return { ok: true, value: true }
      if (value === 'false') return { ok: true, value: false }
      return fail(path, `Expected true or false, received ${describe(value)}.`)
    },
    options.default !== undefined,
  )
}

export interface EnumOptions<T extends string> {
  readonly describe?: string
  readonly default?: T
}

/**
 * One of a fixed set of strings.
 *
 * The single most valuable node here: an `enum` in the JSON Schema is what stops
 * a model inventing a unit or an operation name, which turns a whole class of
 * runtime failure into something the provider prevents.
 */
function enumeration<const T extends readonly string[]>(
  values: T,
  options: EnumOptions<T[number]> = {},
): MiniType<T[number]> {
  const jsonSchema: JsonSchema = {
    type: 'string',
    enum: [...values],
    ...(options.describe !== undefined ? { description: options.describe } : {}),
    ...(options.default !== undefined ? { default: options.default } : {}),
  }

  return node<T[number]>(
    jsonSchema,
    (value, path) => {
      if (value === undefined && options.default !== undefined) {
        return { ok: true, value: options.default }
      }
      if (typeof value !== 'string' || !values.includes(value)) {
        return fail(
          path,
          `Expected one of ${values.join(', ')}; received ${JSON.stringify(value)}.`,
        )
      }
      return { ok: true, value }
    },
    options.default !== undefined,
  )
}

/* ------------------------------------------------------------------------- */
/* Composites                                                                */
/* ------------------------------------------------------------------------- */

export interface ArrayOptions {
  readonly describe?: string
  readonly maxItems?: number
}

function array<T>(item: MiniType<T>, options: ArrayOptions = {}): MiniType<T[]> {
  const jsonSchema: JsonSchema = {
    type: 'array',
    items: item.jsonSchema,
    ...(options.describe !== undefined ? { description: options.describe } : {}),
    ...(options.maxItems !== undefined ? { maxItems: options.maxItems } : {}),
  }

  return node<T[]>(jsonSchema, (value, path) => {
    if (!Array.isArray(value)) return fail(path, `Expected an array, received ${describe(value)}.`)
    if (options.maxItems !== undefined && value.length > options.maxItems) {
      return fail(path, `Expected at most ${options.maxItems} items, received ${value.length}.`)
    }

    const out: T[] = []
    const issues: StandardSchemaV1Issue[] = []

    for (const [index, entry] of value.entries()) {
      const result = checkOf(item)(entry, [...path, index])
      if (result.ok) out.push(result.value)
      else issues.push(...result.issues)
    }

    return issues.length > 0 ? { ok: false, issues } : { ok: true, value: out }
  })
}

/** Makes a node accept `undefined`, and drops it from the parent's `required`. */
function optional<T>(inner: MiniType<T>): MiniType<T | undefined> {
  return node<T | undefined>(
    inner.jsonSchema,
    (value, path) =>
      value === undefined || value === null
        ? { ok: true, value: undefined }
        : checkOf(inner)(value, path),
    true,
  )
}

export interface ObjectOptions {
  readonly describe?: string
}

/**
 * The top-level node every tool uses.
 *
 * **Every field is validated before the first issue is returned**, so a model
 * that got two arguments wrong is told about both and can fix them in one
 * retry rather than two.
 */
function object<S extends Shape>(
  shape: S,
  options: ObjectOptions = {},
): MiniObject<Simplify<ObjectOutput<S>>> {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []

  for (const [key, field] of Object.entries(shape)) {
    properties[key] = field.jsonSchema
    if (!field.isOptional) required.push(key)
  }

  const jsonSchema: ObjectJsonSchema = {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
    ...(options.describe !== undefined ? { description: options.describe } : {}),
  }

  const check: Check<Simplify<ObjectOutput<S>>> = (value, path) => {
    // A no-argument call arrives as `{}` from some providers and `undefined`
    // from others; treating them the same is what stops an all-optional tool
    // failing on one vendor and working on another.
    const source: Record<string, unknown> =
      value === undefined || value === null
        ? {}
        : typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : (undefined as never)

    if (source === undefined) {
      return fail(path, `Expected an object, received ${describe(value)}.`)
    }

    const out: Record<string, unknown> = {}
    const issues: StandardSchemaV1Issue[] = []

    for (const [key, field] of Object.entries(shape)) {
      const result = checkOf(field)(source[key], [...path, key])
      if (!result.ok) {
        issues.push(...result.issues)
        continue
      }
      // An absent optional stays absent rather than becoming an explicit
      // `undefined`, so `'key' in input` behaves the way a handler expects.
      if (result.value !== undefined) out[key] = result.value
    }

    return issues.length > 0
      ? { ok: false, issues }
      : { ok: true, value: out as Simplify<ObjectOutput<S>> }
  }

  const built = node(jsonSchema, check)
  return { ...built, jsonSchema }
}

/**
 * Reaches a node's validator with a path attached.
 *
 * Nodes expose `~standard.validate`, which takes no path because the spec has no
 * notion of one. Composites need it, so they re-enter through here and re-tag
 * the issues with where they came from.
 */
function checkOf<T>(schema: MiniType<T>): Check<T> {
  return (value, path) => {
    const result = schema['~standard'].validate(value)

    // Every node in this module is synchronous by construction. Asserting it
    // here rather than making the whole tree async keeps the composites simple.
    if (result instanceof Promise) {
      throw new TypeError('A mini schema validator must be synchronous.')
    }

    if (result.issues === undefined) return { ok: true, value: result.value }

    return {
      ok: false,
      issues: result.issues.map((issue) => ({
        message: issue.message,
        path: [...path, ...(issue.path ?? [])],
      })),
    }
  }
}

/* ------------------------------------------------------------------------- */
/* The namespace                                                             */
/* ------------------------------------------------------------------------- */

/**
 * The builder. Named `s` at every call site, so a tool's parameters read as a
 * block:
 *
 * ```ts
 * s.object({
 *   value: s.number({ describe: 'The quantity to convert.' }),
 *   from: s.string({ describe: 'Unit to convert from, e.g. "km".' }),
 *   to: s.string({ describe: 'Unit to convert to, e.g. "mi".' }),
 * })
 * ```
 */
export const s = {
  string,
  number: (options?: NumberOptions) => numeric(false, options),
  integer: (options?: NumberOptions) => numeric(true, options),
  boolean,
  enum: enumeration,
  array,
  object,
  optional,
} as const
