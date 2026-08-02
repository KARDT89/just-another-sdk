/**
 * What a model is allowed to make the process connect to.
 *
 * This is the security boundary of the whole tool pack. A tool that fetches a
 * URL a model chose is a **server-side request forgery primitive**: point it at
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/` and it
 * reads your cloud role's credentials and hands them to the model, which may
 * then put them in a reply. The model does not have to be adversarial for this
 * to happen — a prompt injection in a fetched page is enough.
 *
 * So the rules here are deliberately unfriendly:
 *
 *   1. **An allowlist is required.** No default, no "just this once". An
 *      unconfigured fetch tool fetches nothing and says why.
 *   2. **Private, loopback, and link-local addresses are refused even when the
 *      allowlist says `*`.** The allowlist is about intent; this is about the
 *      blast radius when intent is wrong.
 *   3. **Every redirect hop is re-checked.** An allowed host that 302s to
 *      `127.0.0.1` is the oldest trick there is.
 *
 * @see The documented limitation on DNS at {@link assertAllowedUrl}.
 */

import { ConfigurationError } from '../../errors/errors.js'

export interface UrlPolicy {
  /**
   * Hostnames the tool may connect to. **Required**, and an empty list means
   * nothing is reachable.
   *
   * A leading `*.` matches subdomains: `*.wikipedia.org` allows
   * `en.wikipedia.org` but not `wikipedia.org.evil.com`. A bare `*` allows any
   * host — still subject to the address rules below, and still a decision you
   * had to make on purpose.
   */
  readonly allow: readonly string[]

  /** Cap on the response body, in bytes. Default 1,000,000. */
  readonly maxBytes?: number

  /** How many redirects to follow, each re-checked. Default 3. */
  readonly maxRedirects?: number

  /** Methods the model may use. Default `['GET', 'HEAD']`. */
  readonly methods?: readonly string[]

  /** Headers attached to every request — an API key, a User-Agent. */
  readonly headers?: Readonly<Record<string, string>>

  /** Per-request deadline in ms. Default 15,000. */
  readonly timeoutMs?: number

  /** Injectable for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch
}

export interface ResolvedPolicy {
  readonly allow: readonly string[]
  readonly maxBytes: number
  readonly maxRedirects: number
  readonly methods: readonly string[]
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly fetch: typeof globalThis.fetch
}

export const POLICY_DEFAULTS = Object.freeze({
  maxBytes: 1_000_000,
  maxRedirects: 3,
  methods: Object.freeze(['GET', 'HEAD']),
  timeoutMs: 15_000,
})

/** Refused regardless of the allowlist. Thrown by {@link assertAllowedUrl}. */
export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BlockedUrlError'
  }
}

/**
 * Validates the policy itself, at construction time.
 *
 * A fetch tool built without an allowlist is a configuration mistake, not a
 * runtime condition — so it fails where the developer wrote it, the same way a
 * tool guardrail naming an unregistered tool does.
 */
export function resolvePolicy(policy: UrlPolicy, toolName: string): ResolvedPolicy {
  if (!policy || !Array.isArray(policy.allow)) {
    throw new ConfigurationError(`${toolName} needs an \`allow\` list of hostnames.`, {
      hint:
        "Pass the hosts this agent may reach, e.g. { allow: ['api.example.com'] }. " +
        "Use ['*'] only if you have egress controls elsewhere — a model that can " +
        'fetch any URL can be talked into fetching yours.',
      details: { toolName },
    })
  }

  const fetchImpl = policy.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new ConfigurationError(`${toolName} needs a \`fetch\` implementation.`, {
      hint: 'This runtime has no global fetch. Pass one on the tool options.',
      details: { toolName },
    })
  }

  return {
    allow: policy.allow,
    maxBytes: policy.maxBytes ?? POLICY_DEFAULTS.maxBytes,
    maxRedirects: policy.maxRedirects ?? POLICY_DEFAULTS.maxRedirects,
    methods: (policy.methods ?? POLICY_DEFAULTS.methods).map((m) => m.toUpperCase()),
    headers: policy.headers ?? {},
    timeoutMs: policy.timeoutMs ?? POLICY_DEFAULTS.timeoutMs,
    fetch: fetchImpl,
  }
}

/**
 * Hostnames that are never reachable, whatever the allowlist says.
 *
 * `metadata.google.internal` is here because it is a *name*, not an address —
 * the numeric checks below would not catch it.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
])

/**
 * Checks a URL against the policy.
 *
 * > **The limitation, stated rather than papered over.** This refuses dangerous
 * > *literals* — `127.0.0.1`, `10.0.0.5`, `169.254.169.254`, `[::1]`. It cannot
 * > catch `evil.com` that *resolves* to one of those, because that needs DNS and
 * > `node:dns` does not exist on edge runtimes, which this package supports.
 * > Combined with the allowlist that gap is small: you have to have allowed the
 * > attacker's hostname. It is still not a substitute for egress rules on a host
 * > with secrets on its private network.
 *
 * @throws {BlockedUrlError} with a reason the model can read and act on.
 */
export function assertAllowedUrl(raw: string, policy: ResolvedPolicy): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new BlockedUrlError(`"${raw}" is not a valid absolute URL.`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(
      `The "${url.protocol.replace(':', '')}" scheme is not allowed; use http or https.`,
    )
  }

  // Credentials in the URL are a way to smuggle a different authority past a
  // careless allowlist check, and nothing legitimate needs them here.
  if (url.username !== '' || url.password !== '') {
    throw new BlockedUrlError('URLs with embedded credentials are not allowed.')
  }

  const hostname = url.hostname.toLowerCase()

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new BlockedUrlError(`"${hostname}" is a local address and is never reachable.`)
  }

  const literal = blockedAddressReason(hostname)
  if (literal) {
    throw new BlockedUrlError(
      `${hostname} is ${literal}. Private, loopback, and link-local addresses are ` +
        'refused even when the allowlist permits them.',
    )
  }

  if (!isAllowedHost(hostname, policy.allow)) {
    throw new BlockedUrlError(
      policy.allow.length === 0
        ? `No hosts are allowed, so ${hostname} cannot be reached. Configure the tool's \`allow\` list.`
        : `${hostname} is not in the allowed list: ${policy.allow.join(', ')}.`,
    )
  }

  return url
}

function isAllowedHost(hostname: string, allow: readonly string[]): boolean {
  return allow.some((pattern) => {
    const entry = pattern.trim().toLowerCase()
    if (entry === '*') return true

    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1) // ".example.com"
      // The suffix form must not also match the bare apex, and must match on a
      // dot boundary — otherwise `*.example.com` would allow `notexample.com`.
      return hostname.endsWith(suffix) && hostname.length > suffix.length
    }

    return hostname === entry
  })
}

/**
 * Names the reason an address literal is refused, or `undefined` if it is not
 * one.
 *
 * Returns prose rather than a boolean so the error can tell the model *why* —
 * "is a loopback address" is something it can reason about; "is blocked" is not.
 */
function blockedAddressReason(hostname: string): string | undefined {
  const ipv6 = hostname.startsWith('[') ? hostname.slice(1, -1) : undefined
  if (ipv6 !== undefined || hostname.includes(':')) {
    return blockedIpv6Reason(ipv6 ?? hostname)
  }

  const octets = hostname.split('.')
  if (octets.length !== 4) return undefined

  const parsed = octets.map((part) => (/^\d{1,3}$/u.test(part) ? Number(part) : Number.NaN))
  if (parsed.some((n) => Number.isNaN(n) || n > 255)) return undefined

  const [a, b] = parsed as [number, number, number, number]

  if (a === 127) return 'a loopback address'
  if (a === 0) return 'an unspecified address'
  if (a === 10) return 'a private address'
  if (a === 172 && b >= 16 && b <= 31) return 'a private address'
  if (a === 192 && b === 168) return 'a private address'
  // 169.254.169.254 lives here — the cloud instance metadata endpoint on AWS,
  // Azure, and DigitalOcean, and the single most valuable SSRF target there is.
  if (a === 169 && b === 254) return 'a link-local address (cloud metadata)'
  if (a === 100 && b >= 64 && b <= 127) return 'a carrier-grade NAT address'
  if (a >= 224) return 'a multicast or reserved address'

  return undefined
}

function blockedIpv6Reason(address: string): string | undefined {
  const normalized = address.toLowerCase()

  if (normalized === '::1') return 'the IPv6 loopback address'
  if (normalized === '::') return 'the IPv6 unspecified address'
  // fc00::/7 — unique local. fe80::/10 — link-local.
  if (/^f[cd][0-9a-f]{0,2}:/u.test(normalized)) return 'an IPv6 unique-local address'
  if (/^fe[89ab][0-9a-f]?:/u.test(normalized)) return 'an IPv6 link-local address'
  // ::ffff:127.0.0.1 and friends — an IPv4 address wearing an IPv6 hat.
  if (normalized.startsWith('::ffff:')) {
    const dotted = mappedIpv4(normalized.slice(7))
    const mapped = dotted ? blockedAddressReason(dotted) : undefined
    return mapped ? `an IPv4-mapped address for ${mapped}` : undefined
  }

  return undefined
}

/**
 * The IPv4 address inside an `::ffff:` mapping, in dotted form.
 *
 * The reason this is not a one-line `slice`: **`new URL()` rewrites the dotted
 * quad into hex**. `http://[::ffff:127.0.0.1]/` arrives here as
 * `::ffff:7f00:1`, so a check that only understood `127.0.0.1` would wave
 * loopback straight through. A test plants exactly that URL.
 */
function mappedIpv4(rest: string): string | undefined {
  if (/^\d{1,3}(\.\d{1,3}){3}$/u.test(rest)) return rest

  const groups = rest.split(':').filter((group) => group !== '')
  if (groups.length === 0 || groups.length > 2) return undefined
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/u.test(group))) return undefined

  const [high, low] =
    groups.length === 2
      ? [parseInt(groups[0] as string, 16), parseInt(groups[1] as string, 16)]
      : [0, parseInt(groups[0] as string, 16)]

  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`
}
