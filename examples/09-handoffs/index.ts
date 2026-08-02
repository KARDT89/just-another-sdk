/**
 * Example 9 — Handoffs.
 *
 * A routing agent that delegates to specialists, and the three things that stop
 * delegation becoming an infinite loop:
 *
 *   • a **transfer** is a tool call, so it inherits guardrails and approval;
 *   • a **depth ceiling** and **cycle detection** refuse a transfer rather than
 *     ending the run — the agent holding the conversation answers instead;
 *   • **one run**, so `maxTurns` is shared across the whole chain.
 *
 *   pnpm example:handoffs
 *
 * **This whole example runs offline** — every act uses `mockProvider`, so there
 * is nothing to configure and nothing to pay for.
 */

import {
  Agent,
  ApprovalRequiredError,
  consoleTracer,
  isAgentError,
  tool,
  type ToolGuardrail,
} from 'just-another-sdk'
import { mockProvider } from 'just-another-sdk/testing'
import * as z from 'zod'

/* ── The specialists ──────────────────────────────────────────────────────── */

const lookupInvoice = tool({
  name: 'lookup_invoice',
  description: 'Look up a customer invoice by month. Call this before discussing charges.',
  inputSchema: z.object({ month: z.string().describe('ISO month, e.g. "2026-03"') }),
  execute: ({ month }) => ({ month, charges: 2, total: '$98.00' }),
})

const searchLogs = tool({
  name: 'search_logs',
  description: 'Search application logs for errors affecting a customer.',
  inputSchema: z.object({ query: z.string() }),
  execute: ({ query }) => ({ query, matches: 3, lastSeen: '2026-03-14T09:12:00Z' }),
})

function billingAgent(script: Parameters<typeof mockProvider>[0]) {
  return new Agent({
    name: 'billing',
    instructions: 'You handle invoices and refunds. Quote exact amounts.',
    model: mockProvider(script, { modelId: 'mock/billing' }),
    tools: [lookupInvoice],
  })
}

try {
  /* ── ① Routing to a specialist ───────────────────────────────────────────── */

  console.log('\n① triage routes a billing question to the billing agent\n')

  const billing = billingAgent([
    { toolCalls: [{ toolName: 'lookup_invoice', input: { month: '2026-03' } }] },
    { text: 'You were billed twice in March — two charges totalling $98.00. I have refunded one.' },
  ])

  const technical = new Agent({
    name: 'technical',
    instructions: 'You handle bugs and outages.',
    model: mockProvider([{ text: 'never reached' }], { modelId: 'mock/technical' }),
    tools: [searchLogs],
  })

  const triage = new Agent({
    name: 'triage',
    instructions: 'Route the user to the right specialist. Do not answer directly.',
    model: mockProvider(
      [
        {
          toolCalls: [
            {
              toolName: 'transfer_to_billing',
              input: { reason: 'The user reports a duplicate charge in March.' },
            },
          ],
        },
      ],
      { modelId: 'mock/triage' },
    ),
    handoffs: [billing, technical],
  })

  const routed = await triage.run('I was charged twice for March.', {
    onEvent: consoleTracer(),
  })

  console.log(`\n   answer:    ${routed.output}`)
  console.log(`   agentPath: ${routed.agentPath.join(' → ')}`)
  console.log(`   who served each turn: ${routed.steps.map((s) => s.agentName).join(', ')}`)
  console.log('\n   One run, one runId, one usage total. The specialist’s instructions,')
  console.log('   tools, and model took over — the loop did not restart.\n')

  /* ── ② A narrowed handover ───────────────────────────────────────────────── */

  console.log('② a filter narrows what the specialist sees — and nothing else\n')

  const narrowedModel = mockProvider([{ text: 'Refunded. You will see it in 3 days.' }], {
    modelId: 'mock/billing',
  })
  const narrowedBilling = new Agent({
    name: 'billing',
    instructions: 'You handle invoices and refunds.',
    model: narrowedModel,
    tools: [lookupInvoice],
  })

  const narrowing = new Agent({
    name: 'triage',
    instructions: 'Route the user to the right specialist.',
    model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }]),
    handoffs: [
      {
        agent: narrowedBilling,
        filter: (messages) => messages.slice(-2),
        describe: 'The user wants the duplicate March charge refunded.',
      },
    ],
  })

  const narrowed = await narrowing.run('and please refund it', {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi! How can I help?' }] },
      { role: 'user', content: 'I was charged twice for March.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check that.' }] },
    ],
  })

  // Read from the provider rather than asserted in prose: the filter kept two
  // messages, and the briefing note was appended on top of them.
  const sent = narrowedModel.calls[0]?.messages.length ?? 0
  console.log(`   the specialist was sent: ${sent} messages (2 kept by the filter + a briefing)`)
  console.log(`   the run still returns:   ${narrowed.messages.length - 1} messages`)
  console.log('\n   A handoff narrows what the model *sees*. It is not a way to delete')
  console.log('   a user’s history — the transcript and the session keep all of it.\n')

  /* ── ③ Loops, refused rather than followed ───────────────────────────────── */

  console.log('③ a cycle is refused, and the run still answers\n')

  const stubborn: Agent = new Agent({
    name: 'triage',
    instructions: 'Route the user.',
    model: mockProvider([
      { toolCalls: [{ toolName: 'transfer_to_billing' }] },
      { text: 'unreachable' },
    ]),
  })

  const bouncy = new Agent({
    name: 'billing',
    instructions: 'You handle invoices.',
    model: mockProvider([
      // Tries to hand the conversation straight back.
      { toolCalls: [{ toolName: 'transfer_to_triage' }] },
      { text: 'I checked — the second charge was a duplicate, and it is refunded.' },
    ]),
    handoffs: [stubborn],
  })

  const looping = await stubborn
    .withHandoffs(bouncy)
    .run('I was charged twice.', { onEvent: consoleTracer() })

  console.log(`\n   answer:     ${looping.output}`)
  console.log(`   agentPath:  ${looping.agentPath.join(' → ')}`)
  console.log(`   stopReason: ${looping.stopReason}`)
  console.log('\n   No new stop reason, and no error. The transfer tool returned')
  console.log('   `handoff_refused`, billing read it, and billing answered.\n')

  /* ── ④ A human in front of the delegation ────────────────────────────────── */

  console.log('④ a tool guardrail puts a person in front of the transfer\n')

  const confirmTransfer: ToolGuardrail = {
    name: 'confirm-delegation',
    tools: ['transfer_to_billing'],
    check: ({ toolName }) => ({
      requireApproval: true,
      reason: `A supervisor must approve ${toolName}.`,
    }),
  }

  const gatedBilling = billingAgent([{ text: 'Refunded $49.00. Sorry about that.' }])

  const gated = new Agent({
    name: 'triage',
    instructions: 'Route the user to the right specialist.',
    model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }]),
    handoffs: [gatedBilling],
    toolGuardrails: [confirmTransfer],
  })

  let suspension
  try {
    await gated.run('I was charged twice.', { onEvent: consoleTracer() })
  } catch (error) {
    if (!(error instanceof ApprovalRequiredError)) throw error
    suspension = error.suspension
  }
  if (!suspension) throw new Error('expected the run to suspend')

  // Stands in for the hop to whoever decides. Plain JSON, like every suspension.
  const overTheWire = JSON.parse(JSON.stringify(suspension)) as typeof suspension

  const approved = await gated.resumeApproval(
    overTheWire,
    overTheWire.pending.calls.map((call) => ({ toolCallId: call.toolCallId, approved: true })),
    { onEvent: consoleTracer() },
  )

  console.log(`\n   answer:    ${approved.output}`)
  console.log(`   agentPath: ${approved.agentPath.join(' → ')}`)
  console.log('\n   A transfer is a tool call, so guardrails, approval, timeouts, and')
  console.log('   tracing all applied to it without a line of handoff-specific code.\n')
} catch (error) {
  if (isAgentError(error)) {
    console.error(`\n✗ ${error.code}\n${error.message}\n`)
    process.exit(1)
  }
  throw error
}
