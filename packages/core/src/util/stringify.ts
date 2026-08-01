/**
 * Turning an unknown value into a string, safely.
 *
 * Needed in two places where the value's type genuinely cannot be known: a tool's
 * return value on its way to the model, and a traced value on its way to a
 * terminal. Plain `String(value)` is wrong for both — it yields
 * `'[object Object]'`, which destroys the information the model or the developer
 * needed.
 */
export function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  if (value instanceof Error) return `${value.name}: ${value.message}`

  try {
    const json = JSON.stringify(value)
    if (json !== undefined) return json
  } catch {
    // Circular, or a BigInt nested inside an object — fall through.
  }

  // Last resort: a description rather than a misleading '[object Object]'.
  if (typeof value === 'object') {
    const name = (value.constructor as { name?: string } | undefined)?.name ?? 'Object'
    return `[unserializable ${name}]`
  }
  return `[${typeof value}]`
}
