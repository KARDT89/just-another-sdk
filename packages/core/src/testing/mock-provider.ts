import type {
  ModelCallOptions,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from '../providers/provider.js'
import type { TextPart, ToolCallPart, Usage } from '../types/messages.js'

/**
 * A scripted, offline `ModelProvider`.
 *
 * This exists so that agent behaviour can be tested exhaustively without a
 * network, an API key, or a bill — and so *your* application's tests can do the
 * same. Every test in this package uses it, which is why the suite runs in
 * milliseconds and is deterministic.
 *
 * ```ts
 * const model = mockProvider([
 *   { toolCalls: [{ toolName: 'get_weather', input: { city: 'Paris' } }] },
 *   { text: 'It is 18°C and clear.' },
 * ])
 *
 * const result = await new Agent({ name: 'test', model, tools: [weather] }).run('...')
 * expect(result.text).toBe('It is 18°C and clear.')
 * expect(model.calls).toHaveLength(2)
 * ```
 */
export interface MockProvider extends ModelProvider {
  /** Every request the agent made, in order. Assert against these. */
  readonly calls: readonly ModelRequest[]
  /** Options each call was made with — useful for asserting timeouts/signals. */
  readonly callOptions: readonly (ModelCallOptions | undefined)[]
  /** Resets recorded calls and rewinds the script. */
  reset(): void
}

/** One scripted model turn. */
export interface MockTurn {
  readonly text?: string
  readonly toolCalls?: readonly MockToolCall[]
  readonly usage?: Partial<Usage>
  readonly finishReason?: ModelResponse['finishReason']
  /** Throw instead of responding — for testing provider-failure handling. */
  readonly error?: Error
  /** Delay before responding, ms. For testing timeouts and cancellation. */
  readonly delayMs?: number
}

export interface MockToolCall {
  readonly toolName: string
  readonly input?: unknown
  /** Defaults to a generated deterministic id. */
  readonly toolCallId?: string
}

export interface MockProviderOptions {
  readonly providerId?: string
  readonly modelId?: string
  /**
   * What to do when the script runs out. Default `'repeat-last'`, which keeps a
   * loop test from failing for the wrong reason. `'throw'` catches an agent that
   * called the model more times than the test expected.
   */
  readonly onExhausted?: 'repeat-last' | 'throw'
}

/**
 * Builds a mock provider from a script of turns.
 *
 * A turn with `toolCalls` makes the agent execute tools; a turn with only `text`
 * ends the run. Pass a function instead of an array for dynamic behaviour that
 * depends on the incoming request.
 */
export function mockProvider(
  script: readonly MockTurn[] | ((request: ModelRequest, index: number) => MockTurn),
  options: MockProviderOptions = {},
): MockProvider {
  const providerId = options.providerId ?? 'mock'
  const modelId = options.modelId ?? 'mock/test-model'
  const onExhausted = options.onExhausted ?? 'repeat-last'

  const calls: ModelRequest[] = []
  const callOptions: (ModelCallOptions | undefined)[] = []
  let index = 0

  return {
    providerId,
    modelId,
    calls,
    callOptions,

    reset(): void {
      calls.length = 0
      callOptions.length = 0
      index = 0
    },

    async generate(request: ModelRequest, callOpts: ModelCallOptions = {}): Promise<ModelResponse> {
      calls.push(request)
      callOptions.push(callOpts)

      const turn = nextTurn(script, index, request, onExhausted)
      index += 1

      if (turn.delayMs !== undefined) {
        await delay(turn.delayMs, callOpts.signal)
      }

      if (turn.error) throw turn.error

      const content: (TextPart | ToolCallPart)[] = []

      if (turn.text !== undefined && turn.text.length > 0) {
        content.push({ type: 'text', text: turn.text })
      }

      for (const [i, call] of (turn.toolCalls ?? []).entries()) {
        content.push({
          type: 'tool-call',
          // Deterministic ids keep snapshots and assertions stable.
          toolCallId: call.toolCallId ?? `call_${index}_${i}`,
          toolName: call.toolName,
          input: call.input ?? {},
        })
      }

      const hasToolCalls = content.some((part) => part.type === 'tool-call')

      return {
        content,
        finishReason: turn.finishReason ?? (hasToolCalls ? 'tool_calls' : 'stop'),
        usage: {
          inputTokens: turn.usage?.inputTokens ?? 10,
          outputTokens: turn.usage?.outputTokens ?? 5,
          totalTokens:
            turn.usage?.totalTokens ??
            (turn.usage?.inputTokens ?? 10) + (turn.usage?.outputTokens ?? 5),
        },
        modelId,
        raw: { mock: true, turn: index },
      }
    },
  }
}

function nextTurn(
  script: readonly MockTurn[] | ((request: ModelRequest, index: number) => MockTurn),
  index: number,
  request: ModelRequest,
  onExhausted: 'repeat-last' | 'throw',
): MockTurn {
  if (typeof script === 'function') return script(request, index)

  const turn = script[index]
  if (turn) return turn

  if (onExhausted === 'throw') {
    throw new Error(
      `mockProvider script exhausted: the agent made ${index + 1} model calls but only ` +
        `${script.length} turn(s) were scripted.`,
    )
  }

  return script.at(-1) ?? { text: '' }
}

/** Sleep that rejects promptly if the run is cancelled. */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    if (!signal) return

    const onAbort = () => {
      clearTimeout(timer)
      const error = new Error('Aborted')
      error.name = 'AbortError'
      reject(error)
    }

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
