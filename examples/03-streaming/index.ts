/**
 * Example 3 — Streaming.
 *
 * `agent.stream()` returns one object that is both an async iterable of events
 * and a promise for the final result. Four acts, each demonstrating one thing:
 *
 *   1. tokens painted as they arrive
 *   2. `textStream()`, then awaiting the same object for usage and timing
 *   3. streaming with tools — text stops, the tool runs, text resumes
 *   4. cancelling a run mid-flight with `.abort()`
 *
 * The agent is also configured with retries and a fallback model, so a rate
 * limit or an outage recovers without any code here.
 *
 * Run it with:
 *
 *   echo "OPENROUTER_API_KEY=sk-or-..." > examples/.env
 *   pnpm example:stream
 */

import { Agent, isAgentError, tool, type AgentEvent } from 'just-another-sdk'
import { openrouter } from 'just-another-sdk/providers'
import * as z from 'zod'

const MODEL = process.env['OPENROUTER_MODEL'] ?? 'openai/gpt-4o-mini'
const FALLBACK_MODEL = process.env['OPENROUTER_FALLBACK_MODEL'] ?? 'openai/gpt-4o-mini'

/* ── Rendering ───────────────────────────────────────────────────────────── */

/**
 * A renderer has one real problem: `text.delta` writes a partial line, and
 * everything else wants a whole one. Tracking whether the cursor is mid-line and
 * breaking before any non-delta output is the whole trick.
 */
function createRenderer() {
  let midLine = false

  const breakLine = () => {
    if (midLine) {
      process.stdout.write('\n')
      midLine = false
    }
  }

  return {
    handle(event: AgentEvent): void {
      switch (event.type) {
        case 'text.delta':
          process.stdout.write(event.delta)
          midLine = true
          break

        case 'tool.start':
          breakLine()
          console.log(`  ↳ ${event.toolName}(${JSON.stringify(event.input)})`)
          break

        case 'tool.end':
          console.log(`    ${event.isError ? '✗' : '→'} ${event.durationMs}ms`)
          break

        // Only fires if the model call actually failed and is being replayed.
        // `discardedText` is what was already painted and is now void.
        case 'model.retry':
          breakLine()
          console.log(`  ⟳ retry ${event.attempt}/${event.maxAttempts} · ${event.error.code}`)
          break

        case 'model.fallback':
          breakLine()
          console.log(`  ⇄ falling back to ${event.toModelId}`)
          break

        default:
          break
      }
    },
    done: breakLine,
  }
}

function heading(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 64 - title.length))}`)
}

/* ── Tools ───────────────────────────────────────────────────────────────── */

/**
 * Deliberately slow, so the ordering guarantee is visible rather than theoretical:
 * streamed text stops, this runs, then text resumes.
 */
const lookUpFact = tool({
  name: 'look_up_fact',
  description: 'Look up a fact about a topic in the reference database.',
  inputSchema: z.object({ topic: z.string() }),
  execute: async ({ topic }) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    return { topic, fact: `${topic} was standardised in 1997.`, source: 'reference-db' }
  },
})

/* ── Run ─────────────────────────────────────────────────────────────────── */

try {
  const agent = new Agent({
    name: 'streaming-assistant',
    instructions: 'You are concise and concrete. Use tools rather than guessing.',
    model: openrouter(MODEL),
    tools: [lookUpFact],
    maxTurns: 6,

    // Reliability, configured rather than hand-rolled. A 429 or a dropped
    // connection is retried with jittered backoff; if the primary model stays
    // down, the chain moves on. Neither needs a line of code below.
    maxRetries: 3,
    fallbacks: [openrouter(FALLBACK_MODEL)],
  })

  /* 1. Raw token streaming. */

  heading('1. Tokens as they arrive')

  const first = agent.stream('In two sentences, why do async iterators exist?')
  const render = createRenderer()

  for await (const event of first) render.handle(event)
  render.done()

  /* 2. textStream(), then the result from the same object. */

  heading('2. textStream(), then the result')

  const second = agent.stream('Name three uses for backpressure. One line each.')

  for await (const chunk of second.textStream()) process.stdout.write(chunk)

  // The same object, now awaited. Iterating did not consume the result.
  const secondResult = await second
  console.log(
    `\n\n  ${secondResult.usage.inputTokens} in / ${secondResult.usage.outputTokens} out · ` +
      `${secondResult.turns} turn(s) · ${secondResult.durationMs}ms · ${secondResult.modelId}`,
  )

  /* 3. Streaming with a tool in the middle. */

  heading('3. Streaming with tools')
  console.log('(text pauses while the tool runs, then resumes)\n')

  const third = agent.stream('Look up a fact about TypeScript, then tell me why it matters.')
  const toolRender = createRenderer()

  for await (const event of third) toolRender.handle(event)
  toolRender.done()

  const thirdResult = await third
  console.log(`\n  ${thirdResult.steps.length} turns, stopped because: ${thirdResult.stopReason}`)

  /* 4. Cancellation. */

  heading('4. Cancelling mid-stream')

  const fourth = agent.stream('Write a long, detailed essay about the history of concurrency.')

  // Stop after a short burst of output, whatever the model is in the middle of.
  setTimeout(() => fourth.abort('seen enough'), 1_200)

  try {
    for await (const event of fourth) {
      if (event.type === 'text.delta') process.stdout.write(event.delta)
    }
  } catch (error) {
    if (isAgentError(error) && error.code === 'aborted') {
      console.log('\n\n  ✔ cancelled cleanly — the model call was aborted mid-flight')
    } else {
      throw error
    }
  }

  console.log(`\n${'─'.repeat(68)}`)
  console.log('Streaming, tool ordering, cancellation, and retries — all from one API.\n')
} catch (error) {
  if (isAgentError(error)) {
    console.error(`\n✗ ${error.code}\n${error.message}\n`)
    process.exit(1)
  }
  throw error
}
