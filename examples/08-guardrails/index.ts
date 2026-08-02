/**
 * Example 8 — Guardrails and human approval.
 *
 * Three places to say no, and one place to ask a person:
 *
 *   • an **input** guardrail, before a single token is spent;
 *   • an **output** guardrail, before the answer reaches you or the session;
 *   • a **tool** guardrail, after arguments validate and before the handler runs;
 *   • and `requireApproval`, which suspends the run for a human.
 *
 *   pnpm example:guardrails
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
  type InputGuardrail,
  type OutputGuardrail,
  type ToolGuardrail,
} from 'just-another-sdk'
import { mockProvider } from 'just-another-sdk/testing'
import * as z from 'zod'

try {
  /* ── ① Rejected before a single token is spent ───────────────────────────── */

  console.log('\n① an input guardrail rejects an oversized paste\n')

  const maxLength: InputGuardrail = {
    name: 'max-length',
    check: (input) =>
      input.length > 10_000
        ? { reject: `Message is ${input.length} characters; the limit is 10,000.` }
        : { allow: true },
  }

  const cheap = mockProvider([{ text: 'never reached' }])

  try {
    await new Agent({ name: 'support', model: cheap, inputGuardrails: [maxLength] }).run(
      'x'.repeat(20_000),
    )
  } catch (error) {
    if (!isAgentError(error) || error.code !== 'guardrail_blocked') throw error
    console.log(`   ${error.code}: ${error.message.split('\n')[0]}`)
  }

  // The claim is "before spending a token". This is the receipt.
  console.log(`   model calls made: ${cheap.calls.length}\n`)

  /* ── ② Scrubbed on the way out — including from the transcript ───────────── */

  console.log('② an output guardrail scrubs PII from the answer *and* the log\n')

  const scrubEmail: OutputGuardrail = {
    name: 'pii-scrub',
    check: (output) => ({
      allow: true,
      replace: output.replace(/[\w.+-]+@[\w-]+\.\w+/g, '[email removed]'),
    }),
  }

  const leaky = mockProvider([
    { text: 'Your account manager is Ada — reach her at ada@example.com.' },
  ])

  const scrubbed = await new Agent({
    name: 'support',
    model: leaky,
    outputGuardrails: [scrubEmail],
  }).run('who is my account manager?')

  console.log(`   output:     ${scrubbed.output}`)
  console.log(`   transcript: ${JSON.stringify(scrubbed.messages.at(-1)?.content)}`)
  console.log('\n   Both, on purpose. Scrubbing only the return value would leave the')
  console.log('   original in the session, and hand it straight back next turn.\n')

  /* ── ③ A dangerous tool, blocked — and the run still finishes ────────────── */

  console.log('③ a tool guardrail blocks a destructive call\n')

  const deleteAccount = tool({
    name: 'delete_account',
    description: 'Permanently delete a customer account.',
    inputSchema: z.object({ id: z.string() }),
    execute: ({ id }) => ({ deleted: id }),
  })

  const readOnly: ToolGuardrail = {
    name: 'read-only-mode',
    tools: ['delete_account'],
    check: () => ({ reject: 'This assistant is in read-only mode.' }),
  }

  const script = [
    { toolCalls: [{ toolName: 'delete_account', input: { id: 'cus_123' } }] },
    { text: 'I am not able to delete accounts — I have raised a ticket instead.' },
  ]

  for (const policy of ['return', 'throw'] as const) {
    const model = mockProvider(script)
    const result = await new Agent({
      name: 'support',
      model,
      tools: [deleteAccount],
      toolGuardrails: [readOnly],
      onToolError: policy,
      // Traced once — the second pass is only here to prove the policy makes no
      // difference to the outcome.
    }).run('delete account cus_123', policy === 'return' ? { onEvent: consoleTracer() } : {})

    console.log(`   onToolError: '${policy}' → stopReason ${result.stopReason}`)
  }

  console.log('\n   Both finish. A blocked call is a policy decision, not a tool')
  console.log("   failure, so it does not trip `onToolError: 'throw'`.\n")

  /* ── ④ Asking a human, and resuming from the answer ──────────────────────── */

  console.log('④ a refund over $100 waits for a person\n')

  const refundOrder = tool({
    name: 'refund_order',
    description: 'Refund an order.',
    inputSchema: z.object({ orderId: z.string(), amount: z.number() }),
    execute: ({ orderId, amount }) => ({ refunded: amount, orderId }),
  })

  const refundCap: ToolGuardrail<{ orderId: string; amount: number }> = {
    name: 'refund-cap',
    tools: ['refund_order'],
    check: ({ input }) =>
      input.amount > 100
        ? { requireApproval: true, reason: `$${input.amount} is over the $100 limit.` }
        : { allow: true },
  }

  const refundScript = [
    { toolCalls: [{ toolName: 'refund_order', input: { orderId: 'o_88', amount: 500 } }] },
    { text: 'Refunded $500 for order o_88.' },
  ]
  const denyScript = [
    refundScript[0]!,
    { text: 'I was not able to issue that refund — a supervisor declined it.' },
  ]

  for (const [label, approved, script] of [
    ['approved', true, refundScript],
    ['declined', false, denyScript],
  ] as const) {
    const model = mockProvider(script)
    const agent = new Agent({
      name: 'support',
      model,
      tools: [refundOrder],
      toolGuardrails: [refundCap],
    })

    let suspension
    try {
      await agent.run('refund order o_88 for $500', { onEvent: consoleTracer() })
    } catch (error) {
      if (!(error instanceof ApprovalRequiredError)) throw error
      suspension = error.suspension
    }
    if (!suspension) throw new Error('expected the run to suspend')

    // Stands in for the network hop to whoever decides. The suspension is plain
    // JSON, so this is the whole story — no store, no adapter, no schema.
    const overTheWire = JSON.parse(JSON.stringify(suspension)) as typeof suspension

    const final = await agent.resumeApproval(
      overTheWire,
      overTheWire.pending.calls.map((call) => ({
        toolCallId: call.toolCallId,
        approved,
        ...(approved ? {} : { reason: 'Outside policy for this account.' }),
      })),
      { onEvent: consoleTracer() },
    )

    console.log(`\n   ${label}: ${final.text}`)
    console.log(`   steps: ${final.steps.map((step) => step.kind).join(' → ')}\n`)
  }

  console.log('   Keep the suspension server-side. It holds the whole conversation;')
  console.log('   send a client only `suspension.pending`, which does not.\n')
} catch (error) {
  if (isAgentError(error)) {
    console.error(`\n✗ ${error.code}\n${error.message}\n`)
    process.exit(1)
  }
  throw error
}
