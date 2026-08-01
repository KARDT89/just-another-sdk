/**
 * Example 1 — Hello, agent.
 *
 * The minimum viable agent: instructions, a model, one question. No tools, no
 * streaming, no session. Run it with:
 *
 *   echo "OPENROUTER_API_KEY=sk-or-..." > examples/.env
 *   pnpm example:hello
 */

import { Agent, isAgentError } from 'just-another-sdk'
import { openrouter } from 'just-another-sdk/providers'

// Override with OPENROUTER_MODEL to try a different model without editing code.
const MODEL = process.env['OPENROUTER_MODEL'] ?? 'openai/gpt-4o-mini'

try {
  // Constructed inside the try: a missing API key is a ConfigurationError raised
  // here, and it deserves the same friendly handling as a failed run.
  const agent = new Agent({
    name: 'haiku-writer',
    instructions: 'You write haiku. Reply with the poem only — no preamble, no explanation.',
    model: openrouter(MODEL),
  })

  const result = await agent.run('Write a haiku about a zero-dependency SDK.')

  console.log(`\n${result.output}\n`)
  console.log(
    `— ${result.modelId} · ${result.usage.inputTokens} in / ${result.usage.outputTokens} out ` +
      `· ${result.durationMs}ms · stopped: ${result.stopReason}`,
  )
} catch (error) {
  // Every failure the SDK raises is an AgentError with a machine-readable `code`
  // and, where one exists, a concrete next step in the message.
  if (isAgentError(error)) {
    console.error(`\n✗ ${error.code}\n${error.message}\n`)
    process.exit(1)
  }
  throw error
}
