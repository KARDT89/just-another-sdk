/**
 * Example 7 — Typed results instead of a string.
 *
 * `outputSchema` turns `result.output` from prose you have to parse into an
 * object the compiler already knows the shape of. The interesting part is not
 * the happy path — it is what happens when the model answers badly, which is
 * often enough to matter.
 *
 *   pnpm example:structured
 *
 * Acts ②–④ run against the mock provider, so they need no API key and are
 * deterministic. Act ① needs one:
 *
 *   echo "OPENROUTER_API_KEY=sk-or-..." > examples/.env
 */

import { Agent, InvalidOutputError, consoleTracer, isAgentError, tool } from 'just-another-sdk'
import { openrouter } from 'just-another-sdk/providers'
import { mockProvider } from 'just-another-sdk/testing'
import * as z from 'zod'

const MODEL = process.env['OPENROUTER_MODEL'] ?? 'openai/gpt-4o-mini'

const Ticket = z.object({
  category: z.enum(['bug', 'feature', 'question']),
  severity: z.number().int().min(1).max(5),
  summary: z.string(),
  customerEmail: z.string().nullable(),
})

const EMAIL = `
  Hi — since yesterday's update I cannot log in at all. It just spins and then
  throws me back to the sign-in page. This is blocking my whole team of about
  forty people, so it is fairly urgent. You can reach me at ada@example.com.
`

const instructions = 'You trade in triage. Read the customer message and classify it.'

try {
  /* ── ① A real model, a real typed result ─────────────────────────────────── */

  if (process.env['OPENROUTER_API_KEY']) {
    console.log('\n① a live model extracts a typed record from prose\n')

    const agent = new Agent({
      name: 'triage',
      instructions,
      model: openrouter(MODEL),
      outputSchema: Ticket,
    })

    const result = await agent.run(EMAIL)

    console.log(`   category:  ${result.output.category}`)
    console.log(`   severity:  ${result.output.severity}`)
    console.log(`   summary:   ${result.output.summary}`)
    console.log(`   email:     ${result.output.customerEmail ?? '(none given)'}`)
    // Not a cast and not a string: arithmetic works because the validator
    // produced a number and the type came from the same schema.
    console.log(`\n   escalated severity would be ${result.output.severity + 1}\n`)
  } else {
    console.log('\n① skipped — set OPENROUTER_API_KEY in examples/.env for the live run\n')
  }

  /* ── ② A model that answers badly, and the repair that fixes it ──────────── */

  console.log('② a malformed first answer, repaired automatically\n')

  const sloppy = mockProvider([
    // Chatty, fenced, and `severity` is a word rather than a number: three of
    // the four ways a model typically gets this wrong, all at once.
    {
      text:
        'Sure! Here is the ticket:\n```json\n' +
        '{"category":"bug","severity":"high","summary":"Login loop after update",' +
        '"customerEmail":"ada@example.com"}\n```',
    },
    {
      text:
        '{"category":"bug","severity":4,"summary":"Login loop after update",' +
        '"customerEmail":"ada@example.com"}',
    },
  ])

  const repaired = await new Agent({
    name: 'triage',
    instructions,
    model: sloppy,
    outputSchema: Ticket,
  }).run(EMAIL, { onEvent: consoleTracer({ verbose: false }) })

  console.log(
    `\n   output.severity is ${repaired.output.severity}, a ${typeof repaired.output.severity}`,
  )
  console.log(`   steps: ${repaired.steps.map((step) => step.kind).join(' → ')}`)
  console.log(`   turns: ${repaired.turns} — the repair cost tokens, not a turn\n`)

  /* ── ③ Tools and a schema, composed ──────────────────────────────────────── */

  console.log('③ the same agent, but it calls a tool first\n')

  const lookup = tool({
    name: 'lookup_customer',
    description: 'Look up a customer account by email address.',
    inputSchema: z.object({ email: z.string() }),
    execute: ({ email }) => ({ email, plan: 'enterprise', seats: 40 }),
  })

  const withTools = mockProvider([
    { toolCalls: [{ toolName: 'lookup_customer', input: { email: 'ada@example.com' } }] },
    {
      text:
        '{"category":"bug","severity":5,"summary":"Login loop blocking 40 enterprise seats",' +
        '"customerEmail":"ada@example.com"}',
    },
  ])

  const composed = await new Agent({
    name: 'triage',
    instructions,
    model: withTools,
    tools: [lookup],
    outputSchema: Ticket,
  }).run(EMAIL, { onEvent: consoleTracer() })

  console.log(`\n   severity ${composed.output.severity} — the tool result informed it`)
  console.log(`   steps: ${composed.steps.map((step) => step.kind).join(' → ')}\n`)

  /* ── ④ A model that never complies ───────────────────────────────────────── */

  console.log('④ when repair is switched off and the model will not comply\n')

  const stubborn = mockProvider([{ text: 'I would rather write you a poem about logging in.' }])

  try {
    await new Agent({
      name: 'triage',
      instructions,
      model: stubborn,
      outputSchema: Ticket,
      maxOutputRetries: 0,
    }).run(EMAIL)
  } catch (error) {
    if (!(error instanceof InvalidOutputError)) throw error

    console.log(`   ${error.code} after ${error.attempts} repair attempt(s)`)
    console.log(`   issues:  ${error.issues.length === 0 ? '(not JSON at all)' : ''}`)
    for (const issue of error.issues) {
      console.log(`     • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    }
    console.log(`   rawText: ${JSON.stringify(error.rawText)}`)
    console.log('\n   `rawText` is on the error and not in its `toJSON()`, so a log')
    console.log('   pipeline never receives whatever the model happened to echo back.\n')
  }
} catch (error) {
  if (isAgentError(error)) {
    console.error(`\n✗ ${error.code}\n${error.message}\n`)
    process.exit(1)
  }
  throw error
}
