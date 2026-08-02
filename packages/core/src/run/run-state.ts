import { addUsage, textPart, ZERO_USAGE } from '../types/messages.js'
import type { ModelMessage, Usage } from '../types/messages.js'
import type { RunStep } from './result.js'

/**
 * What a caller supplies when recording a step.
 *
 * `kind` and `agentName` are filled in by the recording method rather than at
 * the call site: the loop only ever produces turns, and the acting agent is
 * something this object already knows. Passing either would be a chance to pass
 * it wrong.
 */
type StepInput = Omit<RunStep, 'kind' | 'agentName'>

/**
 * The mutable state of a single run.
 *
 * This is the *only* mutable object in the SDK's hot path, and it is created
 * fresh per `run()` call. That is what makes one `Agent` instance safe to share
 * across concurrent requests: the agent holds configuration, this holds
 * everything that changes.
 *
 * Nothing here is persisted. Cross-run durability is the job of the `Session`
 * layer, which reads and writes `messages` at the run boundary.
 */
export class RunState {
  readonly runId: string
  readonly agentName: string
  readonly startedAt: number

  /** The conversation, appended to as the run proceeds. */
  private readonly messageLog: ModelMessage[]
  private readonly stepLog: RunStep[] = []

  /**
   * What the *model* sees, when that differs from the full log.
   *
   * `undefined` until a handoff with a `filter` narrows the context, which is
   * the overwhelmingly common case — the default path allocates nothing and
   * behaves exactly as it did before handoffs existed. Once set, `append` writes
   * to both: the log is what gets persisted and returned, the view is what gets
   * sent.
   */
  private viewLog: ModelMessage[] | undefined

  /** Completed model calls. `turn` in events is `turns + 1`. */
  private turnCount = 0
  private usageTotal: Usage = ZERO_USAGE
  private lastModelId: string

  /** Every agent that has acted, in order. Append-only, like the message log. */
  private readonly path: string[]
  private handoffs = 0

  constructor(args: {
    runId: string
    agentName: string
    modelId: string
    messages: readonly ModelMessage[]
  }) {
    this.runId = args.runId
    this.agentName = args.agentName
    this.startedAt = Date.now()
    this.messageLog = [...args.messages]
    this.lastModelId = args.modelId
    this.path = [args.agentName]
  }

  /** The agent currently acting. Changes when a handoff is accepted. */
  get activeAgentName(): string {
    return this.path[this.path.length - 1] ?? this.agentName
  }

  /** `['triage', 'billing']` — the route the run took. */
  get agentPath(): readonly string[] {
    return [...this.path]
  }

  /** Transfers accepted so far, checked against `maxHandoffs`. */
  get handoffCount(): number {
    return this.handoffs
  }

  /** True when this agent has already acted in this run — an `A → B → A` cycle. */
  hasVisited(agentName: string): boolean {
    return this.path.includes(agentName)
  }

  /**
   * Records an accepted transfer, optionally narrowing what the receiving agent
   * sees.
   *
   * `carried` replaces the **view**, never the log. A handoff must not be able
   * to delete history: the session still persists everything, and
   * `result.messages` still round-trips into a new run.
   */
  switchAgent(agentName: string, carried?: readonly ModelMessage[]): void {
    this.path.push(agentName)
    this.handoffs += 1
    if (carried) this.viewLog = [...carried]
  }

  get turns(): number {
    return this.turnCount
  }

  /** 1-based number of the turn currently being executed. */
  get currentTurn(): number {
    return this.turnCount + 1
  }

  get usage(): Usage {
    return this.usageTotal
  }

  get modelId(): string {
    return this.lastModelId
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt
  }

  /** A snapshot. Callers cannot mutate the run through it. */
  get messages(): readonly ModelMessage[] {
    return [...this.messageLog]
  }

  /**
   * What the next model call should send.
   *
   * Identical to {@link messages} unless a handoff narrowed the context. Reading
   * the two through different accessors is what keeps "the model sees less" and
   * "the session stores everything" from being the same decision.
   */
  get view(): readonly ModelMessage[] {
    return this.viewLog ? [...this.viewLog] : [...this.messageLog]
  }

  get viewCount(): number {
    return (this.viewLog ?? this.messageLog).length
  }

  get steps(): readonly RunStep[] {
    return [...this.stepLog]
  }

  get messageCount(): number {
    return this.messageLog.length
  }

  append(...messages: readonly ModelMessage[]): void {
    this.messageLog.push(...messages)
    this.viewLog?.push(...messages)
  }

  /**
   * Records a completed turn: its step, its usage, and the serving model.
   *
   * `kind` is filled in here rather than at the call site so that the loop body
   * stays literal — the loop only ever produces turns.
   */
  completeTurn(step: StepInput): void {
    this.stepLog.push({ ...step, kind: 'turn', agentName: this.activeAgentName })
    this.usageTotal = addUsage(this.usageTotal, step.usage)
    this.lastModelId = step.modelId
    this.turnCount += 1
  }

  /**
   * Records an output-repair call: its step and its cost, but **not** a turn.
   *
   * A repair is a real model call, so leaving it out would make `usage` wrong
   * and make a fallback during repair invisible. It is not a loop turn, so
   * counting it would push `result.turns` past the `maxTurns` the config
   * promises. See {@link RunStep.kind}.
   */
  completeRepair(step: StepInput): void {
    this.stepLog.push({ ...step, kind: 'repair', agentName: this.activeAgentName })
    this.usageTotal = addUsage(this.usageTotal, step.usage)
    this.lastModelId = step.modelId
  }

  /**
   * Records tool calls carried over from a suspended run and executed before
   * this run's first turn.
   *
   * Neither a turn nor a model call: `usage` is untouched because nothing was
   * generated, and `turnCount` is untouched because the calls belong to a turn
   * that happened in the run that suspended. See {@link RunStep.kind}.
   */
  completeResume(step: StepInput): void {
    this.stepLog.push({ ...step, kind: 'resume', agentName: this.activeAgentName })
  }

  /**
   * Rewrites the run's final answer in place.
   *
   * The **one** place the log is edited rather than appended to, and it earns
   * the exception: an output guardrail that scrubs PII has to scrub it from
   * `messages` too. Otherwise the session stores the original, hands it back on
   * the next turn, and `result.output` and `result.messages` disagree about what
   * the agent said.
   *
   * The matching step's `text` is updated with it, so `steps` and `messages`
   * cannot drift.
   */
  replaceFinalText(text: string): void {
    for (let i = this.messageLog.length - 1; i >= 0; i -= 1) {
      const message = this.messageLog[i]
      if (message?.role !== 'assistant') continue

      const hasText = message.content.some((part) => part.type === 'text')
      if (!hasText) continue

      // Non-text parts are preserved: an assistant turn can carry tool calls
      // alongside its text, and dropping them would break the conversation.
      const rewritten = message.content.filter((part) => part.type !== 'text')
      const replacement: ModelMessage = { ...message, content: [textPart(text), ...rewritten] }
      this.messageLog[i] = replacement

      // The same message object is in the view when a handoff narrowed the
      // context, and a repair reads the view. Patching by identity rather than
      // by index because the two logs are not aligned after a filter.
      if (this.viewLog) {
        const viewIndex = this.viewLog.lastIndexOf(message)
        if (viewIndex !== -1) this.viewLog[viewIndex] = replacement
      }

      const stepIndex = this.stepLog.findLastIndex((step) => step.text.length > 0)
      const step = this.stepLog[stepIndex]
      if (step) this.stepLog[stepIndex] = { ...step, text }
      return
    }
  }

  /**
   * Text of the most recent assistant message. This is the run's answer, and it
   * is read from the log rather than tracked separately so that it stays correct
   * no matter how the loop terminated.
   */
  finalText(): string {
    for (let i = this.messageLog.length - 1; i >= 0; i -= 1) {
      const message = this.messageLog[i]
      if (message?.role !== 'assistant') continue

      const text = message.content
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('')

      if (text.length > 0) return text
    }
    return ''
  }
}
