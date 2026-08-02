/**
 * Every error this SDK throws is an `AgentError`.
 *
 * Two rules hold everywhere in the codebase:
 *   1. A provider's raw error never escapes — it is always wrapped, so callers
 *      can `catch` one type and switch on `.code`.
 *   2. No error message, `cause`, or serialized form ever contains an API key.
 *      Anything that formats request details must run through `util/redact.ts`.
 */

export type AgentErrorCode =
  | 'configuration_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'provider_error'
  | 'network_error'
  | 'timeout_error'
  | 'aborted'
  | 'invalid_tool_input'
  | 'tool_execution_error'
  | 'tool_not_found'
  | 'invalid_schema'

export interface AgentErrorOptions {
  /** Machine-readable discriminator. */
  readonly code: AgentErrorCode
  /** Underlying error, if this wraps one. Never serialized into the message. */
  readonly cause?: unknown
  /** A concrete next action for the developer. Rendered after the message. */
  readonly hint?: string
  /** Whether retrying the identical request could plausibly succeed. */
  readonly retryable?: boolean
  /** Safe-to-log structured context (already redacted). */
  readonly details?: Readonly<Record<string, unknown>>
}

export class AgentError extends Error {
  readonly code: AgentErrorCode
  readonly hint: string | undefined
  readonly retryable: boolean
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(message: string, options: AgentErrorOptions) {
    super(options.hint ? `${message}\n\n→ ${options.hint}` : message, { cause: options.cause })
    this.name = new.target.name
    this.code = options.code
    this.hint = options.hint
    this.retryable = options.retryable ?? false
    this.details = options.details
    // Keeps `instanceof` working when the output is transpiled down to ES5 by a
    // consumer's bundler.
    Object.setPrototypeOf(this, new.target.prototype)
  }

  /** Structured, log-safe representation. Contains no secrets. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

/** Something is wrong with how the SDK was set up — a missing key, a bad option. */
export class ConfigurationError extends AgentError {
  constructor(message: string, options: Omit<AgentErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'configuration_error' })
  }
}

/** The provider rejected our credentials. Never retried automatically. */
export class AuthenticationError extends AgentError {
  constructor(message: string, options: Omit<AgentErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'authentication_error', retryable: false })
  }
}

/** The provider rate-limited us. `retryAfterMs` is populated when it told us. */
export class RateLimitError extends AgentError {
  readonly retryAfterMs: number | undefined

  constructor(
    message: string,
    options: Omit<AgentErrorOptions, 'code'> & { retryAfterMs?: number } = {},
  ) {
    super(message, { ...options, code: 'rate_limit_error', retryable: true })
    this.retryAfterMs = options.retryAfterMs
  }
}

/** The provider returned a non-2xx we could not classify further, or bad JSON. */
export class ProviderError extends AgentError {
  readonly status: number | undefined

  constructor(
    message: string,
    options: Omit<AgentErrorOptions, 'code'> & { status?: number } = {},
  ) {
    super(message, {
      ...options,
      code: 'provider_error',
      retryable: options.retryable ?? isRetryableStatus(options.status),
    })
    this.status = options.status
  }
}

/** `fetch` itself failed — DNS, TLS, connection reset. Always retryable. */
export class NetworkError extends AgentError {
  constructor(message: string, options: Omit<AgentErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'network_error', retryable: true })
  }
}

/** A configured deadline elapsed (whole run, single model call, or one tool). */
export class TimeoutError extends AgentError {
  constructor(message: string, options: Omit<AgentErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'timeout_error', retryable: true })
  }
}

/** The caller's `AbortSignal` fired. Not an error condition of ours. */
export class AbortError extends AgentError {
  constructor(message = 'The run was aborted.', options: Omit<AgentErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'aborted', retryable: false })
  }
}

/** A tool's arguments failed schema validation. Carries per-path issues. */
export class InvalidToolInputError extends AgentError {
  readonly toolName: string
  readonly issues: readonly SchemaIssue[]

  constructor(
    toolName: string,
    issues: readonly SchemaIssue[],
    options: Omit<AgentErrorOptions, 'code'> = {},
  ) {
    super(`Tool "${toolName}" was called with invalid input:\n${formatIssues(issues)}`, {
      ...options,
      code: 'invalid_tool_input',
      details: { toolName, issues },
    })
    this.toolName = toolName
    this.issues = issues
  }
}

/** A tool handler threw. Wrapped so the loop can decide what to do with it. */
export class ToolExecutionError extends AgentError {
  readonly toolName: string

  constructor(toolName: string, options: Omit<AgentErrorOptions, 'code'> = {}) {
    const reason = options.cause instanceof Error ? options.cause.message : String(options.cause)
    super(`Tool "${toolName}" failed: ${reason}`, {
      ...options,
      code: 'tool_execution_error',
      details: { toolName },
    })
    this.toolName = toolName
  }
}

/** The model asked for a tool that is not registered on the agent. */
export class ToolNotFoundError extends AgentError {
  constructor(toolName: string, available: readonly string[]) {
    super(`The model requested an unknown tool "${toolName}".`, {
      code: 'tool_not_found',
      hint:
        available.length > 0
          ? `Tools registered on this agent: ${available.join(', ')}.`
          : 'This agent has no tools registered. Pass `tools` to the Agent constructor.',
      details: { toolName, available },
    })
  }
}

/** A schema could not be understood or converted to JSON Schema. */
export class InvalidSchemaError extends AgentError {
  constructor(message: string, options: Omit<AgentErrorOptions, 'code'> = {}) {
    super(message, { ...options, code: 'invalid_schema' })
  }
}

/**
 * A single validation failure, normalized away from any one validator's shape.
 */
export interface SchemaIssue {
  /** Property path, e.g. `['location', 'city']`. Empty for the root value. */
  readonly path: readonly (string | number)[]
  readonly message: string
}

function formatIssues(issues: readonly SchemaIssue[]): string {
  if (issues.length === 0) return '  (no details provided by the validator)'
  return issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)'
      return `  • ${where}: ${issue.message}`
    })
    .join('\n')
}

function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false
  return status === 408 || status === 409 || status === 429 || status >= 500
}

/** Narrowing helper so callers do not need to import every subclass. */
export function isAgentError(value: unknown): value is AgentError {
  return value instanceof AgentError
}

/**
 * Guarantees callers only ever catch an `AgentError`.
 *
 * Lives here rather than beside the loop because the runner, the retry policy,
 * and the model-call seam all need it, and importing it from the runner would
 * make those modules circular.
 */
export function toAgentError(cause: unknown): AgentError {
  if (cause instanceof AgentError) return cause
  return new AgentError(cause instanceof Error ? cause.message : String(cause), {
    code: 'provider_error',
    cause,
  })
}
