import type { ModelProvider } from '../providers/provider.js'
import { textOf } from '../providers/provider.js'
import { userMessage } from '../types/messages.js'
import type { ModelMessage } from '../types/messages.js'
import { safeStringify } from '../util/stringify.js'

/**
 * Folding the beginning of a conversation into a recap, so a long session stops
 * losing its own history to trimming.
 *
 * The summary is **a normal message in the transcript**, not metadata. It
 * survives every adapter with no schema change, it round-trips, and it costs one
 * appended row rather than a second place to persist things.
 */

/** How to summarize. `true` on {@link ContextPolicy.summarize} means all defaults. */
export interface SummarizeOptions {
  /** Model to summarize with. Defaults to the agent's own. */
  readonly model?: ModelProvider

  /**
   * Replaces the default instruction. The messages to compress arrive as a
   * single user turn after it.
   */
  readonly prompt?: string

  /**
   * How much recent history to keep verbatim after a fold. Default: **half the
   * context budget**.
   *
   * This is hysteresis, and it is the difference between summarizing
   * occasionally and summarizing on every single run. Folding back to exactly
   * the budget leaves no headroom: the next turn is over it again, and pays for
   * another summary. Folding to half leaves room for several turns of growth.
   *
   * Expressed in the same unit as the policy that triggered the fold — messages
   * for `maxMessages`, tokens for `maxTokens`.
   */
  readonly keepRecent?: number

  /** Ceiling on the summary itself. Default 512. */
  readonly maxOutputTokens?: number

  /** Deadline for the summarizing call. Default 30_000. */
  readonly timeoutMs?: number
}

const DEFAULT_MAX_OUTPUT_TOKENS = 512
const DEFAULT_TIMEOUT_MS = 30_000

const DEFAULT_PROMPT = [
  'You compress the earlier part of a conversation so it can be dropped from the',
  'context window without losing what matters.',
  '',
  'Write a dense third-person summary. Preserve: facts the user stated about',
  'themselves, decisions reached, constraints and preferences, identifiers and',
  'names, and anything the assistant promised to do. Drop: pleasantries,',
  'restatements, and the exact wording.',
  '',
  'Write only the summary. No preamble, no headings, no bullet list unless the',
  'content is genuinely a list.',
].join('\n')

/**
 * The first line of a summary message.
 *
 * It carries the watermark — how many messages from the start of the log this
 * summary stands in for — because position alone cannot say. The summary is
 * *appended*, so it physically sits at the end of an append-only log while
 * standing in for the beginning of it; without the count there is no way to know
 * where verbatim history resumes.
 *
 * It is also plain English, so the model reads it as useful framing rather than
 * as a stray token.
 */
const SUMMARY_HEADER = /^\[Summary of the first (\d+) messages of this conversation\]\n/

function summaryHeader(covered: number): string {
  return `[Summary of the first ${covered} messages of this conversation]\n`
}

/** Builds the message that stands in for `covered` earlier messages. */
export function summaryMessage(covered: number, text: string): ModelMessage {
  return userMessage(`${summaryHeader(covered)}${text}`)
}

/** How many messages this summary replaces, or `undefined` if it is not one. */
export function summaryWatermark(message: ModelMessage): number | undefined {
  if (message.role !== 'user' || typeof message.content !== 'string') return undefined
  const match = SUMMARY_HEADER.exec(message.content)
  if (!match?.[1]) return undefined
  const covered = Number(match[1])
  return Number.isInteger(covered) && covered >= 0 ? covered : undefined
}

export function isSummaryMessage(message: ModelMessage): boolean {
  return summaryWatermark(message) !== undefined
}

/**
 * The history a run should start from, given a stored transcript that may
 * already contain a summary.
 *
 * Returns the newest summary followed by everything it does *not* cover. Stale
 * summaries — from an older fold, or from a concurrent run that folded at the
 * same time — are discarded rather than sent twice.
 */
export function applySummary(stored: readonly ModelMessage[]): readonly ModelMessage[] {
  let newest: ModelMessage | undefined
  let covered = 0

  for (const message of stored) {
    const watermark = summaryWatermark(message)
    // The highest watermark wins, not the last one: two concurrent runs can each
    // append a summary, and the one covering more is the more recent fold.
    if (watermark !== undefined && watermark >= covered) {
      newest = message
      covered = watermark
    }
  }

  if (!newest) return stored

  const verbatim = stored.slice(covered).filter((message) => !isSummaryMessage(message))
  return [newest, ...verbatim]
}

/**
 * Compresses `messages` into one summary message standing in for the first
 * `covered` messages of the log.
 *
 * Throws on failure — deliberately. The caller decides that a failed summary is
 * survivable and falls back to plain trimming; that judgement does not belong
 * down here.
 */
export async function summarizeMessages(args: {
  readonly messages: readonly ModelMessage[]
  readonly covered: number
  readonly model: ModelProvider
  readonly options: SummarizeOptions
  readonly signal: AbortSignal
}): Promise<ModelMessage> {
  const { messages, covered, model, options, signal } = args

  const response = await model.generate(
    {
      system: options.prompt ?? DEFAULT_PROMPT,
      messages: [userMessage(renderTranscript(messages))],
      maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    },
    { signal, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  )

  const text = textOf(response).trim()
  if (text.length === 0) {
    throw new Error('The summarizing model returned no text.')
  }

  return summaryMessage(covered, text)
}

/**
 * Flattens a transcript into something a model can read in one turn.
 *
 * Tool calls and results are included in shortened form: what the agent *did* is
 * often the part worth remembering, and a summary that mentions only the prose
 * loses it.
 */
function renderTranscript(messages: readonly ModelMessage[]): string {
  const lines: string[] = []

  for (const message of messages) {
    if (message.role === 'system') continue

    if (typeof message.content === 'string') {
      lines.push(`${message.role}: ${message.content}`)
      continue
    }

    for (const part of message.content) {
      if (part.type === 'text') lines.push(`${message.role}: ${part.text}`)
      else if (part.type === 'tool-call') {
        lines.push(`${message.role}: [called ${part.toolName} with ${truncate(part.input)}]`)
      } else if (part.type === 'tool-result') {
        const outcome = part.isError ? 'failed' : 'returned'
        lines.push(`tool ${part.toolName} ${outcome}: ${truncate(part.output)}`)
      }
    }
  }

  return lines.join('\n')
}

/** Tool payloads can be enormous; a summary needs their shape, not their bulk. */
function truncate(value: unknown, maxLength = 300): string {
  const text = safeStringify(value)
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`
}
