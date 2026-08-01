/**
 * Environment access that does not assume Node.
 *
 * `process` is absent in browsers, Cloudflare Workers, and some edge runtimes.
 * Reading it through this helper means importing the SDK never throws there — a
 * provider only fails, with a clear message, if you actually try to use it
 * without passing an explicit key.
 */
export function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env
  return env?.[name]
}

/** Reads the first environment variable that is set and non-empty. */
export function readFirstEnv(...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = readEnv(name)
    if (value && value.length > 0) return value
  }
  return undefined
}
