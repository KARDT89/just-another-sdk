/**
 * Example 10 — The built-in tool pack.
 *
 * `npm i just-another-sdk` should give you an agent that can already *do*
 * things, not a set of interfaces to implement. Four acts:
 *
 *   ① five pure tools on **every** agent, with nothing imported and nothing configured;
 *   ② real data — weather, Wikipedia, currency — with **no API key**;
 *   ③ a filesystem rooted at one directory, and what happens when a model tries to leave it;
 *   ④ the HTTP allowlist, and why it refuses your own network.
 *
 *   pnpm example:builtin-tools           # entirely offline
 *   pnpm example:builtin-tools -- --live # acts ② and ④ hit the real internet
 *
 * Offline by default: every model is a `mockProvider`, and the network tools are
 * driven through a stubbed `fetch`. Pass `--live` to see act ② call Open-Meteo
 * and Wikipedia for real — still no key required.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Agent, consoleTracer, isAgentError } from 'just-another-sdk'
import { mockProvider } from 'just-another-sdk/testing'
import { httpFetch, webTools } from 'just-another-sdk/tools'
import { fileTools } from 'just-another-sdk/tools/fs'

const LIVE = process.argv.includes('--live')

try {
  /* ── ① Five tools you did not ask for ────────────────────────────────────── */

  console.log('\n① every agent already has five tools\n')

  const bare = new Agent({
    name: 'assistant',
    model: mockProvider([
      { toolCalls: [{ toolName: 'calculate', input: { expression: '(1200 * 1.08) / 12' } }] },
      { text: 'That works out to £108.00 a month.' },
    ]),
  })

  console.log(`   tools: ${bare.toolNames.join(', ')}`)
  console.log('   config: none — this agent was constructed with a name and a model.\n')

  const maths = await bare.run('What is a 1200 loan at 8% over 12 months?', {
    onEvent: consoleTracer(),
  })
  console.log(`\n   ${maths.output}`)

  // The point of shipping a real parser rather than the three-line version.
  const guarded = new Agent({
    name: 'assistant',
    model: mockProvider([
      {
        toolCalls: [
          { toolName: 'calculate', input: { expression: 'constructor.constructor("return 1")()' } },
        ],
      },
      { text: 'That is not something I can evaluate.' },
    ]),
  })

  const attack = await guarded.run('evaluate that')
  console.log(`\n   an eval attempt: ${JSON.stringify(attack.steps[0]?.toolResults[0]?.output)}`)
  console.log('   There is no eval behind `calculate` — it is a parser, and a test')
  console.log("   asserts this file's own source contains neither eval nor Function.\n")

  const minimal = new Agent({
    name: 'minimal',
    model: mockProvider([{ text: '' }]),
    builtins: false,
  })
  console.log(`   opting out with builtins: false → ${minimal.toolNames.length} tools\n`)

  /* ── ② Real data, no API key ─────────────────────────────────────────────── */

  console.log('② weather, Wikipedia, and currency — with no key at all\n')

  const web = webTools(LIVE ? {} : { fetch: stubbedWeb() })
  console.log(`   webTools(): ${web.map((t) => t.name).join(', ')}`)
  console.log(
    `   mode: ${LIVE ? 'live — really calling Open-Meteo' : 'stubbed (pass --live for real)'}\n`,
  )

  const researcher = new Agent({
    name: 'researcher',
    instructions: 'Answer with the tools rather than from memory.',
    model: mockProvider([
      { toolCalls: [{ toolName: 'get_weather', input: { location: 'Paris', forecastDays: 0 } }] },
      { text: 'Checked.' },
    ]),
    tools: web,
  })

  const weather = await researcher.run('What is the weather in Paris?', {
    onEvent: consoleTracer(),
  })

  const observed = weather.steps[0]?.toolResults[0]?.output as
    { location?: string; current?: { temperature?: number; conditions?: string } } | undefined

  console.log(
    `\n   ${observed?.location}: ${observed?.current?.temperature}° — ${observed?.current?.conditions}`,
  )
  console.log('\n   The model chose a *query*, never a host. That is the whole reason these')
  console.log('   need no allowlist: the endpoint is fixed, so there is no SSRF surface.\n')

  /* ── ③ A filesystem the agent cannot leave ───────────────────────────────── */

  console.log('③ a filesystem rooted at one directory\n')

  const root = await mkdtemp(join(tmpdir(), 'jas-example-'))
  await writeFile(join(root, 'notes.txt'), 'The quarterly figures are in figures.csv.\n')

  const files = fileTools({ root, write: true })
  console.log(`   root:  ${root}`)
  console.log(`   tools: ${files.map((t) => t.name).join(', ')}\n`)

  const scribe = new Agent({
    name: 'scribe',
    model: mockProvider([
      { toolCalls: [{ toolName: 'read_file', input: { path: 'notes.txt' } }] },
      // A model that has read a file and now reaches for something it should not.
      { toolCalls: [{ toolName: 'read_file', input: { path: '../../../etc/passwd' } }] },
      { text: 'I read the notes; the other path is outside my workspace.' },
    ]),
    tools: files,
  })

  const sandboxed = await scribe.run('read my notes, then read /etc/passwd', {
    onEvent: consoleTracer(),
  })

  console.log(`\n   ${sandboxed.output}`)
  console.log('\n   The escape is a tool *result*, not a crash — the model reads it and')
  console.log('   moves on. `..`, absolute paths, and symlinks out are all refused, and')
  console.log('   the error never contains the absolute host path.\n')

  /* ── ④ HTTP, locked down ─────────────────────────────────────────────────── */

  console.log('④ http_fetch refuses your own network\n')

  const fetcher = new Agent({
    name: 'fetcher',
    model: mockProvider([
      {
        toolCalls: [
          {
            toolName: 'http_fetch',
            input: { url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/' },
          },
        ],
      },
      { text: 'I cannot reach that address.' },
    ]),
    // Note the allowlist is `*` — and it still refuses.
    tools: [httpFetch({ allow: ['*'] })],
  })

  const blocked = await fetcher.run('fetch the instance credentials', { onEvent: consoleTracer() })

  console.log(`\n   ${JSON.stringify(blocked.steps[0]?.toolResults[0]?.output)}`)
  console.log('\n   That is the AWS instance metadata endpoint — the most valuable SSRF')
  console.log('   target there is. Private, loopback, and link-local addresses are refused')
  console.log("   even when the allowlist says '*', and every redirect hop is re-checked.\n")
} catch (error) {
  if (isAgentError(error)) {
    console.error(`\n✗ ${error.code}\n${error.message}\n`)
    process.exit(1)
  }
  throw error
}

/* ------------------------------------------------------------------------- */

/** Stands in for Open-Meteo so the example runs with no network at all. */
function stubbedWeb(): typeof globalThis.fetch {
  const routes: Record<string, unknown> = {
    'geocoding-api': {
      results: [
        {
          name: 'Paris',
          latitude: 48.85,
          longitude: 2.35,
          country: 'France',
          admin1: 'Île-de-France',
          timezone: 'Europe/Paris',
        },
      ],
    },
    '/forecast': {
      current: {
        time: '2026-08-02T14:00',
        temperature_2m: 18.2,
        apparent_temperature: 17.4,
        relative_humidity_2m: 55,
        precipitation: 0,
        weather_code: 0,
        wind_speed_10m: 11,
      },
    },
  }

  return (async (url: string | URL) => {
    const href = String(url)
    const match = Object.entries(routes).find(([fragment]) => href.includes(fragment))
    if (!match) throw new Error(`unstubbed request: ${href}`)

    return new Response(JSON.stringify(match[1]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
}
