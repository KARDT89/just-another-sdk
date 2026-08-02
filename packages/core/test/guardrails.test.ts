import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import * as z from 'zod'

import {
  Agent,
  ApprovalRequiredError,
  GuardrailError,
  memorySession,
  tool,
  type InputGuardrail,
  type OutputGuardrail,
} from '../src/index.js'
import { collectEvents, mockProvider } from '../src/testing/index.js'

/**
 * Guardrails: the policy layer around a run.
 *
 * The assertions that carry the design are marked. In short: an input guardrail
 * must reject *before* a token is spent, a guardrail that throws must fail
 * closed, and a blocked tool call must leave the run recoverable under **both**
 * `onToolError` policies.
 */

const tooLong: InputGuardrail = {
  name: 'max-length',
  check: (input) => (input.length > 20 ? { reject: 'Message too long.' } : { allow: true }),
}

const scrubEmail: OutputGuardrail = {
  name: 'pii-scrub',
  check: (output) => ({ allow: true, replace: output.replace(/\S+@\S+\.\w+/g, '[email]') }),
}

describe('input guardrails', () => {
  it('rejects before a single token is spent', async () => {
    // The load-bearing assertion: "rejected before spending a token" is the
    // claim, and an empty `calls` array is the receipt.
    const model = mockProvider([{ text: 'never reached' }])
    const agent = new Agent({ name: 'a', model, inputGuardrails: [tooLong] })

    await expect(agent.run('x'.repeat(50))).rejects.toThrow(GuardrailError)
    expect(model.calls).toHaveLength(0)
  })

  it('carries the guardrail name, stage, and reason', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, inputGuardrails: [tooLong] })

    const error = (await agent.run('x'.repeat(50)).catch((e: unknown) => e)) as GuardrailError

    expect(error.code).toBe('guardrail_blocked')
    expect(error.guardrail).toBe('max-length')
    expect(error.stage).toBe('input')
    expect(error.retryable).toBe(false)
    expect(error.message).toContain('Message too long.')
  })

  it('lets a short message through untouched', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const result = await new Agent({ name: 'a', model, inputGuardrails: [tooLong] }).run('hi')

    expect(result.text).toBe('ok')
    expect(model.calls).toHaveLength(1)
  })

  it('rewrites the input the model sees', async () => {
    const redact: InputGuardrail = {
      name: 'redact',
      check: (input) => ({ allow: true, replace: input.replace('secret', '[redacted]') }),
    }
    const model = mockProvider([{ text: 'ok' }])

    await new Agent({ name: 'a', model, inputGuardrails: [redact] }).run('my secret plan')

    expect(JSON.stringify(model.calls[0]?.messages)).toContain('[redacted]')
    expect(JSON.stringify(model.calls[0]?.messages)).not.toContain('secret plan')
  })

  it('runs in order, and a rewrite is visible to the next guardrail', async () => {
    // Sequential rather than concurrent, so scrub-then-check works.
    const shorten: InputGuardrail = {
      name: 'shorten',
      check: (input) => ({ allow: true, replace: input.slice(0, 10) }),
    }
    const model = mockProvider([{ text: 'ok' }])

    // Without the rewrite this 50-char input would be rejected by `tooLong`.
    const result = await new Agent({
      name: 'a',
      model,
      inputGuardrails: [shorten, tooLong],
    }).run('x'.repeat(50))

    expect(result.text).toBe('ok')
  })

  it('stops at the first rejection', async () => {
    const second = vi.fn(() => ({ allow: true }) as const)
    const model = mockProvider([{ text: 'ok' }])

    const agent = new Agent({
      name: 'a',
      model,
      inputGuardrails: [tooLong, { name: 'second', check: second }],
    })

    await expect(agent.run('x'.repeat(50))).rejects.toThrow(GuardrailError)
    expect(second).not.toHaveBeenCalled()
  })

  it('fails closed when a guardrail throws', async () => {
    // The opposite of `onEvent`, which swallows. A broken safety control must
    // not wave traffic through.
    const broken: InputGuardrail = {
      name: 'broken',
      check: () => {
        throw new Error('regex blew up')
      },
    }
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, inputGuardrails: [broken] })

    const error = (await agent.run('hi').catch((e: unknown) => e)) as GuardrailError

    expect(error).toBeInstanceOf(GuardrailError)
    expect(error.message).toContain('regex blew up')
    expect(error.cause).toBeInstanceOf(Error)
    expect(model.calls).toHaveLength(0)
  })

  it('emits guardrail.triggered then run.error', async () => {
    const collected = collectEvents()
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, inputGuardrails: [tooLong] })

    await expect(agent.run('x'.repeat(50), { onEvent: collected.listener })).rejects.toThrow(
      GuardrailError,
    )

    const triggered = collected.first('guardrail.triggered')
    expect(triggered?.guardrail).toBe('max-length')
    expect(triggered?.stage).toBe('input')
    expect(triggered?.action).toBe('reject')
    expect(collected.types().at(-1)).toBe('run.error')
  })

  it('sees the loaded session history', async () => {
    const store = memorySession()
    const seen: number[] = []
    const inspect: InputGuardrail = {
      name: 'inspect',
      check: (_input, context) => {
        seen.push(context.messages.length)
        return { allow: true }
      },
    }
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, session: store, inputGuardrails: [inspect] })

    await agent.run('one', { sessionId: 's' })
    await agent.run('two', { sessionId: 's' })

    // First run: just the new turn. Second: the stored exchange plus the turn.
    expect(seen[0]).toBe(1)
    expect(seen[1]).toBeGreaterThan(1)
  })

  it('persists nothing when the input is rejected', async () => {
    const store = memorySession()
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({ name: 'a', model, session: store, inputGuardrails: [tooLong] })

    await expect(agent.run('x'.repeat(50), { sessionId: 's' })).rejects.toThrow(GuardrailError)
    expect(await store.load('s')).toEqual([])
  })
})

describe('output guardrails', () => {
  it('rewrites the answer, the transcript, and the session', async () => {
    // All three, or the un-scrubbed text comes back on the next turn.
    const store = memorySession()
    const model = mockProvider([{ text: 'Reach me at ada@example.com today.' }])

    const result = await new Agent({
      name: 'a',
      model,
      session: store,
      outputGuardrails: [scrubEmail],
    }).run('hi', { sessionId: 's' })

    expect(result.output).toBe('Reach me at [email] today.')
    expect(result.text).toBe('Reach me at [email] today.')
    expect(JSON.stringify(result.messages)).not.toContain('ada@example.com')
    expect(JSON.stringify(await store.load('s'))).not.toContain('ada@example.com')
  })

  it('keeps steps and messages in agreement after a rewrite', async () => {
    const model = mockProvider([{ text: 'Reach me at ada@example.com.' }])
    const result = await new Agent({
      name: 'a',
      model,
      outputGuardrails: [scrubEmail],
    }).run('hi')

    expect(result.steps.at(-1)?.text).toBe(result.text)
  })

  it('throws on rejection and persists nothing', async () => {
    const store = memorySession()
    const model = mockProvider([{ text: 'forbidden' }])
    const banned: OutputGuardrail = {
      name: 'banned-words',
      check: (output) =>
        output.includes('forbidden') ? { reject: 'Contains a banned word.' } : { allow: true },
    }

    const agent = new Agent({ name: 'a', model, session: store, outputGuardrails: [banned] })
    const error = (await agent
      .run('hi', { sessionId: 's' })
      .catch((e: unknown) => e)) as GuardrailError

    expect(error).toBeInstanceOf(GuardrailError)
    expect(error.stage).toBe('output')
    expect(await store.load('s')).toEqual([])
  })

  it('receives the validated object when there is an outputSchema', async () => {
    const Ticket = z.object({ severity: z.number(), summary: z.string() })
    const model = mockProvider([{ text: '{"severity":3,"summary":"Login fails"}' }])

    const escalate: OutputGuardrail<z.infer<typeof Ticket>> = {
      name: 'escalate',
      check: (output) => {
        expectTypeOf(output.severity).toEqualTypeOf<number>()
        return { allow: true, replace: { ...output, severity: output.severity + 1 } }
      },
    }

    const result = await new Agent({
      name: 'a',
      model,
      outputSchema: Ticket,
      outputGuardrails: [escalate],
    }).run('hi')

    expect(result.output.severity).toBe(4)
    // The rewrite is re-serialised, so text and messages agree with output.
    expect(JSON.parse(result.text)).toEqual({ severity: 4, summary: 'Login fails' })
  })

  it('runs against the repaired object, not the failed one', async () => {
    const Ticket = z.object({ severity: z.number() })
    const model = mockProvider([{ text: '{"severity":"high"}' }, { text: '{"severity":2}' }])
    const seen: unknown[] = []

    await new Agent({
      name: 'a',
      model,
      outputSchema: Ticket,
      outputGuardrails: [
        {
          name: 'observe',
          check: (output) => {
            seen.push(output)
            return { allow: true }
          },
        },
      ],
    }).run('hi')

    expect(seen).toEqual([{ severity: 2 }])
  })

  it('still runs when the loop stopped at max_turns', async () => {
    const ping = tool({ name: 'ping', description: 'x', execute: () => 'pong' })
    const model = mockProvider([{ toolCalls: [{ toolName: 'ping' }], text: 'partial answer' }])
    const seen: unknown[] = []

    const result = await new Agent({
      name: 'a',
      model,
      tools: [ping],
      maxTurns: 1,
      outputGuardrails: [
        {
          name: 'observe',
          check: (output) => {
            seen.push(output)
            return { allow: true }
          },
        },
      ],
    }).run('hi')

    expect(result.stopReason).toBe('max_turns')
    expect(seen).toEqual(['partial answer'])
  })

  it('changes nothing for an agent with no guardrails', async () => {
    const model = mockProvider([{ text: 'plain' }])
    const result = await new Agent({ name: 'a', model }).run('hi')

    expect(result.output).toBe('plain')
    expect(result.text).toBe('plain')
  })
})

/* ── Tool guardrails ──────────────────────────────────────────────────────── */

const deleteAccount = tool({
  name: 'delete_account',
  description: 'Permanently delete an account.',
  inputSchema: z.object({ id: z.string() }),
  execute: ({ id }) => ({ deleted: id }),
})

const lookup = tool({
  name: 'lookup',
  description: 'Look something up.',
  inputSchema: z.object({ q: z.string() }),
  execute: ({ q }) => ({ q, found: true }),
})

/** Blocks every call to `delete_account`. */
const noDeletes = {
  name: 'no-deletes',
  tools: ['delete_account'],
  check: () => ({ reject: 'Deleting accounts is not permitted.' }) as const,
}

describe('tool guardrails', () => {
  it('blocks the call, and the run still finishes', async () => {
    // The acceptance criterion.
    const model = mockProvider([
      { toolCalls: [{ toolName: 'delete_account', input: { id: 'u1' } }] },
      { text: 'I am not able to delete that account.' },
    ])

    const result = await new Agent({
      name: 'a',
      model,
      tools: [deleteAccount],
      toolGuardrails: [noDeletes],
    }).run('delete u1')

    expect(result.stopReason).toBe('finish')
    expect(result.text).toContain('not able to delete')
    expect(result.steps[0]?.toolResults[0]?.isError).toBe(true)
  })

  it('still finishes under onToolError: throw', async () => {
    // The trap. A policy decision is not a tool failure, so a user who set this
    // flag to abort on a broken database must not be aborted by a guardrail.
    const model = mockProvider([
      { toolCalls: [{ toolName: 'delete_account', input: { id: 'u1' } }] },
      { text: 'Refused.' },
    ])

    const result = await new Agent({
      name: 'a',
      model,
      tools: [deleteAccount],
      toolGuardrails: [noDeletes],
      onToolError: 'throw',
    }).run('delete u1')

    expect(result.stopReason).toBe('finish')
  })

  it('never invokes the handler', async () => {
    const execute = vi.fn(() => ({ deleted: true }))
    const dangerous = tool({
      name: 'delete_account',
      description: 'x',
      inputSchema: z.object({ id: z.string() }),
      execute,
    })
    const model = mockProvider([
      { toolCalls: [{ toolName: 'delete_account', input: { id: 'u1' } }] },
      { text: 'ok' },
    ])

    await new Agent({
      name: 'a',
      model,
      tools: [dangerous],
      toolGuardrails: [noDeletes],
    }).run('go')

    expect(execute).not.toHaveBeenCalled()
  })

  it('gates every tool when `tools` is omitted', async () => {
    const model = mockProvider([
      { toolCalls: [{ toolName: 'lookup', input: { q: 'x' } }] },
      { text: 'ok' },
    ])

    const result = await new Agent({
      name: 'a',
      model,
      tools: [lookup],
      toolGuardrails: [{ name: 'freeze', check: () => ({ reject: 'Read-only mode.' }) }],
    }).run('go')

    expect(result.steps[0]?.toolResults[0]?.isError).toBe(true)
  })

  it('leaves other tools alone when `tools` names one', async () => {
    const model = mockProvider([
      {
        toolCalls: [
          { toolName: 'delete_account', input: { id: 'u1' } },
          { toolName: 'lookup', input: { q: 'x' } },
        ],
      },
      { text: 'ok' },
    ])

    const result = await new Agent({
      name: 'a',
      model,
      tools: [deleteAccount, lookup],
      toolGuardrails: [noDeletes],
    }).run('go')

    const [blocked, allowed] = result.steps[0]?.toolResults ?? []
    expect(blocked?.isError).toBe(true)
    expect(allowed?.isError).toBeUndefined()
    expect(allowed?.output).toEqual({ q: 'x', found: true })
  })

  it('sees validated, coerced arguments', async () => {
    // Proves the seam is after the schema, not before it.
    const coercing = tool({
      name: 'count',
      description: 'x',
      inputSchema: z.object({ n: z.coerce.number() }),
      execute: ({ n }) => n,
    })
    const seen: unknown[] = []
    const model = mockProvider([
      { toolCalls: [{ toolName: 'count', input: { n: '42' } }] },
      { text: 'ok' },
    ])

    await new Agent({
      name: 'a',
      model,
      tools: [coercing],
      toolGuardrails: [
        {
          name: 'observe',
          check: ({ input }) => {
            seen.push(input)
            return { allow: true }
          },
        },
      ],
    }).run('go')

    expect(seen).toEqual([{ n: 42 }])
  })

  it('fails closed when a tool guardrail throws, without aborting the run', async () => {
    const model = mockProvider([
      { toolCalls: [{ toolName: 'lookup', input: { q: 'x' } }] },
      { text: 'recovered' },
    ])

    const result = await new Agent({
      name: 'a',
      model,
      tools: [lookup],
      toolGuardrails: [
        {
          name: 'broken',
          check: () => {
            throw new Error('policy service down')
          },
        },
      ],
    }).run('go')

    expect(result.stopReason).toBe('finish')
    const output = result.steps[0]?.toolResults[0]?.output as { error: string }
    expect(output.error).toContain('policy service down')
  })

  it('emits guardrail.triggered with the tool name and call id', async () => {
    const collected = collectEvents()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'delete_account', input: { id: 'u1' } }] },
      { text: 'ok' },
    ])

    await new Agent({
      name: 'a',
      model,
      tools: [deleteAccount],
      toolGuardrails: [noDeletes],
    }).run('go', { onEvent: collected.listener })

    const triggered = collected.first('guardrail.triggered')
    expect(triggered?.stage).toBe('tool')
    expect(triggered?.action).toBe('reject')
    expect(triggered?.guardrail).toBe('no-deletes')
    expect(triggered?.toolName).toBe('delete_account')
    expect(triggered?.toolCallId).toBeDefined()
  })

  it('rejects a guardrail naming an unregistered tool, at construction', async () => {
    // A typo in a security control fails *open* if it is only a no-op.
    const model = mockProvider([{ text: 'ok' }])

    expect(
      () =>
        new Agent({
          name: 'a',
          model,
          tools: [lookup],
          toolGuardrails: [{ name: 'typo', tools: ['lookkup'], check: () => ({ allow: true }) }],
        }),
    ).toThrow(/unregistered tool "lookkup"/)
  })
})

/* ── Approval ─────────────────────────────────────────────────────────────── */

/** Gates a refund over $100. */
const refundCap = {
  name: 'refund-cap',
  tools: ['refund_order'],
  check: ({ input }: { input: unknown }) =>
    (input as { amount: number }).amount > 100
      ? ({ requireApproval: true, reason: 'Refunds over $100 need a human.' } as const)
      : ({ allow: true } as const),
}

function refundTool(execute = vi.fn((args: { amount: number }) => ({ refunded: args.amount }))) {
  return {
    execute,
    tool: tool({
      name: 'refund_order',
      description: 'Refund an order.',
      inputSchema: z.object({ amount: z.number() }),
      execute,
    }),
  }
}

describe('approval', () => {
  it('suspends with the gated call, and never runs the handler', async () => {
    const { tool: refund, execute } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 500 } }] },
      { text: 'Done.' },
    ])

    const agent = new Agent({ name: 'a', model, tools: [refund], toolGuardrails: [refundCap] })
    const error = (await agent.run('refund 500').catch((e: unknown) => e)) as ApprovalRequiredError

    expect(error).toBeInstanceOf(ApprovalRequiredError)
    expect(error.code).toBe('approval_required')
    expect(error.suspension.pending.calls).toHaveLength(1)
    expect(error.suspension.pending.calls[0]?.toolName).toBe('refund_order')
    expect(error.suspension.pending.calls[0]?.input).toEqual({ amount: 500 })
    expect(error.suspension.pending.calls[0]?.reason).toContain('need a human')
    expect(execute).not.toHaveBeenCalled()
  })

  it('lets an ungated call through', async () => {
    const { tool: refund, execute } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 20 } }] },
      { text: 'Refunded.' },
    ])

    const result = await new Agent({
      name: 'a',
      model,
      tools: [refund],
      toolGuardrails: [refundCap],
    }).run('refund 20')

    expect(result.stopReason).toBe('finish')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('runs no tool in a turn where any call needs approval', async () => {
    // The double-execution trap: without an all-or-nothing gate, `lookup` would
    // run now and again on resume.
    const lookupSpy = vi.fn(({ q }: { q: string }) => ({ q }))
    const searchTool = tool({
      name: 'lookup',
      description: 'x',
      inputSchema: z.object({ q: z.string() }),
      execute: lookupSpy,
    })
    const { tool: refund, execute: refundSpy } = refundTool()

    const model = mockProvider([
      {
        toolCalls: [
          { toolName: 'lookup', input: { q: 'orders' } },
          { toolName: 'refund_order', input: { amount: 500 } },
        ],
      },
      { text: 'All done.' },
    ])

    const agent = new Agent({
      name: 'a',
      model,
      tools: [searchTool, refund],
      toolGuardrails: [refundCap],
    })
    const error = (await agent.run('go').catch((e: unknown) => e)) as ApprovalRequiredError

    expect(error).toBeInstanceOf(ApprovalRequiredError)
    expect(lookupSpy).not.toHaveBeenCalled()

    // After resume each runs exactly once.
    const result = await agent.resumeApproval(error.suspension, [
      { toolCallId: error.suspension.pending.calls[0]!.toolCallId, approved: true },
    ])

    expect(result.stopReason).toBe('finish')
    expect(lookupSpy).toHaveBeenCalledTimes(1)
    expect(refundSpy).toHaveBeenCalledTimes(1)
  })

  it('survives a JSON round trip and resumes to completion', async () => {
    // Proves the suspension really is plain data that can cross a process.
    const { tool: refund, execute } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 500 } }] },
      { text: 'Refunded $500.' },
    ])

    const agent = new Agent({ name: 'a', model, tools: [refund], toolGuardrails: [refundCap] })
    const error = (await agent.run('refund 500').catch((e: unknown) => e)) as ApprovalRequiredError

    const wire = JSON.parse(JSON.stringify(error.suspension)) as typeof error.suspension
    const result = await agent.resumeApproval(wire, [
      { toolCallId: wire.pending.calls[0]!.toolCallId, approved: true },
    ])

    expect(result.text).toBe('Refunded $500.')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('records the resume as a step but not as a turn', async () => {
    const { tool: refund } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 500 } }] },
      { text: 'Refunded.' },
    ])

    const agent = new Agent({ name: 'a', model, tools: [refund], toolGuardrails: [refundCap] })
    const error = (await agent.run('go').catch((e: unknown) => e)) as ApprovalRequiredError
    const result = await agent.resumeApproval(error.suspension, [
      { toolCallId: error.suspension.pending.calls[0]!.toolCallId, approved: true },
    ])

    expect(result.steps[0]?.kind).toBe('resume')
    expect(result.steps[0]?.turn).toBe(0)
    expect(result.steps.map((s) => s.kind)).toEqual(['resume', 'turn'])
    expect(result.turns).toBe(1)
  })

  it('denial never runs the tool, and the model explains', async () => {
    const { tool: refund, execute } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 500 } }] },
      { text: 'Sorry, that refund was declined.' },
    ])

    const agent = new Agent({ name: 'a', model, tools: [refund], toolGuardrails: [refundCap] })
    const error = (await agent.run('go').catch((e: unknown) => e)) as ApprovalRequiredError

    const result = await agent.resumeApproval(error.suspension, [
      {
        toolCallId: error.suspension.pending.calls[0]!.toolCallId,
        approved: false,
        reason: 'Outside policy this month.',
      },
    ])

    expect(execute).not.toHaveBeenCalled()
    expect(result.stopReason).toBe('finish')
    expect(JSON.stringify(result.messages)).toContain('Outside policy this month.')
  })

  it('throws on a decision naming an unknown call', async () => {
    const { tool: refund } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 500 } }] },
      { text: 'ok' },
    ])

    const agent = new Agent({ name: 'a', model, tools: [refund], toolGuardrails: [refundCap] })
    const error = (await agent.run('go').catch((e: unknown) => e)) as ApprovalRequiredError

    await expect(
      agent.resumeApproval(error.suspension, [{ toolCallId: 'made-up', approved: true }]),
    ).rejects.toThrow(/No pending tool call with id "made-up"/)
  })

  it('re-suspends when a decision is missing', async () => {
    const { tool: refund } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 500 } }] },
      { text: 'ok' },
    ])

    const agent = new Agent({ name: 'a', model, tools: [refund], toolGuardrails: [refundCap] })
    const error = (await agent.run('go').catch((e: unknown) => e)) as ApprovalRequiredError

    await expect(agent.resumeApproval(error.suspension, [])).rejects.toThrow(ApprovalRequiredError)
  })

  it('suspends again if the model calls the gated tool a second time', async () => {
    // Replay: an approval authorises one call once, never standing permission.
    const { tool: refund, execute } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 500 } }] },
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 600 } }] },
      { text: 'ok' },
    ])

    const agent = new Agent({ name: 'a', model, tools: [refund], toolGuardrails: [refundCap] })
    const first = (await agent.run('go').catch((e: unknown) => e)) as ApprovalRequiredError

    const second = (await agent
      .resumeApproval(first.suspension, [
        { toolCallId: first.suspension.pending.calls[0]!.toolCallId, approved: true },
      ])
      .catch((e: unknown) => e)) as ApprovalRequiredError

    expect(second).toBeInstanceOf(ApprovalRequiredError)
    expect(second.suspension.pending.calls[0]?.input).toEqual({ amount: 600 })
    // Only the first, authorised call ran.
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('cannot override an outright reject with an approval', async () => {
    const { tool: refund, execute } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 500 } }] },
      { text: 'ok' },
    ])

    // One guardrail wants a human; a second refuses outright.
    const agent = new Agent({
      name: 'a',
      model,
      tools: [refund],
      toolGuardrails: [
        refundCap,
        { name: 'frozen', tools: ['refund_order'], check: () => ({ reject: 'Refunds frozen.' }) },
      ],
    })

    const error = (await agent.run('go').catch((e: unknown) => e)) as ApprovalRequiredError
    const result = await agent.resumeApproval(error.suspension, [
      { toolCallId: error.suspension.pending.calls[0]!.toolCallId, approved: true },
    ])

    expect(execute).not.toHaveBeenCalled()
    const output = result.steps[0]?.toolResults[0]?.output as { error: string }
    expect(output.error).toBe('Refunds frozen.')
  })

  it('persists nothing at suspension, and the whole exchange once after resume', async () => {
    const store = memorySession()
    const { tool: refund } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 500 } }] },
      { text: 'Refunded.' },
    ])

    const agent = new Agent({
      name: 'a',
      model,
      tools: [refund],
      toolGuardrails: [refundCap],
      session: store,
    })

    const error = (await agent
      .run('refund 500', { sessionId: 'u1' })
      .catch((e: unknown) => e)) as ApprovalRequiredError

    expect(error).toBeInstanceOf(ApprovalRequiredError)
    expect(await store.load('u1')).toEqual([])

    await agent.resumeApproval(error.suspension, [
      { toolCallId: error.suspension.pending.calls[0]!.toolCallId, approved: true },
    ])

    const saved = await store.load('u1')
    // user, assistant(tool-call), tool result, assistant answer — exactly once.
    expect(saved).toHaveLength(4)
    expect(saved.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('emits approval.required, then approval.resolved on resume', async () => {
    const suspendEvents = collectEvents()
    const resumeEvents = collectEvents()
    const { tool: refund } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 500 } }] },
      { text: 'ok' },
    ])

    const agent = new Agent({ name: 'a', model, tools: [refund], toolGuardrails: [refundCap] })
    const error = (await agent
      .run('go', { onEvent: suspendEvents.listener })
      .catch((e: unknown) => e)) as ApprovalRequiredError

    expect(suspendEvents.first('approval.required')?.calls).toHaveLength(1)
    expect(suspendEvents.types().at(-1)).toBe('run.error')

    await agent.resumeApproval(
      error.suspension,
      [{ toolCallId: error.suspension.pending.calls[0]!.toolCallId, approved: true }],
      { onEvent: resumeEvents.listener },
    )

    const resolved = resumeEvents.first('approval.resolved')
    expect(resolved?.approved).toBe(true)
    expect(resolved?.toolName).toBe('refund_order')
  })

  it('suspends identically through stream()', async () => {
    // Invariant 4: a streamed run is the same run.
    const { tool: refund } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 500 } }] },
      { text: 'ok' },
    ])

    const agent = new Agent({ name: 'a', model, tools: [refund], toolGuardrails: [refundCap] })
    const stream = agent.stream('go')

    const seen: string[] = []
    try {
      for await (const event of stream) seen.push(event.type)
    } catch {
      // The iterator rejects with the same error the promise does.
    }

    await expect(stream.completed).rejects.toThrow(ApprovalRequiredError)
    expect(seen).toContain('approval.required')
  })

  it('keeps the conversation out of the error toJSON', async () => {
    const { tool: refund } = refundTool()
    const model = mockProvider([
      { toolCalls: [{ toolName: 'refund_order', input: { amount: 500 } }] },
      { text: 'ok' },
    ])

    const agent = new Agent({ name: 'a', model, tools: [refund], toolGuardrails: [refundCap] })
    const error = (await agent
      .run('a very distinctive user message')
      .catch((e: unknown) => e)) as ApprovalRequiredError

    const json = JSON.stringify(error.toJSON())
    expect(json).not.toContain('a very distinctive user message')
    expect(json).toContain('refund_order')
    // But the caller holding the error has everything it needs.
    expect(JSON.stringify(error.suspension.messages)).toContain('a very distinctive user message')
  })
})
