import { describe, expect, it } from 'vitest'

import { estimateTokens, trimHistory } from '../src/index.js'
import { assistantMessage, toolMessage, userMessage } from '../src/index.js'
import type { ModelMessage } from '../src/index.js'

/**
 * Trimming is the one part of the session layer that silently changes what the
 * model sees, so its rules are pinned here rather than left to the adapters.
 */

const assistantWithCall = (id: string): ModelMessage =>
  assistantMessage([{ type: 'tool-call', toolCallId: id, toolName: 'lookup', input: {} }])

const toolResult = (id: string): ModelMessage =>
  toolMessage([{ type: 'tool-result', toolCallId: id, toolName: 'lookup', output: 'ok' }])

describe('trimHistory', () => {
  it('returns the history untouched without a policy', () => {
    const history = [userMessage('a'), userMessage('b')]
    expect(trimHistory(history, undefined)).toBe(history)
    expect(trimHistory(history, {})).toBe(history)
  })

  it('keeps the newest messages when over the count limit', () => {
    const history = [userMessage('1'), userMessage('2'), userMessage('3'), userMessage('4')]

    const trimmed = trimHistory(history, { maxMessages: 2 })

    expect(trimmed).toHaveLength(2)
    expect(trimmed.map((m) => m.content)).toEqual(['3', '4'])
  })

  it('does nothing when the history already fits', () => {
    const history = [userMessage('1'), userMessage('2')]
    expect(trimHistory(history, { maxMessages: 5 })).toBe(history)
  })

  it('never begins on an orphaned tool result', () => {
    // Trimming to 2 would cut between the assistant's tool call and its result,
    // which every provider rejects. The tool message has to go too.
    const history = [
      userMessage('question'),
      assistantWithCall('call_1'),
      toolResult('call_1'),
      assistantMessage([{ type: 'text', text: 'answer' }]),
    ]

    const trimmed = trimHistory(history, { maxMessages: 2 })

    expect(trimmed.map((m) => m.role)).toEqual(['assistant'])
    expect(trimmed[0]).toBe(history[3])
  })

  it('keeps the newest message even when it alone exceeds the token budget', () => {
    const history = [userMessage('short'), userMessage('x'.repeat(10_000))]

    const trimmed = trimHistory(history, { maxTokens: 10 })

    expect(trimmed).toHaveLength(1)
    expect(trimmed[0]).toBe(history[1])
  })

  it('drops the oldest messages until the token budget fits', () => {
    // 40 characters ≈ 10 tokens each, plus 4 tokens of overhead.
    const history = [
      userMessage('a'.repeat(40)),
      userMessage('b'.repeat(40)),
      userMessage('c'.repeat(40)),
    ]

    expect(estimateTokens(history[0] as ModelMessage)).toBe(14)

    const trimmed = trimHistory(history, { maxTokens: 30 })

    expect(trimmed).toHaveLength(2)
    expect(trimmed.map((m) => (m.content as string)[0])).toEqual(['b', 'c'])
  })

  it('honours a custom token counter', () => {
    const history = [userMessage('a'), userMessage('b'), userMessage('c')]

    // Every message costs 10, so a budget of 25 fits exactly two.
    const trimmed = trimHistory(history, { maxTokens: 25, countTokens: () => 10 })

    expect(trimmed.map((m) => m.content)).toEqual(['b', 'c'])
  })

  it('applies whichever of the two limits bites first', () => {
    const history = [userMessage('1'), userMessage('2'), userMessage('3'), userMessage('4')]

    expect(trimHistory(history, { maxMessages: 3, maxTokens: 100_000 })).toHaveLength(3)
    expect(
      trimHistory(history, { maxMessages: 3, countTokens: () => 10, maxTokens: 15 }),
    ).toHaveLength(1)
  })

  it('handles an empty history', () => {
    expect(trimHistory([], { maxMessages: 2, maxTokens: 5 })).toEqual([])
  })
})

describe('estimateTokens', () => {
  it('scales with content length', () => {
    const short = estimateTokens(userMessage('hi'))
    const long = estimateTokens(userMessage('hi'.repeat(1000)))
    expect(long).toBeGreaterThan(short)
  })

  it('measures structured content, not "[object Object]"', () => {
    const small = estimateTokens(assistantMessage([{ type: 'text', text: 'x' }]))
    const large = estimateTokens(assistantMessage([{ type: 'text', text: 'x'.repeat(400) }]))
    expect(large - small).toBeGreaterThan(90)
  })
})
