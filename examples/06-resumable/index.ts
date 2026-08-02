/**
 * Example 6 — A run that outlives its client.
 *
 * The failure this fixes: a browser loses its connection mid-generation. With an
 * ordinary streamed run wired to `request.signal`, the run is cancelled, and
 * because only a completed run is persisted, the user loses the exchange they
 * had already watched arrive. A resumable run does not care that the reader
 * left.
 *
 *   echo "OPENROUTER_API_KEY=sk-or-..." > examples/.env
 *   pnpm example:resumable
 *
 * The script plays out the whole story on its own — start, disconnect, reconnect
 * — and prints what each side saw. No second terminal required.
 */

import { Agent, isAgentError, readEventStream } from 'just-another-sdk'
import { openrouter } from 'just-another-sdk/providers'

/** Stands in for a client going away. */
class Disconnected extends Error {}

const MODEL = process.env['OPENROUTER_MODEL'] ?? 'openai/gpt-4o-mini'

const agent = new Agent({
  name: 'resumable-demo',
  instructions: 'You are a patient teacher. Answer in about eight sentences.',
  model: openrouter(MODEL),
})

try {
  console.log('\n① start — the run begins, and we hold the stream id\n')

  const run = agent.resumable('Explain how async iterators work, and why they exist.')
  console.log(`   stream id: ${run.streamId}`)
  console.log(`   run id:    ${run.runId}\n`)

  // ── The first client reads a little, then "disconnects" ───────────────────
  console.log('② first client — reads a few tokens, then drops the connection\n')

  const cursor = { index: -1 }
  let printed = 0

  try {
    for await (const event of readEventStream(run.toEventResponse(), { cursor })) {
      if (event.type !== 'text.delta') continue
      process.stdout.write(event.delta)
      printed += event.delta.length
      if (printed > 120) throw new Disconnected()
    }
  } catch (error) {
    if (!(error instanceof Disconnected)) throw error
    console.log('\n\n   ✂ connection lost\n')
  }

  console.log(`③ reconnect — resuming from event ${cursor.index + 1}\n`)

  // A different request, and in a real deployment possibly a different process.
  // The run kept going regardless; the recording is what is being read.
  for await (const event of readEventStream(
    agent.resume(run.streamId, { fromIndex: cursor.index + 1 }).toEventResponse(),
  )) {
    if (event.type === 'text.delta') process.stdout.write(event.delta)
  }

  const result = await run.completed

  console.log('\n\n④ done — and the run never noticed it was abandoned\n')
  console.log(
    `   ${result.usage.inputTokens} in / ${result.usage.outputTokens} out · ` +
      `${result.durationMs}ms · stopped: ${result.stopReason}`,
  )
  console.log('\n   Note the text is continuous across the reconnect: no repeated')
  console.log('   sentence, no missing one. The `id:` on every SSE event is what')
  console.log('   made that possible — a browser sends it back as Last-Event-ID')
  console.log('   automatically.\n')
} catch (error) {
  if (isAgentError(error)) {
    console.error(`\n✗ ${error.code}\n${error.message}\n`)
    process.exit(1)
  }
  throw error
}
