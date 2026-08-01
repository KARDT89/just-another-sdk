/**
 * Validator interop, via the Standard Schema spec (https://standardschema.dev).
 *
 * Zod 3.25+/4, Valibot 1+, ArkType 2+ and others all expose a `~standard`
 * property, so the SDK can validate with any of them while depending on none.
 * That is why `just-another-sdk` has zero runtime dependencies and does not
 * force a validator choice on the consumer.
 *
 * Two operations are needed:
 *   • `validate` — check the model's arguments before a handler ever runs.
 *   • `resolveJsonSchema` — describe those arguments to the model in the first
 *     place. Standard Schema deliberately does not cover this, so we probe for a
 *     converter at runtime and fall back to an explicit developer-supplied
 *     schema. Resolution is async so that Zod's converter can be reached by
 *     dynamic import — which is what keeps Zod an *optional peer* rather than a
 *     dependency, while still working with no setup.
 */

import { InvalidSchemaError, type SchemaIssue } from '../errors/errors.js'
import type { JsonSchema, ObjectJsonSchema } from '../types/json-schema.js'

/* ------------------------------------------------------------------------- */
/* Standard Schema v1 — vendored types (spec-stable, ~30 lines, no dependency) */
/* ------------------------------------------------------------------------- */

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1Props<Input, Output>
}

export interface StandardSchemaV1Props<Input = unknown, Output = Input> {
  readonly version: 1
  readonly vendor: string
  readonly validate: (
    value: unknown,
  ) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>
  readonly types?: StandardSchemaV1Types<Input, Output> | undefined
}

export type StandardSchemaV1Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaV1Issue[] }

export interface StandardSchemaV1Issue {
  readonly message: string
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined
}

export interface StandardSchemaV1Types<Input = unknown, Output = Input> {
  readonly input: Input
  readonly output: Output
}

/** Infers the validated (output) type of any Standard Schema. */
export type InferSchemaOutput<TSchema> =
  TSchema extends StandardSchemaV1<unknown, infer Output> ? Output : never

/* ------------------------------------------------------------------------- */
/* Validation                                                                */
/* ------------------------------------------------------------------------- */

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly SchemaIssue[] }

export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    '~standard' in value &&
    typeof (value as StandardSchemaV1)['~standard']?.validate === 'function'
  )
}

/**
 * Validates `input` against `schema`, normalizing any validator's issue format
 * into ours. Never throws for invalid *data* — only an unusable schema throws.
 */
export async function validate<TSchema extends StandardSchemaV1>(
  schema: TSchema,
  input: unknown,
): Promise<ValidationResult<InferSchemaOutput<TSchema>>> {
  const result = await schema['~standard'].validate(input)

  if (result.issues === undefined) {
    return { ok: true, value: result.value as InferSchemaOutput<TSchema> }
  }

  return { ok: false, issues: result.issues.map(normalizeIssue) }
}

function normalizeIssue(issue: StandardSchemaV1Issue): SchemaIssue {
  const path = (issue.path ?? []).map((segment) => {
    const key = typeof segment === 'object' && segment !== null ? segment.key : segment
    return typeof key === 'number' ? key : String(key)
  })
  return { path, message: issue.message }
}

/* ------------------------------------------------------------------------- */
/* JSON Schema derivation                                                    */
/* ------------------------------------------------------------------------- */

type NamespaceConverter = (schema: unknown, options?: unknown) => unknown
type SelfConverting = { toJSONSchema: () => unknown }

const converters = new Map<string, NamespaceConverter>()

/**
 * Vendors whose converter lives on the package namespace rather than the schema
 * object, and which we therefore import on demand. Keyed by Standard Schema
 * `vendor` string.
 */
const LAZY_VENDOR_MODULES: Readonly<Record<string, string>> = {
  zod: 'zod',
}

/**
 * Teaches the SDK how to convert one vendor's schemas to JSON Schema.
 *
 * You should not need this for Zod — it is detected automatically. Use it for a
 * validator that neither converts itself nor is in {@link LAZY_VENDOR_MODULES}:
 *
 * ```ts
 * import { toJsonSchema } from 'my-validator'
 * registerJsonSchemaConverter('my-validator', toJsonSchema)
 * ```
 */
export function registerJsonSchemaConverter(vendor: string, convert: NamespaceConverter): void {
  if (typeof convert !== 'function') {
    throw new InvalidSchemaError(
      `The converter registered for vendor "${vendor}" is not a function.`,
    )
  }
  converters.set(vendor, convert)
}

/**
 * Best-effort conversion of a validator schema into a JSON Schema object.
 *
 * Resolution order:
 *   1. An explicit `override` — always wins; the documented escape hatch.
 *   2. `schema.toJSONSchema()`, for schemas that convert themselves.
 *   3. A converter registered via {@link registerJsonSchemaConverter}.
 *   4. A lazily imported vendor namespace (Zod 4's `z.toJSONSchema`).
 *
 * Throws {@link InvalidSchemaError} with an actionable hint when none apply, so
 * the failure surfaces on the first run rather than deep inside a provider.
 */
export async function resolveJsonSchema(
  schema: StandardSchemaV1,
  toolName: string,
  override?: ObjectJsonSchema,
): Promise<ObjectJsonSchema> {
  if (override) return override

  const vendor = schema['~standard'].vendor
  const converted = await convertWithAnyStrategy(schema, vendor)

  if (converted !== undefined) return asObjectSchema(converted, toolName, vendor)

  throw new InvalidSchemaError(
    `Could not derive a JSON Schema for tool "${toolName}" from its "${vendor}" schema.`,
    {
      hint:
        'Pass an explicit `parameters` JSON Schema alongside `inputSchema` in your tool() ' +
        `call, or register a converter with registerJsonSchemaConverter('${vendor}', fn).`,
      details: { toolName, vendor },
    },
  )
}

async function convertWithAnyStrategy(schema: StandardSchemaV1, vendor: string): Promise<unknown> {
  const selfConverting = schema as unknown as SelfConverting
  if (typeof selfConverting.toJSONSchema === 'function') {
    const result = attempt(() => selfConverting.toJSONSchema())
    if (result !== undefined) return result
  }

  const registered = converters.get(vendor)
  if (registered) {
    const result = attempt(() => registered(schema, CONVERT_OPTIONS))
    if (result !== undefined) return result
  }

  const lazy = await loadVendorConverter(vendor)
  if (lazy) return attempt(() => lazy(schema, CONVERT_OPTIONS))

  return undefined
}

/**
 * `io: 'input'` matters: it makes the model see the shape it must *send*, not
 * the shape produced after transforms and defaults are applied.
 */
const CONVERT_OPTIONS = Object.freeze({ io: 'input', target: 'draft-2020-12' })

async function loadVendorConverter(vendor: string): Promise<NamespaceConverter | undefined> {
  const moduleId = LAZY_VENDOR_MODULES[vendor]
  if (!moduleId) return undefined

  try {
    const namespace: unknown = await import(/* @vite-ignore */ moduleId)
    const candidate = (namespace as Record<string, unknown>)['toJSONSchema']
    if (typeof candidate === 'function') {
      const convert = candidate as NamespaceConverter
      converters.set(vendor, convert) // memoize; the import only happens once
      return convert
    }
  } catch {
    // The validator is not installed, or is too old to ship a converter.
    // Falls through to the actionable error in resolveJsonSchema.
  }
  return undefined
}

function attempt(fn: () => unknown): unknown {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * Providers require a top-level object schema for tool parameters. This coerces
 * whatever the converter produced into that shape, and drops the `$schema` key
 * that some vendors add and some providers reject.
 */
function asObjectSchema(value: unknown, toolName: string, vendor: string): ObjectJsonSchema {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidSchemaError(
      `The JSON Schema derived for tool "${toolName}" is not an object.`,
      {
        details: { toolName, vendor },
      },
    )
  }

  const { $schema: _dropped, ...rest } = value as JsonSchema & { $schema?: string }

  if (rest.type !== 'object') {
    throw new InvalidSchemaError(
      `Tool "${toolName}" must accept an object, but its schema describes ` +
        `${typeof rest.type === 'string' ? `a "${rest.type}"` : 'something else'}.`,
      {
        hint: 'Wrap the parameters in an object, e.g. z.object({ city: z.string() }).',
        details: { toolName, vendor },
      },
    )
  }

  return { ...rest, type: 'object', properties: rest.properties ?? {} }
}
