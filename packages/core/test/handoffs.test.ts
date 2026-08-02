import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import {
  Agent,
  ApprovalRequiredError,
  ConfigurationError,
  memorySession,
  tool,
  type ModelMessage,
  type ToolGuardrail,
} from '../src/index.js'
import { collectEvents, mockProvider } from '../src/testing/index.js'

/**
 * Handoffs: delegating a conversation to a specialist.
 *
 * A handoff is a **tool**, and a run that hands off is still **one run**. Almost
 * every assertion below follows from one of those two sentences, and the ones
 * that carry the design are marked:
 *
 *   • no limit ends the run — a refused transfer is a result the model reads;
 *   • a `filter` narrows what the model sees and **nothing else**;
 *   • a transfer is subject to the routing agent's tool guardrails, approval
 *     included, and an approved transfer must actually take effect on resume.
 */

const lookupInvoice = tool({
  name: 'lookup_invoice',
  description: 'Look up an invoice by month.',
  inputSchema: z.object({ month: z.string() }),
  execute: ({ month }) => ({ month, charges: 2, total: '$98.00' }),
})

/** Two agents, wired triage → billing, sharing nothing but the wire. */
function pair(
  triageScript: Parameters<typeof mockProvider>[0],
  billingScript: Parameters<typeof mockProvider>[0],
) {
  const billingModel = mockProvider(billingScript, { modelId: 'mock/billing' })
  const triageModel = mockProvider(triageScript, { modelId: 'mock/triage' })

  const billing = new Agent({
    name: 'billing',
    instructions: 'You handle invoices and refunds. Be precise about amounts.',
    model: billingModel,
    tools: [lookupInvoice],
    builtins: false,
  })

  const triage = new Agent({
    name: 'triage',
    instructions: 'Route the user to the right specialist.',
    model: triageModel,
    handoffs: [billing],
    // Off throughout this file: these tests assert exact tool lists, and the
    // five automatic pure tools would say nothing about handoffs while making
    // every one of those assertions about something else.
    builtins: false,
  })

  return { triage, billing, triageModel, billingModel }
}

describe('a handoff is a tool', () => {
  it('synthesizes transfer_to_<agent> and shows it to the model', () => {
    const { triage } = pair([{ text: '' }], [{ text: '' }])

    expect(triage.toolNames).toEqual(['transfer_to_billing'])
    expect(triage.handoffNames).toEqual(['billing'])
  })

  it('describes the target from its own instructions', async () => {
    const { triage, triageModel } = pair(
      [{ toolCalls: [{ toolName: 'transfer_to_billing' }] }],
      [{ text: 'Two charges of $49.' }],
    )

    await triage.run('I was charged twice.')

    const definition = triageModel.calls[0]?.tools?.[0]
    expect(definition?.name).toBe('transfer_to_billing')
    // The target's own first sentence, so the router knows what is behind the
    // door rather than only its name.
    expect(definition?.description).toContain('You handle invoices and refunds.')
  })

  it('honours a custom toolName and description', () => {
    const specialist = new Agent({ name: 'billing', model: mockProvider([{ text: '' }]) })
    const router = new Agent({
      name: 'triage',
      model: mockProvider([{ text: '' }]),
      handoffs: [{ agent: specialist, toolName: 'escalate', description: 'Send it upstairs.' }],
      builtins: false,
    })

    expect(router.toolNames).toEqual(['escalate'])
  })

  it('accepts a bare AgentConfig as well as an Agent', async () => {
    const router = new Agent({
      name: 'triage',
      model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }]),
      handoffs: [{ agent: { name: 'billing', model: mockProvider([{ text: 'done' }]) } }],
    })

    const result = await router.run('hi')
    expect(result.agentPath).toEqual(['triage', 'billing'])
  })
})

describe('the transfer', () => {
  it('hands the conversation over and records the route', async () => {
    const { triage, billingModel } = pair(
      [{ toolCalls: [{ toolName: 'transfer_to_billing' }] }],
      [{ text: 'You were charged twice for March: $98.00 total.' }],
    )

    const result = await triage.run('I was charged twice for March.')

    expect(result.agentPath).toEqual(['triage', 'billing'])
    expect(result.agentName).toBe('billing')
    expect(result.output).toBe('You were charged twice for March: $98.00 total.')
    expect(result.stopReason).toBe('finish')
    // One run, so the usage is the whole chain's.
    expect(result.usage.inputTokens).toBe(20)
    expect(billingModel.calls).toHaveLength(1)
  })

  it("uses the receiving agent's model, instructions, and tools", async () => {
    const { triage, billingModel } = pair(
      [{ toolCalls: [{ toolName: 'transfer_to_billing' }] }],
      [
        { toolCalls: [{ toolName: 'lookup_invoice', input: { month: '2026-03' } }] },
        { text: 'Two charges, $98.00.' },
      ],
    )

    const result = await triage.run('I was charged twice for March.')

    const request = billingModel.calls[0]
    expect(request?.system).toContain('You handle invoices and refunds.')
    expect(request?.system).not.toContain('Route the user')
    expect(request?.tools?.map((t) => t.name)).toEqual(['lookup_invoice'])
    // `steps[].modelId` is how a trace shows *which* model served a turn.
    expect(result.steps.map((step) => step.modelId)).toEqual([
      'mock/triage',
      'mock/billing',
      'mock/billing',
    ])
  })

  it('attributes every step to the agent that took it', async () => {
    const { triage } = pair(
      [{ toolCalls: [{ toolName: 'transfer_to_billing' }] }],
      [{ text: 'done' }],
    )

    const result = await triage.run('hi')
    expect(result.steps.map((step) => step.agentName)).toEqual(['triage', 'billing'])
  })

  it('carries the whole conversation by default', async () => {
    const { triage, billingModel } = pair(
      [{ toolCalls: [{ toolName: 'transfer_to_billing' }] }],
      [{ text: 'done' }],
    )

    await triage.run('I was charged twice for March.')

    const carried = billingModel.calls[0]?.messages ?? []
    // The user turn, the assistant's transfer call, and its result.
    expect(carried).toHaveLength(3)
    expect(carried[0]).toMatchObject({ role: 'user' })
    expect(carried[2]).toMatchObject({ role: 'tool' })
  })

  it('passes the model’s reason to the receiving agent', async () => {
    const { triage, billingModel } = pair(
      [
        {
          toolCalls: [
            { toolName: 'transfer_to_billing', input: { reason: 'Duplicate March charge.' } },
          ],
        },
      ],
      [{ text: 'done' }],
    )

    await triage.run('help')

    const briefing = billingModel.calls[0]?.messages.at(-1)
    expect(briefing).toMatchObject({ role: 'user' })
    expect(JSON.stringify(briefing)).toContain('Duplicate March charge.')
  })

  it('passes a static describe note even when the model gives no reason', async () => {
    const billing = new Agent({ name: 'billing', model: mockProvider([{ text: 'done' }]) })
    const model = mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }])
    const triage = new Agent({
      name: 'triage',
      model,
      handoffs: [{ agent: billing, describe: 'The user reports a duplicate charge.' }],
    })

    const result = await triage.run('help')
    const note = result.messages.at(-2)

    expect(JSON.stringify(note)).toContain('The user reports a duplicate charge.')
  })

  it('chains through three agents', async () => {
    const c = new Agent({ name: 'c', model: mockProvider([{ text: 'the end' }]) })
    const b = new Agent({
      name: 'b',
      model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_c' }] }]),
      handoffs: [c],
    })
    const a = new Agent({
      name: 'a',
      model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_b' }] }]),
      handoffs: [b],
    })

    const result = await a.run('go')

    expect(result.agentPath).toEqual(['a', 'b', 'c'])
    expect(result.output).toBe('the end')
  })
})

describe('loop prevention', () => {
  it('refuses a transfer past maxHandoffs without ending the run', async () => {
    // b can transfer back to a chain of fresh agents forever; the ceiling is
    // what stops it, and the run still produces an answer.
    const c = new Agent({
      name: 'c',
      model: mockProvider([{ text: 'c answered directly' }]),
    })
    const b = new Agent({
      name: 'b',
      model: mockProvider([
        { toolCalls: [{ toolName: 'transfer_to_c' }] },
        // b reads the refusal and answers, which is the whole point.
        { text: 'b answered directly' },
      ]),
      handoffs: [c],
    })
    const a = new Agent({
      name: 'a',
      model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_b' }] }]),
      handoffs: [b],
      maxHandoffs: 1,
    })

    const collected = collectEvents()
    const result = await a.run('go', { onEvent: collected.listener })

    // THE assertion: the ceiling refuses the *call*, it does not end the run.
    expect(result.stopReason).toBe('finish')
    expect(result.output).toBe('b answered directly')
    expect(result.agentPath).toEqual(['a', 'b'])

    const refusal = collected.first('handoff.refused')
    expect(refusal?.cause).toBe('max_handoffs')
    expect(refusal?.to).toBe('c')
    // And the model was told why, in terms it can act on.
    const blocked = result.steps[1]?.toolResults[0]
    expect(blocked?.isError).toBe(true)
    expect(JSON.stringify(blocked?.output)).toContain('handoff_refused')
  })

  it('refuses a cycle rather than following it', async () => {
    const back = mockProvider([{ toolCalls: [{ toolName: 'transfer_to_triage' }] }])
    const triageModel = mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }])

    const triage: Agent = new Agent({ name: 'triage', model: triageModel })
    const billing = new Agent({ name: 'billing', model: back, handoffs: [triage] })
    const router = triage.withHandoffs(billing)

    const collected = collectEvents()
    const result = await router.run('go', { onEvent: collected.listener })

    expect(result.agentPath).toEqual(['triage', 'billing'])
    const refusal = collected.first('handoff.refused')
    expect(refusal?.cause).toBe('cycle')
    expect(refusal?.reason).toContain('triage → billing')
  })

  it('accepts only the first of two transfers in one turn', async () => {
    const billing = new Agent({ name: 'billing', model: mockProvider([{ text: 'billing here' }]) })
    const technical = new Agent({ name: 'technical', model: mockProvider([{ text: 'tech here' }]) })
    const triage = new Agent({
      name: 'triage',
      model: mockProvider([
        {
          toolCalls: [{ toolName: 'transfer_to_billing' }, { toolName: 'transfer_to_technical' }],
        },
      ]),
      handoffs: [billing, technical],
    })

    const collected = collectEvents()
    const result = await triage.run('go', { onEvent: collected.listener })

    expect(result.agentPath).toEqual(['triage', 'billing'])
    expect(collected.first('handoff.refused')?.cause).toBe('already_transferring')
    expect(collected.count('handoff.start')).toBe(1)
  })

  it('shares one maxTurns budget across the whole chain', async () => {
    const billing = new Agent({
      name: 'billing',
      // Would loop forever on its own budget.
      model: mockProvider([{ toolCalls: [{ toolName: 'lookup_invoice', input: { month: 'x' } }] }]),
      tools: [lookupInvoice],
    })
    const triage = new Agent({
      name: 'triage',
      model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }]),
      handoffs: [billing],
      maxTurns: 3,
    })

    const result = await triage.run('go')

    expect(result.stopReason).toBe('max_turns')
    // Three turns total, not three each.
    expect(result.turns).toBe(3)
  })

  it('refuses under onToolError: throw without aborting the run', async () => {
    // The `blockedBy` trap, again: a routing policy is not a tool failure, so a
    // user who set `throw` for broken databases must not lose the run to it.
    const b = new Agent({ name: 'b', model: mockProvider([{ text: 'b answered' }]) })
    const a = new Agent({
      name: 'a',
      model: mockProvider([
        { toolCalls: [{ toolName: 'transfer_to_b' }] },
        { text: 'a answered directly' },
      ]),
      handoffs: [b],
      maxHandoffs: 0,
      onToolError: 'throw',
    })

    const result = await a.run('go')

    expect(result.stopReason).toBe('finish')
    expect(result.output).toBe('a answered directly')
    expect(result.agentPath).toEqual(['a'])
  })
})

describe('context transfer', () => {
  const seed: readonly ModelMessage[] = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: [{ type: 'text', text: 'four' }] },
  ]

  it('narrows what the receiving agent sees', async () => {
    const billingModel = mockProvider([{ text: 'done' }])
    const billing = new Agent({ name: 'billing', model: billingModel })
    const triage = new Agent({
      name: 'triage',
      model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }]),
      handoffs: [{ agent: billing, filter: (messages) => messages.slice(-2) }],
    })

    await triage.run('five', { messages: seed })

    expect(billingModel.calls[0]?.messages).toHaveLength(2)
  })

  it('narrows the view and nothing else — the run still returns everything', async () => {
    // The load-bearing assertion: a handoff must not be a way to delete a user's
    // history. The model sees less; the transcript keeps all of it.
    const billing = new Agent({ name: 'billing', model: mockProvider([{ text: 'done' }]) })
    const triage = new Agent({
      name: 'triage',
      model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }]),
      handoffs: [{ agent: billing, filter: () => [] }],
    })

    const result = await triage.run('five', { messages: seed })

    expect(result.messages.filter((m) => m.role !== 'system').length).toBeGreaterThan(5)
    expect(JSON.stringify(result.messages)).toContain('one')
  })

  it('persists the full conversation to the session, not the filtered view', async () => {
    const store = memorySession()
    const billing = new Agent({ name: 'billing', model: mockProvider([{ text: 'done' }]) })
    const triage = new Agent({
      name: 'triage',
      model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }]),
      handoffs: [{ agent: billing, filter: () => [] }],
      session: store,
    })

    await triage.run('remember this', { sessionId: 's1' })
    const stored = await store.load('s1')

    expect(JSON.stringify(stored)).toContain('remember this')
  })

  it('repairs a filter that orphans a tool result', async () => {
    // Slicing off the assistant turn but keeping its `tool` message is a 400 at
    // every provider. Repairing beats failing a live run over an off-by-one.
    const billingModel = mockProvider([{ text: 'done' }])
    const billing = new Agent({ name: 'billing', model: billingModel })
    const triage = new Agent({
      name: 'triage',
      model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }]),
      // Keeps the tool result, drops the assistant turn that produced it.
      handoffs: [{ agent: billing, filter: (messages) => messages.slice(-1) }],
    })

    await triage.run('go')

    const carried = billingModel.calls[0]?.messages ?? []
    expect(carried.some((m) => m.role === 'tool')).toBe(false)
  })

  it('round-trips result.messages back into a new run', async () => {
    const { triage } = pair(
      [{ toolCalls: [{ toolName: 'transfer_to_billing' }] }],
      [{ text: 'done' }],
    )

    const first = await triage.run('hi')
    const second = await triage.run('again', { messages: first.messages })

    expect(second.stopReason).toBe('finish')
  })
})

describe('events', () => {
  it('emits handoff.start between tool.end and the next model.request', async () => {
    const { triage } = pair(
      [{ toolCalls: [{ toolName: 'transfer_to_billing' }] }],
      [{ text: 'done' }],
    )

    const collected = collectEvents()
    await triage.run('go', { onEvent: collected.listener })

    expect(collected.types()).toEqual([
      'run.start',
      'model.request',
      'model.response',
      'tool.start',
      'tool.end',
      'handoff.start',
      'model.request',
      'model.response',
      'run.finish',
    ])
  })

  it('names the acting agent on every event after the transfer', async () => {
    const { triage } = pair(
      [{ toolCalls: [{ toolName: 'transfer_to_billing' }] }],
      [{ text: 'done' }],
    )

    const collected = collectEvents()
    await triage.run('go', { onEvent: collected.listener })

    // The transition belongs to the agent giving it up…
    expect(collected.first('handoff.start')?.agentName).toBe('triage')
    // …and everything after it to the one taking over.
    expect(collected.ofType('model.request').at(-1)?.agentName).toBe('billing')
    expect(collected.first('run.finish')?.agentName).toBe('billing')
    expect(collected.first('run.finish')?.agentPath).toEqual(['triage', 'billing'])
  })

  it('carries the route through stream()', async () => {
    const { triage } = pair(
      [{ toolCalls: [{ toolName: 'transfer_to_billing' }] }],
      [{ text: 'streamed answer' }],
    )

    const stream = triage.stream('go')
    const seen: string[] = []
    for await (const event of stream) {
      if (event.type === 'handoff.start') seen.push(`${event.from}→${event.to}`)
    }

    const result = await stream
    expect(seen).toEqual(['triage→billing'])
    expect(result.agentPath).toEqual(['triage', 'billing'])
  })
})

describe('guardrails and approval', () => {
  const confirmTransfer: ToolGuardrail = {
    name: 'confirm-transfer',
    tools: ['transfer_to_billing'],
    check: () => ({ requireApproval: true, reason: 'A human must approve a delegation.' }),
  }

  it('lets a tool guardrail reject a transfer', async () => {
    const billing = new Agent({ name: 'billing', model: mockProvider([{ text: 'never' }]) })
    const triage = new Agent({
      name: 'triage',
      model: mockProvider([
        { toolCalls: [{ toolName: 'transfer_to_billing' }] },
        { text: 'I will handle this myself.' },
      ]),
      handoffs: [billing],
      toolGuardrails: [
        { name: 'no-delegation', tools: ['transfer_to_billing'], check: () => ({ reject: 'No.' }) },
      ],
    })

    const result = await triage.run('go')

    expect(result.agentPath).toEqual(['triage'])
    expect(result.output).toBe('I will handle this myself.')
  })

  it('suspends a transfer for approval, then completes it on resume', async () => {
    // The highest-risk interaction in the whole step: an approved transfer must
    // take effect *before* the resumed run's first turn, or triage answers the
    // question it just delegated.
    const billingModel = mockProvider([{ text: 'billing took over' }])
    const billing = new Agent({ name: 'billing', model: billingModel })
    const triage = new Agent({
      name: 'triage',
      model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }]),
      handoffs: [billing],
      toolGuardrails: [confirmTransfer],
    })

    const error = (await triage.run('go').catch((e: unknown) => e)) as ApprovalRequiredError
    expect(error).toBeInstanceOf(ApprovalRequiredError)
    expect(error.suspension.pending.calls[0]?.toolName).toBe('transfer_to_billing')
    expect(billingModel.calls).toHaveLength(0)

    const final = await triage.resumeApproval(error.suspension, [
      { toolCallId: error.suspension.pending.calls[0]!.toolCallId, approved: true },
    ])

    expect(final.agentPath).toEqual(['triage', 'billing'])
    expect(final.output).toBe('billing took over')
    expect(billingModel.calls).toHaveLength(1)
  })

  it('a denied transfer leaves the routing agent holding the conversation', async () => {
    const billingModel = mockProvider([{ text: 'never' }])
    const billing = new Agent({ name: 'billing', model: billingModel })
    const triage = new Agent({
      name: 'triage',
      model: mockProvider([
        { toolCalls: [{ toolName: 'transfer_to_billing' }] },
        { text: 'Understood, I will answer myself.' },
      ]),
      handoffs: [billing],
      toolGuardrails: [confirmTransfer],
    })

    const error = (await triage.run('go').catch((e: unknown) => e)) as ApprovalRequiredError
    const final = await triage.resumeApproval(error.suspension, [
      { toolCallId: error.suspension.pending.calls[0]!.toolCallId, approved: false },
    ])

    expect(final.agentPath).toEqual(['triage'])
    expect(billingModel.calls).toHaveLength(0)
  })

  it('survives the suspension being serialized and parsed', async () => {
    const billing = new Agent({ name: 'billing', model: mockProvider([{ text: 'done' }]) })
    const triage = new Agent({
      name: 'triage',
      model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }]),
      handoffs: [billing],
      toolGuardrails: [confirmTransfer],
    })

    const error = (await triage.run('go').catch((e: unknown) => e)) as ApprovalRequiredError
    const revived = JSON.parse(JSON.stringify(error.suspension)) as typeof error.suspension

    const final = await triage.resumeApproval(revived, [
      { toolCallId: revived.pending.calls[0]!.toolCallId, approved: true },
    ])

    expect(final.agentPath).toEqual(['triage', 'billing'])
  })
})

describe('structured output', () => {
  const Ticket = z.object({ team: z.string(), summary: z.string() })

  it("the initiator's schema governs, and reaches the receiving agent", async () => {
    const billingModel = mockProvider([{ text: '{"team":"billing","summary":"Duplicate charge"}' }])
    const billing = new Agent({
      name: 'billing',
      instructions: 'You handle invoices.',
      model: billingModel,
      // Deliberately different, and deliberately ignored.
      outputSchema: z.object({ nonsense: z.number() }),
    })
    const triage = new Agent({
      name: 'triage',
      model: mockProvider([{ toolCalls: [{ toolName: 'transfer_to_billing' }] }]),
      handoffs: [billing],
      outputSchema: Ticket,
    })

    const result = await triage.run('I was charged twice.')

    expect(result.output).toEqual({ team: 'billing', summary: 'Duplicate charge' })
    // The specialist inherits the obligation, so it has to be told the shape.
    expect(billingModel.calls[0]?.system).toContain('You handle invoices.')
    expect(billingModel.calls[0]?.system).toContain('JSON')
  })
})

describe('construction errors', () => {
  it('rejects a transfer tool that collides with a real tool', () => {
    const billing = new Agent({ name: 'billing', model: mockProvider([{ text: '' }]) })
    const collide = tool({
      name: 'transfer_to_billing',
      description: 'Something else entirely.',
      execute: () => 'x',
    })

    expect(
      () =>
        new Agent({
          name: 'triage',
          model: mockProvider([{ text: '' }]),
          tools: [collide],
          handoffs: [billing],
        }),
    ).toThrow(ConfigurationError)
  })

  it('rejects two handoffs resolving to the same transfer tool', () => {
    const one = new Agent({ name: 'billing', model: mockProvider([{ text: '' }]) })
    const two = new Agent({ name: 'Billing', model: mockProvider([{ text: '' }]) })

    expect(
      () =>
        new Agent({ name: 'triage', model: mockProvider([{ text: '' }]), handoffs: [one, two] }),
    ).toThrow(/two handoffs both named/i)
  })

  it('rejects a target with no model', () => {
    expect(
      () =>
        new Agent({
          name: 'triage',
          model: mockProvider([{ text: '' }]),
          handoffs: [{ agent: { name: 'broken' } as never }],
        }),
    ).toThrow(/no valid model/i)
  })

  it('lets a tool guardrail name a transfer tool', () => {
    const billing = new Agent({ name: 'billing', model: mockProvider([{ text: '' }]) })

    expect(
      () =>
        new Agent({
          name: 'triage',
          model: mockProvider([{ text: '' }]),
          handoffs: [billing],
          toolGuardrails: [
            { name: 'g', tools: ['transfer_to_billing'], check: () => ({ allow: true }) },
          ],
        }),
    ).not.toThrow()
  })
})

describe('agents without handoffs', () => {
  it('still report a path of one', async () => {
    const result = await new Agent({ name: 'solo', model: mockProvider([{ text: 'hi' }]) }).run('x')

    expect(result.agentPath).toEqual(['solo'])
    expect(result.agentName).toBe('solo')
  })

  it('pay nothing for the feature', async () => {
    const resolve = vi.fn(() => 'lazily resolved')
    const unreached = new Agent({
      name: 'unreached',
      instructions: resolve,
      model: mockProvider([{ text: '' }]),
    })
    const triage = new Agent({
      name: 'triage',
      model: mockProvider([{ text: 'answered directly' }]),
      handoffs: [unreached],
    })

    await triage.run('x')

    // Resolution is lazy: an agent the run never reaches is never resolved.
    expect(resolve).not.toHaveBeenCalled()
  })
})
