/**
 * Secret redaction.
 *
 * Every path that could put request details into an error message, an event, or
 * a log line goes through here first. The rule the SDK holds itself to: an API
 * key must never appear in a thrown error, an emitted event, or a trace.
 *
 * This is defence in depth, not the primary mechanism — providers simply do not
 * put credentials into error messages. But a stray `JSON.stringify(headers)` in
 * a future contribution should fail safe, and there is a test asserting it does.
 */

const REDACTED = '[redacted]'

/** Header names whose values are never shown, compared case-insensitively. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
])

/** Object keys whose values are never shown, compared case-insensitively. */
const SENSITIVE_KEYS = new Set([
  'apikey',
  'api_key',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'password',
  'secret',
  'clientsecret',
  'client_secret',
  'token',
  'bearer',
])

/**
 * Patterns for keys that leak even when the field name is innocuous — matched
 * against string *values*. Covers the common vendor prefixes.
 */
const KEY_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI, OpenRouter (sk-or-...)
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /\bAIza[A-Za-z0-9_-]{20,}/g, // Google
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g, // Slack
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, // any bearer token
]

/** Replaces anything that looks like a credential inside a free-text string. */
export function redactString(value: string): string {
  let out = value
  for (const pattern of KEY_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED)
  }
  return out
}

/** Returns a copy of `headers` with sensitive values replaced. */
export function redactHeaders(
  headers: Readonly<Record<string, string>> | Headers | undefined,
): Record<string, string> {
  if (!headers) return {}

  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers)

  const out: Record<string, string> = {}
  for (const [name, value] of entries) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : redactString(value)
  }
  return out
}

/**
 * Deep-redacts an arbitrary value for logging.
 *
 * Cyclic references are collapsed to `'[circular]'` and the walk is depth-capped,
 * so this is always safe to call on a provider payload of unknown shape.
 */
export function redact(value: unknown, maxDepth = 6): unknown {
  return walk(value, maxDepth, new WeakSet())
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value)

  if (value === null || typeof value !== 'object') return value

  if (seen.has(value)) return '[circular]'
  if (depth <= 0) return '[truncated]'
  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth - 1, seen))
  }

  if (value instanceof Headers) return redactHeaders(value)

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) }
  }

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z_]/g, ''))
      ? REDACTED
      : walk(item, depth - 1, seen)
  }
  return out
}
