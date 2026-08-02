import type { AgentEvent, EventListener } from './events.js'
import { redact } from '../util/redact.js'
import { safeStringify } from '../util/stringify.js'

export interface ConsoleTracerOptions {
  /** Include per-turn model text. Default `false` — the final answer is enough. */
  readonly verbose?: boolean
  /** Emit ANSI colour. Default: on unless `NO_COLOR` is set. */
  readonly color?: boolean
  /** Where to write. Default `console.log`. */
  readonly write?: (line: string) => void
  /** Truncate rendered tool input/output to this many characters. Default 120. */
  readonly maxValueLength?: number
}

/**
 * A ready-made event listener that prints a readable trace of a run.
 *
 * Pass it straight to `run()`:
 *
 * ```ts
 * const result = await agent.run('What is the weather in Paris?', {
 *   onEvent: consoleTracer(),
 * })
 * ```
 *
 * ```text
 * ▶ run_m9x2k1p  weather-assistant · anthropic/claude-opus-5
 *   ↳ get_weather { city: 'Paris' }  →  18°C, clear   12ms
 * ✔ finish · 2 turns · 412 in / 63 out · 1.9s
 * ```
 *
 * Tool inputs and outputs are redacted before printing, so a tool that handles
 * credentials does not leak them into your terminal or CI log.
 */
export function consoleTracer(options: ConsoleTracerOptions = {}): EventListener {
  // eslint-disable-next-line no-console -- writing to the console is the point of this function
  const write = options.write ?? ((line: string) => console.log(line))
  const useColor = options.color ?? !process.env['NO_COLOR']
  const maxLength = options.maxValueLength ?? 120
  const paint = useColor ? color : (_c: ColorName, text: string) => text

  return (event: AgentEvent): void => {
    switch (event.type) {
      case 'run.start':
        write(
          `${paint('cyan', '▶')} ${paint('dim', event.runId)}  ${event.agentName} ${paint('dim', `· ${event.modelId}`)}`,
        )
        break

      case 'session.load': {
        // `truncated` turns an exact count into a lower bound, and saying "12+"
        // rather than "12" is the difference between an honest trace and a
        // misleading one.
        const dropped =
          event.droppedCount > 0 || event.truncated
            ? paint('yellow', ` · trimmed ${event.droppedCount}${event.truncated ? '+' : ''}`)
            : ''
        write(
          `  ${paint('dim', '↺')} session ${paint('dim', event.sessionId)} ${paint('dim', `· ${event.messageCount} message${event.messageCount === 1 ? '' : 's'}`)}${dropped}`,
        )
        break
      }

      case 'session.summarize':
        write(
          event.error
            ? `  ${paint('yellow', '⚠')} summary failed ${paint('dim', `· ${event.error.code} · trimmed ${event.foldedCount} instead`)}`
            : `  ${paint('dim', '∑')} summarised ${event.foldedCount} ${paint('dim', `· ${event.coveredCount} covered · kept ${event.keptCount} · ${event.durationMs}ms`)}`,
        )
        break

      case 'session.save':
        write(
          `  ${paint('dim', '↥')} session ${paint('dim', event.sessionId)} ${paint('dim', `· +${event.appendedCount} saved`)}`,
        )
        break

      case 'model.response':
        if (options.verbose && event.text.trim().length > 0) {
          write(`  ${paint('dim', '│')} ${truncate(event.text.trim(), maxLength * 2)}`)
        }
        break

      case 'tool.start':
        write(
          `  ${paint('dim', '↳')} ${paint('yellow', event.toolName)} ${paint('dim', format(event.input, maxLength))}`,
        )
        break

      case 'tool.end': {
        const mark = event.isError ? paint('red', '✗') : paint('green', '→')
        const rendered = format(event.result.output, maxLength)
        write(`    ${mark} ${rendered} ${paint('dim', `${event.durationMs}ms`)}`)
        break
      }

      case 'run.finish': {
        const mark = event.stopReason === 'finish' ? paint('green', '✔') : paint('yellow', '⚠')
        const usage = `${event.usage.inputTokens} in / ${event.usage.outputTokens} out`
        write(
          `${mark} ${event.stopReason} ${paint('dim', `· ${event.turns} turn${event.turns === 1 ? '' : 's'} · ${usage} · ${formatDuration(event.durationMs)}`)}`,
        )
        break
      }

      case 'model.retry':
        write(
          `  ${paint('yellow', '⟳')} retry ${event.attempt}/${event.maxAttempts} ${paint('dim', `· ${event.error.code} · waiting ${event.delayMs}ms`)}`,
        )
        break

      case 'model.fallback':
        write(
          `  ${paint('yellow', '⇄')} fallback ${paint('dim', '→')} ${event.toModelId} ${paint('dim', `· after ${event.error.code}`)}`,
        )
        break

      case 'run.error':
        write(`${paint('red', '✗')} ${event.error.code}: ${event.error.message.split('\n')[0]}`)
        break

      // text.delta and model.request are intentionally silent: one is per-token
      // noise, the other duplicates model.response.
      default:
        break
    }
  }
}

function format(value: unknown, maxLength: number): string {
  // Redact first, then stringify: a tool that handles credentials must not leak
  // them into a terminal or a CI log.
  return truncate(safeStringify(redact(value)), maxLength)
}

function truncate(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, ' ')
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1)}…`
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

type ColorName = 'red' | 'green' | 'yellow' | 'cyan' | 'dim'

const CODES: Record<ColorName, string> = {
  red: '31',
  green: '32',
  yellow: '33',
  cyan: '36',
  dim: '2',
}

function color(name: ColorName, text: string): string {
  return `\u001b[${CODES[name]}m${text}\u001b[0m`
}
