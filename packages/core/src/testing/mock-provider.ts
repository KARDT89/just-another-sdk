import type {
  ModelCallOptions,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
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
  /** How many calls went through `stream()` rather than `generate()`. */
  readonly streamCallCount: number
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
  /**
   * How `text` is broken up when streamed. Defaults to a word-level split, so
   * every streaming test exercises reassembly without having to say so.
   *
   * These must join to `text` exactly — `generate()` and `stream()` derive their
   * response from the same place, so a mismatch would be a bug in the mock.
   */
  readonly textChunks?: readonly string[]
  /** Delay between streamed chunks, ms. For slow-consumer and abort tests. */
  readonly chunkDelayMs?: number
  /**
   * Fail mid-stream after this many text chunks have been emitted. Drives the
   * retry-after-partial-output path, where `discardedText` is non-empty.
   */
  readonly errorAfterChunks?: number
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
  /**
   * Whether the provider implements `stream()` at all. Default `true`.
   *
   * Set `false` to test the `generate()` fallback path — the returned object
   * omits the method entirely rather than setting it to `undefined`, matching
   * what a real provider without streaming support looks like.
   */
  readonly supportsStreaming?: boolean
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
  const supportsStreaming = options.supportsStreaming ?? true

  const calls: ModelRequest[] = []
  const callOptions: (ModelCallOptions | undefined)[] = []
  let index = 0
  let streamCallCount = 0

  /** Both entry points derive their response from here, so they cannot drift. */
  function buildResponse(turn: MockTurn, turnNumber: number): ModelResponse {
    const content: (TextPart | ToolCallPart)[] = []

    if (turn.text !== undefined && turn.text.length > 0) {
      content.push({ type: 'text', text: turn.text })
    }

    for (const [i, call] of (turn.toolCalls ?? []).entries()) {
      content.push({
        type: 'tool-call',
        // Deterministic ids keep snapshots and assertions stable.
        toolCallId: call.toolCallId ?? `call_${turnNumber}_${i}`,
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
      raw: { mock: true, turn: turnNumber },
    }
  }

  const provider: MockProvider = {
    providerId,
    modelId,
    calls,
    callOptions,

    get streamCallCount(): number {
      return streamCallCount
    },

    reset(): void {
      calls.length = 0
      callOptions.length = 0
      index = 0
      streamCallCount = 0
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

      return buildResponse(turn, index)
    },

    async *stream(
      request: ModelRequest,
      callOpts: ModelCallOptions = {},
    ): AsyncGenerator<ModelStreamChunk> {
      // Recorded into the same arrays as `generate`, so a retry test can assert
      // `calls.length` without caring which path was taken.
      calls.push(request)
      callOptions.push(callOpts)
      streamCallCount += 1

      const turn = nextTurn(script, index, request, onExhausted)
      index += 1
      const turnNumber = index

      if (turn.delayMs !== undefined) {
        await delay(turn.delayMs, callOpts.signal)
      }

      // An error with no `errorAfterChunks` fails before any output, the way a
      // 429 or a refused connection does.
      if (turn.error && turn.errorAfterChunks === undefined) throw turn.error

      const chunks = turn.textChunks ?? splitIntoChunks(turn.text ?? '')
      const failAfter = turn.errorAfterChunks

      for (const [i, chunk] of chunks.entries()) {
        if (turn.error && failAfter === i) throw turn.error
        if (turn.chunkDelayMs !== undefined) await delay(turn.chunkDelayMs, callOpts.signal)
        if (chunk.length > 0) yield { type: 'text-delta', text: chunk }
      }

      // `errorAfterChunks` past the end of the script still fails the turn.
      if (turn.error) throw turn.error

      // Split in half so reassembly is genuinely exercised rather than assumed.
      for (const [i, call] of (turn.toolCalls ?? []).entries()) {
        const toolCallId = call.toolCallId ?? `call_${turnNumber}_${i}`
        const args = JSON.stringify(call.input ?? {})
        const midpoint = Math.ceil(args.length / 2)

        yield {
          type: 'tool-call-delta',
          toolCallId,
          toolName: call.toolName,
          inputDelta: args.slice(0, midpoint),
        }
        yield { type: 'tool-call-delta', toolCallId, inputDelta: args.slice(midpoint) }
      }

      yield { type: 'finish', response: buildResponse(turn, turnNumber) }
    },
  }

  if (!supportsStreaming) {
    // Deleted rather than set to `undefined`: `'stream' in provider` must be
    // false for the fallback path to be exercised honestly.
    delete (provider as { stream?: unknown }).stream
  }

  return provider
}

/**
 * Word-level split that reassembles exactly — trailing spaces stay attached, so
 * `chunks.join('') === text` for any input.
 */
function splitIntoChunks(text: string): readonly string[] {
  if (text.length === 0) return []
  return text.match(/\S+\s*|\s+/g) ?? [text]
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
