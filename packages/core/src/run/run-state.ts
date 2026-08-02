import { addUsage, ZERO_USAGE } from '../types/messages.js'
import type { ModelMessage, Usage } from '../types/messages.js'
import type { RunStep } from './result.js'

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

  /** Completed model calls. `turn` in events is `turns + 1`. */
  private turnCount = 0
  private usageTotal: Usage = ZERO_USAGE
  private lastModelId: string

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

  get steps(): readonly RunStep[] {
    return [...this.stepLog]
  }

  get messageCount(): number {
    return this.messageLog.length
  }

  append(...messages: readonly ModelMessage[]): void {
    this.messageLog.push(...messages)
  }

  /** Records a completed turn: its step, its usage, and the serving model. */
  completeTurn(step: RunStep): void {
    this.stepLog.push(step)
    this.usageTotal = addUsage(this.usageTotal, step.usage)
    this.lastModelId = step.modelId
    this.turnCount += 1
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
