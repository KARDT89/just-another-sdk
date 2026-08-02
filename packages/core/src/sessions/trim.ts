import type { ModelMessage } from '../types/messages.js'
import type { SummarizeOptions } from './summarize.js'

/**
 * How much conversation to carry into a run.
 *
 * Applied to history at the run boundary — whether it came from a
 * {@link SessionStore} or from `options.messages`. Without one, a long-running
 * session costs more every single turn until the provider rejects the request.
 *
 * ```ts
 * const agent = new Agent({
 *   name: 'support',
 *   model,
 *   session: fileSession('./.sessions'),
 *   context: { maxTokens: 30_000 },
 * })
 * ```
 *
 * Both limits may be set; whichever bites first wins.
 */
export interface ContextPolicy {
  /** Keep at most this many messages, counting from the newest. */
  readonly maxMessages?: number

  /**
   * Keep at most this many tokens of history.
   *
   * This is a budget for *history*, not for the whole request: the system
   * prompt, tool definitions, and the incoming user turn are on top of it.
   * Leave headroom.
   */
  readonly maxTokens?: number

  /**
   * Replace what trimming drops with a model-written recap, instead of losing
   * it.
   *
   * `true` uses the agent's own model and the built-in prompt; an object
   * overrides either. Requires a session — the summary is persisted so it is
   * written once and reused, rather than paid for on every run.
   *
   * The summary becomes a message in the transcript. Nothing is deleted: the
   * original messages stay in the store, and `chat.messages()` still returns
   * them.
   *
   * **A failed summary never fails the run.** If the summarizing call errors or
   * times out, the run falls back to plain trimming and `session.summarize`
   * carries the error.
   */
  readonly summarize?: boolean | SummarizeOptions

  /**
   * Replaces the built-in estimator.
   *
   * The default is a rough `characters / 4` heuristic, because a real tokenizer
   * is a multi-megabyte dependency and this SDK ships none. It is close enough
   * to keep a conversation inside a window and wrong enough that you should pass
   * your provider's real counter when precision matters:
   *
   * ```ts
   * context: { maxTokens: 30_000, countTokens: (m) => myTokenizer.count(m) }
   * ```
   */
  readonly countTokens?: (message: ModelMessage) => number
}

/** Per-message wire overhead — role, delimiters, and the like. */
const MESSAGE_OVERHEAD_TOKENS = 4

/** Bytes per token, averaged over English prose. Deliberately approximate. */
const CHARS_PER_TOKEN = 4

/**
 * The default token estimate: message length in characters over four.
 *
 * Exported so callers can see what they are replacing, and so tests can assert
 * against the same number the runtime uses.
 */
export function estimateTokens(message: ModelMessage): number {
  const text =
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  return Math.ceil(text.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS
}

/**
 * Drops the oldest messages until the history fits the policy.
 *
 * Three rules, each with a test:
 *
 *   1. **Only the oldest go.** Recency is what a model needs; the beginning of a
 *      conversation is what it can most afford to lose.
 *   2. **No orphaned tool results.** A `tool` message whose originating
 *      assistant `tool-call` has been dropped is a protocol error at every
 *      provider, so the head is advanced past any leading `tool` message.
 *   3. **The newest message always survives**, even alone and even over budget.
 *      Returning an empty history because one message exceeds the budget would
 *      turn a config mistake into an unanswerable request.
 *
 * `system` messages are not handled here because they never appear in this list:
 * instructions are re-derived from the agent on every run and hoisted into the
 * provider's system field.
 */
export function trimHistory(
  messages: readonly ModelMessage[],
  policy: ContextPolicy | undefined,
): readonly ModelMessage[] {
  if (!policy || messages.length === 0) return messages
  const { maxMessages, maxTokens } = policy
  if (maxMessages === undefined && maxTokens === undefined) return messages

  let start = 0

  if (maxMessages !== undefined && messages.length > maxMessages) {
    start = messages.length - Math.max(1, maxMessages)
  }

  if (maxTokens !== undefined) {
    const countTokens = policy.countTokens ?? estimateTokens
    let total = 0

    // Walk backwards from the newest, accumulating until the budget is spent.
    // `budgetStart` is the oldest index that still fits.
    let budgetStart = messages.length - 1
    for (let i = messages.length - 1; i >= start; i -= 1) {
      const message = messages[i]
      if (!message) continue
      total += countTokens(message)
      if (total > maxTokens && i < messages.length - 1) break
      budgetStart = i
    }

    start = Math.max(start, budgetStart)
  }

  // Rule 2: never begin on a tool result whose call has just been dropped.
  while (start < messages.length - 1 && messages[start]?.role === 'tool') {
    start += 1
  }

  return start === 0 ? messages : messages.slice(start)
}
