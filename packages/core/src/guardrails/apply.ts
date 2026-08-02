/**
 * Running guardrails. Pure with respect to the run: this module decides, the
 * runner acts on the decision.
 *
 * The one rule that matters here: **a guardrail that throws fails closed.** An
 * exception becomes a rejection, never a silent allow. That is deliberately the
 * opposite of `onEvent` (a throwing listener is swallowed) and of summarizing (a
 * failure falls back to plain trimming) — those are optimisations where losing
 * the feature loses nothing important, whereas a guardrail is a safety control
 * and a broken one must not wave traffic through.
 */

import { GuardrailError, toAgentError } from '../errors/errors.js'
import type { EventEmitter } from '../events/emitter.js'
import type {
  GuardrailContext,
  GuardrailReject,
  GuardrailRewrite,
  GuardrailVerdict,
  InputGuardrail,
  OutputGuardrail,
  OutputGuardrailContext,
} from './types.js'

function isReject<T>(verdict: GuardrailVerdict<T>): verdict is GuardrailReject {
  return 'reject' in verdict
}

function isRewrite<T>(verdict: GuardrailVerdict<T>): verdict is GuardrailRewrite<T> {
  return 'replace' in verdict
}

/** Shared emit + throw, so input and output report identically. */
interface Reporter {
  readonly events: EventEmitter
  readonly runId: string
  readonly agentName: string
  readonly turn: number
}

function reportReject(
  reporter: Reporter,
  stage: 'input' | 'output',
  guardrail: string,
  verdict: GuardrailReject,
  subject: unknown,
): never {
  reporter.events.emit({
    type: 'guardrail.triggered',
    runId: reporter.runId,
    agentName: reporter.agentName,
    turn: reporter.turn,
    guardrail,
    stage,
    action: 'reject',
    reason: verdict.reject,
  })

  throw new GuardrailError(
    { guardrail, stage, reason: verdict.reject, subject },
    verdict.details ? { details: verdict.details } : {},
  )
}

function reportReplace(reporter: Reporter, stage: 'input' | 'output', guardrail: string): void {
  reporter.events.emit({
    type: 'guardrail.triggered',
    runId: reporter.runId,
    agentName: reporter.agentName,
    turn: reporter.turn,
    guardrail,
    stage,
    action: 'replace',
  })
}

/**
 * Calls one guardrail, converting a thrown exception into a rejection.
 *
 * The original error is kept as `cause`, so "my guardrail has a bug" and "my
 * guardrail said no" are distinguishable when you look, while behaving
 * identically when you do not.
 */
async function runCheck<TValue>(
  guardrail: { name: string },
  check: () => GuardrailVerdict<TValue> | Promise<GuardrailVerdict<TValue>>,
  stage: 'input' | 'output',
  subject: unknown,
): Promise<GuardrailVerdict<TValue>> {
  try {
    return await check()
  } catch (cause) {
    const error = toAgentError(cause)
    // Cancellation is the run ending, not a guardrail deciding.
    if (error.code === 'aborted') throw error

    throw new GuardrailError(
      {
        guardrail: guardrail.name,
        stage,
        reason: `the guardrail itself failed (${error.message})`,
        subject,
      },
      { cause },
    )
  }
}

/**
 * Runs the input guardrails in declaration order.
 *
 * Sequential, not `Promise.all`: a rewrite has to be visible to the next
 * guardrail (scrub, *then* length-check), and which rejection you get must be
 * deterministic rather than a race. The cost is a handful of cheap awaits, once
 * per run.
 */
export async function applyInputGuardrails(args: {
  guardrails: readonly InputGuardrail[]
  input: string
  context: GuardrailContext
  reporter: Reporter
}): Promise<string> {
  let value = args.input

  for (const guardrail of args.guardrails) {
    const verdict = await runCheck(
      guardrail,
      () => guardrail.check(value, args.context),
      'input',
      value,
    )

    if (isReject(verdict)) reportReject(args.reporter, 'input', guardrail.name, verdict, value)

    if (isRewrite(verdict)) {
      reportReplace(args.reporter, 'input', guardrail.name)
      value = verdict.replace
    }
  }

  return value
}

/** Same contract as {@link applyInputGuardrails}, against the validated output. */
export async function applyOutputGuardrails<TOutput>(args: {
  guardrails: readonly OutputGuardrail<TOutput>[]
  output: TOutput
  context: OutputGuardrailContext
  reporter: Reporter
}): Promise<{ value: TOutput; replaced: boolean }> {
  let value = args.output
  let replaced = false

  for (const guardrail of args.guardrails) {
    const verdict = await runCheck(
      guardrail,
      () => guardrail.check(value, args.context),
      'output',
      value,
    )

    if (isReject(verdict)) reportReject(args.reporter, 'output', guardrail.name, verdict, value)

    if (isRewrite(verdict)) {
      reportReplace(args.reporter, 'output', guardrail.name)
      value = verdict.replace
      replaced = true
    }
  }

  return { value, replaced }
}
