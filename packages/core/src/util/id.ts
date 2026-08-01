/**
 * Identifier generation.
 *
 * Uses `crypto.randomUUID` when available (Node 19+, all modern browsers, Bun,
 * Deno, Cloudflare Workers) and falls back to `Math.random` only where it is
 * not. Ids are for correlation in logs and traces, never for security, so the
 * fallback is acceptable.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function randomSuffix(length: number): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined

  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(length)
    cryptoApi.getRandomValues(bytes)
    let out = ''
    for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
    return out
  }

  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return out
}

/**
 * A sortable, prefixed id — e.g. `run_m9x2k1p_a7f3z9`.
 *
 * The middle segment is a base-36 timestamp, so ids sort chronologically as
 * strings. That makes a directory of trace files or log lines readable without
 * parsing anything.
 */
export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${randomSuffix(6)}`
}

export function createRunId(): string {
  return createId('run')
}

export function createToolCallId(): string {
  return createId('call')
}

export function createEventId(): string {
  return createId('evt')
}
