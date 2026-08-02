/**
 * Every error this SDK throws is an `AgentError`.
 *
 * Two rules hold everywhere in the codebase:
 *   1. A provider's raw error never escapes — it is always wrapped, so callers
 *      can `catch` one type and switch on `.code`.
 *   2. No error message, `cause`, or serialized form ever contains an API key.
 *      Anything that formats request details must run through `util/redact.ts`.
 */

import type { ApprovalSuspension } from '../guardrails/types.js'

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
  | 'invalid_output'
  | 'guardrail_blocked'
  | 'approval_required'

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
 * The model's final answer did not match the agent's `outputSchema`, and the
 * repair budget was spent.
 *
 * The third documented way a *completed* run can throw, alongside a provider
 * failure and `onToolError: 'throw'`. It exists because `outputSchema` is a type
 * contract: returning a `RunResult<Ticket>` whose `output` is really a string
 * the caller's types promise is a `Ticket` is worse than an error naming the
 * field that failed.
 *
 * Never retryable. The transport retry in `run/retry.ts` re-sends an *identical*
 * request, which cannot fix a schema mismatch; repairing is a different request
 * and has its own budget in `maxOutputRetries`.
 */
export class InvalidOutputError extends AgentError {
  readonly issues: readonly SchemaIssue[]

  /**
   * Exactly what the model produced, unparsed.
   *
   * Deliberately *not* in `details`, and so absent from `toJSON()`: `details` is
   * the log-safe form the SSE serializer and the console tracer print, and raw
   * model text is unbounded and can echo back whatever the user pasted in. Read
   * it off the instance when you are debugging.
   */
  readonly rawText: string

  /** Repair attempts made. `0` when `maxOutputRetries` is `0`. */
  readonly attempts: number

  constructor(
    issues: readonly SchemaIssue[],
    rawText: string,
    options: Omit<AgentErrorOptions, 'code'> & { attempts?: number } = {},
  ) {
    const attempts = options.attempts ?? 0
    super(
      issues.length > 0
        ? `The model's output did not match the agent's outputSchema:\n${formatIssues(issues)}`
        : "The model did not return JSON matching the agent's outputSchema.",
      {
        ...options,
        code: 'invalid_output',
        retryable: false,
        hint:
          options.hint ??
          'Raise `maxOutputRetries`, simplify the schema, or use a model with native ' +
            'JSON Schema support. `error.rawText` holds what the model actually said.',
        details: { issues, attempts },
      },
    )
    this.issues = issues
    this.rawText = rawText
    this.attempts = attempts
  }
}

/**
 * A guardrail rejected the run's input or its final answer.
 *
 * A *controlled* failure, not a crash: `retryable` is false, the message is the
 * guardrail's own words, and `guardrail` names which one fired so a trace points
 * at the policy rather than at the runtime.
 *
 * Tool guardrails do **not** raise this. A blocked tool call becomes a tool
 * result the model reads and routes around, because aborting a whole run over
 * one refused call throws away work the user already paid for. See
 * `ToolCallOutcome.blockedBy`.
 */
export class GuardrailError extends AgentError {
  readonly guardrail: string
  readonly stage: 'input' | 'output'

  /**
   * What the guardrail was looking at.
   *
   * Deliberately not in `details`, and so absent from `toJSON()` — the same rule
   * as {@link InvalidOutputError.rawText}. A rejected input is unbounded and is
   * very often whatever the user just pasted in.
   */
  readonly subject: unknown

  constructor(
    args: {
      guardrail: string
      stage: 'input' | 'output'
      reason: string
      subject: unknown
    },
    options: Omit<AgentErrorOptions, 'code'> = {},
  ) {
    super(`Guardrail "${args.guardrail}" blocked this run's ${args.stage}: ${args.reason}`, {
      ...options,
      code: 'guardrail_blocked',
      retryable: false,
      details: { ...options.details, guardrail: args.guardrail, stage: args.stage },
    })
    this.guardrail = args.guardrail
    this.stage = args.stage
    this.subject = args.subject
  }
}

/**
 * A tool guardrail asked for a human, and the run suspended before executing
 * anything.
 *
 * Not a failure — a designed pause. It throws rather than returning because a
 * suspended run has no output, and `RunResult<Ticket>` whose `output` is not a
 * `Ticket` is the exact lie {@link InvalidOutputError} exists to prevent.
 * Throwing also means `stream()`, `session().run()`, and `resumable()` all
 * support approval with no change to their types.
 *
 * `suspension` is plain JSON. Keep it server-side — it holds the conversation —
 * and send whoever decides only `suspension.pending`.
 */
export class ApprovalRequiredError extends AgentError {
  readonly suspension: ApprovalSuspension

  constructor(suspension: ApprovalSuspension, options: Omit<AgentErrorOptions, 'code'> = {}) {
    const names = suspension.pending.calls.map((call) => call.toolName)
    super(
      `Waiting on approval for ${names.length} tool call${names.length === 1 ? '' : 's'}: ` +
        `${names.join(', ')}.`,
      {
        ...options,
        code: 'approval_required',
        retryable: false,
        hint:
          options.hint ??
          'Decide on `error.suspension.pending.calls`, then call ' +
            'agent.resumeApproval(error.suspension, decisions).',
        // `messages` must never reach here: `details` is the log-safe form the
        // console tracer and the SSE serializer both print, and it holds the
        // entire conversation.
        details: { toolNames: names, count: names.length },
      },
    )
    this.suspension = suspension
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
