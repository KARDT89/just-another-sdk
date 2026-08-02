import { describe, expect, it } from 'vitest'

import { Agent, memorySession, userMessage } from '../src/index.js'
import type { ModelMessage, SessionStore } from '../src/index.js'
import { applySummary, isSummaryMessage, summaryMessage } from '../src/sessions/summarize.js'
import { collectEvents, mockProvider } from '../src/testing/index.js'

/**
 * Summarization is the one part of the session layer that spends money on its
 * own initiative, so two things matter equally: that it works, and that it can
 * never take the run down with it.
 */

/** A store already holding `count` user turns. */
async function seeded(count: number): Promise<SessionStore> {
  const store = memorySession()
  const messages: ModelMessage[] = []
  for (let i = 1; i <= count; i += 1) messages.push(userMessage(`message ${i}`))
  await store.append('s', messages)
  return store
}

describe('summary messages', () => {
  it('round-trips its watermark', () => {
    const summary = summaryMessage(42, 'Ada is building an SDK.')

    expect(isSummaryMessage(summary)).toBe(true)
    expect(summary.content).toContain('Ada is building an SDK.')
    expect(summary.content).toContain('first 42 messages')
  })

  it('does not mistake an ordinary message for a summary', () => {
    expect(isSummaryMessage(userMessage('Summary of the first 3 messages'))).toBe(false)
    expect(isSummaryMessage(userMessage('hello'))).toBe(false)
  })
})

describe('applySummary', () => {
  it('returns the log untouched when there is no summary', () => {
    const stored = [userMessage('a'), userMessage('b')]
    expect(applySummary(stored)).toBe(stored)
  })

  it('replaces covered messages and keeps the rest verbatim', () => {
    // The summary is appended *after* the messages it covers, because the log is
    // append-only — the watermark, not the position, says where verbatim
    // history resumes.
    const stored = [
      userMessage('1'),
      userMessage('2'),
      userMessage('3'),
      summaryMessage(2, 'covered one and two'),
    ]

    const applied = applySummary(stored)

    expect(applied).toHaveLength(2)
    expect(isSummaryMessage(applied[0] as ModelMessage)).toBe(true)
    expect(applied[1]?.content).toBe('3')
  })

  it('prefers the summary covering the most, not the last appended', () => {
    // Two concurrent runs can each append a summary. The one that folded more is
    // the more recent fold, whatever order they landed in.
    const stored = [
      userMessage('1'),
      userMessage('2'),
      userMessage('3'),
      summaryMessage(3, 'covers three'),
      summaryMessage(2, 'covers two'),
    ]

    const applied = applySummary(stored)

    expect(applied[0]?.content).toContain('covers three')
    expect(applied.filter((m) => isSummaryMessage(m))).toHaveLength(1)
  })

  it('never sends two summaries', () => {
    const stored = [
      userMessage('1'),
      summaryMessage(1, 'first fold'),
      userMessage('2'),
      summaryMessage(3, 'second fold'),
    ]

    expect(applySummary(stored).filter((m) => isSummaryMessage(m))).toHaveLength(1)
  })
})

describe('summarizing at the run boundary', () => {
  it('folds dropped history into one summary and keeps the rest verbatim', async () => {
    const store = await seeded(6)

    // Turn 1 is the summarizer; turn 2 is the run's own answer.
    const model = mockProvider([{ text: 'Ada asked six things.' }, { text: 'ok' }])
    const agent = new Agent({
      name: 'a',
      model,
      session: store,
      context: { maxMessages: 2, summarize: true },
    })

    await agent.run('now', { sessionId: 's' })

    const sent = model.calls[1]?.messages ?? []
    expect(sent[0]?.content).toContain('Ada asked six things.')
    // A fold compacts to *half* the budget, not to the budget, so that the next
    // few turns do not immediately buy another summary.
    expect(sent.slice(1).map((m) => m.content)).toEqual(['message 6', 'now'])
  })

  it('leaves the original messages in the store', async () => {
    const store = await seeded(6)
    const model = mockProvider([{ text: 'a recap' }, { text: 'ok' }])
    const agent = new Agent({
      name: 'a',
      model,
      session: store,
      context: { maxMessages: 2, summarize: true },
    })

    await agent.run('now', { sessionId: 's' })

    // Summarizing writes one message; it never deletes any.
    const stored = await store.load('s')
    expect(stored.filter((m) => !isSummaryMessage(m)).map((m) => m.content)).toContain('message 1')
    expect(stored.filter((m) => isSummaryMessage(m))).toHaveLength(1)
  })

  it('reuses a stored summary rather than folding again every run', async () => {
    const store = await seeded(12)
    const model = mockProvider([{ text: 'recap one' }, { text: 'ok' }, { text: 'ok again' }])
    const agent = new Agent({
      name: 'a',
      model,
      session: store,
      context: { maxMessages: 8, summarize: true },
    })

    await agent.run('first', { sessionId: 's' })
    const callsAfterFirst = model.calls.length

    await agent.run('second', { sessionId: 's' })

    // The transcript is still inside the budget once the stored summary stands
    // in for the messages it covers, so the second run pays for no summary.
    expect(model.calls.length).toBe(callsAfterFirst + 1)
    expect(model.calls.at(-1)?.messages[0]?.content).toContain('recap one')
  })

  it('folds again as the conversation grows, and never sends two summaries', async () => {
    const store = await seeded(12)
    const model = mockProvider([
      { text: 'recap one' },
      { text: 'ok' },
      { text: 'recap two' },
      { text: 'ok again' },
    ])
    const agent = new Agent({
      name: 'a',
      model,
      session: store,
      context: { maxMessages: 4, summarize: true },
    })

    await agent.run('first', { sessionId: 's' })
    await agent.run('second', { sessionId: 's' })

    // Summaries compound: the second fold is handed the first one to build on,
    // and the run that follows sees exactly one of them.
    const secondSummarizerInput = String(model.calls[2]?.messages[0]?.content)
    expect(secondSummarizerInput).toContain('recap one')

    const finalContext = model.calls[3]?.messages ?? []
    expect(finalContext.filter((m) => isSummaryMessage(m))).toHaveLength(1)
    expect(finalContext[0]?.content).toContain('recap two')
  })

  it('does not summarize when nothing was dropped', async () => {
    const store = await seeded(1)
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({
      name: 'a',
      model,
      session: store,
      context: { maxMessages: 10, summarize: true },
    })

    await agent.run('now', { sessionId: 's' })

    expect(model.calls).toHaveLength(1)
  })

  it('reports the fold in an event', async () => {
    const store = await seeded(6)
    const model = mockProvider([{ text: 'a recap' }, { text: 'ok' }])
    const agent = new Agent({
      name: 'a',
      model,
      session: store,
      context: { maxMessages: 2, summarize: true },
    })
    const events = collectEvents()

    await agent.run('now', { sessionId: 's', onEvent: events.listener })

    const summarized = events.ofType('session.summarize')[0]
    // Six stored; a budget of 2 folds down to 1 kept verbatim, so the summary
    // stands in for the other five.
    expect(summarized?.coveredCount).toBe(5)
    expect(summarized?.foldedCount).toBe(5)
    expect(summarized?.keptCount).toBe(1)
    expect(summarized?.error).toBeUndefined()
  })

  it('survives a summarizer that throws, and says so', async () => {
    const store = await seeded(6)

    // The first call is the summarizer and it fails; the run's own call is next.
    let call = 0
    const model = mockProvider(() => {
      call += 1
      return call === 1 ? { error: new Error('summarizer is down') } : { text: 'answered anyway' }
    })

    const agent = new Agent({
      name: 'a',
      model,
      session: store,
      maxRetries: 0,
      context: { maxMessages: 2, summarize: true },
    })
    const events = collectEvents()

    const result = await agent.run('now', { sessionId: 's', onEvent: events.listener })

    // The run answered. That is the whole point.
    expect(result.text).toBe('answered anyway')
    expect(events.ofType('session.summarize')[0]?.error?.message).toContain('summarizer is down')
    // Fell back to plain trimming, so history is the tail with no summary.
    expect((await store.load('s')).filter((m) => isSummaryMessage(m))).toHaveLength(0)
  })

  it('summarizes with a separate model when given one', async () => {
    const store = await seeded(6)
    const cheap = mockProvider([{ text: 'cheap recap' }], { modelId: 'cheap/model' })
    const main = mockProvider([{ text: 'ok' }], { modelId: 'main/model' })

    const agent = new Agent({
      name: 'a',
      model: main,
      session: store,
      context: { maxMessages: 2, summarize: { model: cheap } },
    })

    await agent.run('now', { sessionId: 's' })

    expect(cheap.calls).toHaveLength(1)
    expect(main.calls).toHaveLength(1)
    expect(main.calls[0]?.messages[0]?.content).toContain('cheap recap')
  })

  it('does nothing without a session, since there is nowhere to keep it', async () => {
    const model = mockProvider([{ text: 'ok' }])
    const agent = new Agent({
      name: 'a',
      model,
      context: { maxMessages: 1, summarize: true },
    })

    await agent.run('now', {
      messages: [userMessage('old one'), userMessage('old two')],
    })

    // One call: the run's own. Summarizing every run without persisting the
    // result would be a recurring bill for nothing.
    expect(model.calls).toHaveLength(1)
  })

  it('shows the summarizer the tool calls, not just the prose', async () => {
    const store = memorySession()
    await store.append('s', [
      userMessage('what is the weather'),
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'get_weather',
            input: { city: 'Paris' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'get_weather', output: { tempC: 18 } },
        ],
      },
      userMessage('thanks'),
    ])

    const model = mockProvider([{ text: 'recap' }, { text: 'ok' }])
    const agent = new Agent({
      name: 'a',
      model,
      session: store,
      // A token budget passes no `limit`, so the whole transcript is read and
      // the tool turns are genuinely available to summarize.
      context: { maxTokens: 12, summarize: true },
    })

    await agent.run('now', { sessionId: 's' })

    const rendered = String(model.calls[0]?.messages[0]?.content)
    expect(rendered).toContain('get_weather')
    expect(rendered).toContain('Paris')
  })
})
