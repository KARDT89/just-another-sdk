/**
 * Example 4 — Sessions.
 *
 * A conversation that outlives the process. Run it twice:
 *
 *   echo "OPENROUTER_API_KEY=sk-or-..." > examples/.env
 *   pnpm example:sessions          # introduces itself
 *   pnpm example:sessions          # a *new* process — and it still remembers
 *
 *   pnpm example:sessions -- --show    # print the stored transcript
 *   pnpm example:sessions -- --clear   # forget it and start over
 *
 * The whole persistence layer is the one `session:` line below. There is no
 * message bookkeeping anywhere in this file.
 */

import { Agent, consoleTracer, isAgentError } from 'just-another-sdk'
import { openrouter } from 'just-another-sdk/providers'
import { fileSession } from 'just-another-sdk/sessions/file'

const MODEL = process.env['OPENROUTER_MODEL'] ?? 'openai/gpt-4o-mini'
const SESSION_ID = 'demo-user'

const agent = new Agent({
  name: 'memory-demo',
  instructions:
    'You are a concise assistant with a good memory. Answer in one or two sentences, ' +
    'and refer back to earlier turns when they are relevant.',
  model: openrouter(MODEL),

  // ── This is the entire feature ────────────────────────────────────────────
  session: fileSession('./.sessions'),

  // Long conversations would otherwise cost more every turn. Trimming is not
  // destructive: the file keeps everything, this only bounds what is sent.
  context: { maxTokens: 8_000 },
})

// `agent.session(id)` binds the conversation, so `run` carries no history.
const chat = agent.session(SESSION_ID)

const flag = process.argv[2]

try {
  if (flag === '--clear') {
    await chat.clear()
    console.log('Forgotten. The next run starts fresh.')
    process.exit(0)
  }

  const history = await chat.messages()

  if (flag === '--show') {
    console.log(`${history.length} message(s) stored for "${SESSION_ID}":\n`)
    for (const message of history) {
      const text =
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
      console.log(`  ${message.role.padEnd(9)} ${text.slice(0, 100)}`)
    }
    process.exit(0)
  }

  // First invocation tells it something; every later invocation asks it back.
  // Two separate processes, no state in this file.
  const input =
    history.length === 0
      ? 'My name is Ada and I am building a zero-dependency agent SDK. Remember that.'
      : 'Without me repeating it: what is my name, and what am I building?'

  console.log(`\n${history.length === 0 ? '① first run' : `② run ${history.length / 2 + 1}`}`)
  console.log(`> ${input}\n`)

  // The tracer prints `session.load` and `session.save`, so you can see exactly
  // how much history was carried in and how much was written back.
  const result = await chat.run(input, { onEvent: consoleTracer() })

  console.log(`\n${result.output}\n`)
  console.log(
    history.length === 0
      ? 'Now run `pnpm example:sessions` again — a new process, same conversation.'
      : `— recalled from ${history.length} stored message(s) in ./.sessions/${SESSION_ID}.jsonl`,
  )
} catch (error) {
  if (isAgentError(error)) {
    console.error(`\n✗ ${error.code}\n${error.message}\n`)
    process.exit(1)
  }
  throw error
}
