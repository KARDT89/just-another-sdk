/**
 * Example 2 — Tools.
 *
 * Shows the parts of the runtime you actually care about in production:
 *
 *   • a typed tool whose handler input is inferred from its Zod schema
 *   • two tools called in parallel in a single turn
 *   • a tool that fails, and an agent that recovers instead of crashing
 *   • the event stream, rendered by the built-in console tracer
 *   • multi-turn continuity by passing `messages` back in
 *
 * Run it with:
 *
 *   echo "OPENROUTER_API_KEY=sk-or-..." > examples/.env
 *   pnpm example:tools
 */

import { Agent, consoleTracer, isAgentError, tool } from 'just-another-sdk'
import { openrouter } from 'just-another-sdk/providers'
import * as z from 'zod'

// Override with OPENROUTER_MODEL to try a different model without editing code.
const MODEL = process.env['OPENROUTER_MODEL'] ?? 'openai/gpt-4o-mini'

/* ── Tools ───────────────────────────────────────────────────────────────── */

const getWeather = tool({
  name: 'get_weather',
  description:
    'Get the current weather for a city. Call this whenever the user asks about ' +
    'conditions, temperature, or whether to take an umbrella.',
  inputSchema: z.object({
    city: z.string().describe('City name, e.g. "Paris"'),
    unit: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  // `city` is string and `unit` is the enum — both inferred from the schema above,
  // and already validated by the time this runs.
  execute: async ({ city, unit }) => {
    await new Promise((resolve) => setTimeout(resolve, 120)) // stand-in for a real API
    const tempC = 18
    return {
      city,
      temperature: unit === 'celsius' ? tempC : Math.round((tempC * 9) / 5 + 32),
      unit,
      summary: 'clear',
    }
  },
})

const getTime = tool({
  name: 'get_time',
  description: 'Get the current local time in a city. Use for "what time is it there" questions.',
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => {
    await new Promise((resolve) => setTimeout(resolve, 60))
    return { city, localTime: new Date().toISOString(), timezone: 'Europe/Paris' }
  },
})

/**
 * A deliberately broken tool.
 *
 * The default `onToolError: 'return'` policy feeds this failure back to the model
 * as a tool result, so the model apologises and works around it — the run still
 * completes. Set `onToolError: 'throw'` on the agent to abort instead.
 */
const getAirQuality = tool({
  name: 'get_air_quality',
  description: 'Get the air-quality index for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: () => {
    throw new Error('air-quality upstream returned 503')
  },
})

/* ── Agent and run ───────────────────────────────────────────────────────── */

try {
  // Constructed inside the try: a missing API key is a ConfigurationError raised
  // here, and it deserves the same friendly handling as a failed run.
  const agent = new Agent({
    name: 'travel-assistant',
    instructions:
      'You help travellers. Use the tools available to you rather than guessing. ' +
      'Be concise: two sentences at most unless asked for detail.',
    model: openrouter(MODEL),
    tools: [getWeather, getTime, getAirQuality],
    maxTurns: 6,
    // A rate limit or a dropped connection is retried with jittered backoff, and
    // if this model stays unavailable the run moves down the chain. Both are
    // configuration, not code — see examples/03-streaming for the events they emit.
    maxRetries: 3,
    fallbacks: [openrouter(process.env['OPENROUTER_FALLBACK_MODEL'] ?? MODEL)],
  })

  console.log('\n── Turn 1 ' + '─'.repeat(58))

  const first = await agent.run(
    'I am flying to Paris today. What is the weather, the local time, and the air quality?',
    { onEvent: consoleTracer() },
  )

  console.log(`\n${first.output}\n`)

  // Multi-turn: pass the previous messages back and the agent has full context.
  console.log('── Turn 2 (same conversation) ' + '─'.repeat(43))

  const second = await agent.run('Should I pack an umbrella, then?', {
    messages: first.messages,
    onEvent: consoleTracer(),
  })

  console.log(`\n${second.output}\n`)

  const totalIn = first.usage.inputTokens + second.usage.inputTokens
  const totalOut = first.usage.outputTokens + second.usage.outputTokens
  console.log('─'.repeat(68))
  console.log(`Total across both turns: ${totalIn} in / ${totalOut} out tokens`)

  // A tool failed, and the run still finished. That is the whole point.
  const failures = [...first.steps, ...second.steps].flatMap((step) =>
    step.toolResults.filter((result) => result.isError),
  )
  if (failures.length > 0) {
    console.log(
      `Recovered from ${failures.length} tool failure(s): ` +
        failures.map((f) => f.toolName).join(', '),
    )
  }
} catch (error) {
  if (isAgentError(error)) {
    console.error(`\n✗ ${error.code}\n${error.message}\n`)
    process.exit(1)
  }
  throw error
}
