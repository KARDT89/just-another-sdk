import Link from 'next/link'
import {
  ArrowRightIcon,
  BracesIcon,
  EyeIcon,
  InfinityIcon,
  KeyRoundIcon,
  PackageIcon,
  PlugZapIcon,
  ShieldCheckIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { InstallTabs } from '@/components/install-tabs'
import { Terminal, type TerminalLine } from '@/components/terminal'
import { appName, links, packageName } from '@/lib/shared'

/**
 * The landing page.
 *
 * It leads with a real terminal session rather than a feature list, because the
 * product's whole claim — one package, a loop that terminates, a trace you can
 * read — is visible in about eight lines of actual output.
 */

/** Verbatim output of `pnpm example:tools`, replayed by the hero terminal. */
const HERO_SESSION: TerminalLine[] = [
  { kind: 'command', text: `npm i ${packageName}` },
  { kind: 'dim', text: 'added 1 package in 0.4s', delay: 420 },
  { kind: 'blank', text: '' },
  { kind: 'command', text: 'node agent.ts', delay: 300 },
  {
    kind: 'output',
    text: '▶ run_m9x2k1p  travel-assistant · anthropic/claude-opus-5',
    delay: 500,
  },
  { kind: 'tool', text: '  ↳ get_weather   {"city":"Paris"}', delay: 420 },
  { kind: 'tool', text: '  ↳ get_time      {"city":"Paris"}' },
  { kind: 'result', text: '    → {"tempC":18,"summary":"clear"}      118ms', delay: 460 },
  { kind: 'result', text: '    → {"localTime":"14:32","tz":"CET"}     61ms' },
  { kind: 'error', text: '    ✗ get_air_quality  upstream 503 — recovered', delay: 380 },
  { kind: 'blank', text: '' },
  { kind: 'output', text: '"It\'s 18°C and clear in Paris, 14:32 local.', delay: 520 },
  { kind: 'output', text: ' Air quality is unavailable right now."' },
  { kind: 'blank', text: '' },
  { kind: 'success', text: '✔ finish · 2 turns · 412 in / 63 out · 1.9s', delay: 300 },
]

const FEATURES = [
  {
    icon: PackageIcon,
    title: 'Zero dependencies',
    body: 'npm ls shows one package. Providers are plain fetch calls — no vendor SDK to keep in sync, nothing transitive to audit.',
  },
  {
    icon: InfinityIcon,
    title: 'A loop that cannot hang',
    body: 'Every exit path sets a stopReason. A model that calls tools forever costs you maxTurns requests, not your afternoon.',
  },
  {
    icon: ShieldCheckIcon,
    title: 'Failures stay recoverable',
    body: 'A tool that throws becomes a tool result the model reads and works around. Your run finishes with an answer, not a stack trace.',
  },
  {
    icon: BracesIcon,
    title: 'Your validator, not ours',
    body: 'Zod, Valibot, ArkType — anything implementing Standard Schema. Handler input is typed from the schema; the JSON Schema is derived for you.',
  },
  {
    icon: KeyRoundIcon,
    title: 'Secrets never reach your logs',
    body: 'An API key cannot appear in a thrown error, an emitted event, or a printed trace. There is a test suite asserting exactly that.',
  },
  {
    icon: EyeIcon,
    title: 'Observable by construction',
    body: 'Tracing, streaming, and progress UIs all consume one event stream, so you can see what your agent did without a debugger.',
  },
] as const

const CODE_SAMPLE = `import { Agent, tool } from '${packageName}'
import { openrouter } from '${packageName}/providers'
import * as z from 'zod'

const agent = new Agent({
  name: 'travel-assistant',
  instructions: 'Use your tools rather than guessing.',
  model: openrouter('anthropic/claude-opus-5'),
  tools: [
    tool({
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      inputSchema: z.object({ city: z.string() }),
      execute: async ({ city }) => fetchWeather(city),
      //                  ^^^^ string — inferred, and validated
    }),
  ],
})

const result = await agent.run('Weather in Paris?')

result.output      // "It's 18°C and clear in Paris."
result.usage       // { inputTokens: 412, outputTokens: 63, … }
result.stopReason  // 'finish'`

const CONCEPTS = [
  ['Agent', 'name, instructions, model, tools'],
  ['RunState', 'messages, turns, usage, steps'],
  ['tool()', 'schema in, typed handler out'],
  ['ModelProvider', 'one method: generate()'],
] as const

const PROVIDERS = [
  'openrouter',
  'openai',
  'groq',
  'together',
  'deepseek',
  'ollama',
  'vllm',
  'lm studio',
  'anthropic — next',
  'gemini — next',
] as const

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="relative border-b">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklch,var(--color-term-green)_9%,transparent),transparent)]"
        />
        <div className="mx-auto grid w-full max-w-6xl gap-12 px-6 py-16 lg:grid-cols-2 lg:items-center lg:gap-10 lg:py-24">
          <div className="flex flex-col items-start gap-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="gap-1.5 font-mono text-xs">
                <span className="size-1.5 rounded-full bg-term-green" />
                v0.1.0
              </Badge>
              <Badge variant="outline" className="font-mono text-xs">
                MIT
              </Badge>
              <Badge variant="outline" className="font-mono text-xs">
                0 dependencies
              </Badge>
            </div>

            <h1 className="font-mono text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              The agent loop that <span className="text-term-green">cannot hang</span>.
            </h1>

            <p className="max-w-xl text-lg text-pretty text-muted-foreground">
              A TypeScript agent SDK with zero runtime dependencies. Define an agent, add tools, run
              the loop, get a typed result — on Node, Bun, Deno, or the edge.
            </p>

            <InstallTabs />

            <div className="flex flex-wrap items-center gap-3">
              <Link
                href={links.quickstart}
                className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-5 font-mono text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                Quick start
                <ArrowRightIcon className="size-4" />
              </Link>
              <Link
                href={links.github}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-2 rounded-md border px-5 font-mono text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                GitHub
              </Link>
            </div>
          </div>

          <Terminal lines={HERO_SESSION} title={`${appName} — demo`} />
        </div>
      </section>

      {/* ── The problem ───────────────────────────────────────────────────── */}
      <section className="border-b bg-muted/20">
        <div className="mx-auto w-full max-w-4xl px-6 py-16">
          <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            Why another one
          </p>
          <h2 className="mt-4 font-mono text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            Because the boring parts are the ones that bite you in production.
          </h2>
          <div className="mt-6 space-y-4 text-muted-foreground">
            <p>
              Agent frameworks demo well. Then you ship one, and the interesting problems turn out
              to be the unglamorous ones: a model that loops until your bill spikes, a tool
              exception that takes down a request, an API key that ends up in a CI log, a dependency
              tree you cannot audit, and no way to see what your agent actually did.
            </p>
            <p className="text-foreground">
              {appName} treats those as the product, not the appendix. Every one of them is a
              default, a type, or a test — not something you remember to add.
            </p>
          </div>
        </div>
      </section>

      {/* ── Features ──────────────────────────────────────────────────────── */}
      <section className="border-b">
        <div className="mx-auto w-full max-w-6xl px-6 py-16">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <Card key={title} className="border-border/70 bg-card/50">
                <CardContent className="flex flex-col gap-3">
                  <Icon className="size-5 text-term-green" strokeWidth={1.75} />
                  <h3 className="font-mono text-sm font-semibold">{title}</h3>
                  <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* ── Code ──────────────────────────────────────────────────────────── */}
      <section className="border-b bg-muted/20">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-16 lg:grid-cols-[1fr_1.15fr] lg:items-center">
          <div className="flex flex-col gap-5">
            <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
              The whole API
            </p>
            <h2 className="font-mono text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
              Four concepts. No ceremony.
            </h2>
            <p className="text-muted-foreground">
              An <code className="font-mono text-foreground">Agent</code> is immutable
              configuration, so one instance safely serves every concurrent request. Run state is
              separate. Tools are plain functions with a schema. That is the entire mental model.
            </p>
            <Separator />
            <dl className="grid gap-4 font-mono text-sm sm:grid-cols-2">
              {CONCEPTS.map(([term, definition]) => (
                <div key={term}>
                  <dt className="text-term-cyan">{term}</dt>
                  <dd className="mt-1 text-xs text-muted-foreground">{definition}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="overflow-hidden rounded-xl border bg-card shadow-xl">
            <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
              <span className="font-mono text-xs text-muted-foreground">agent.ts</span>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-relaxed">
              <code>{CODE_SAMPLE}</code>
            </pre>
          </div>
        </div>
      </section>

      {/* ── Providers ─────────────────────────────────────────────────────── */}
      <section className="border-b">
        <div className="mx-auto w-full max-w-4xl px-6 py-16 text-center">
          <PlugZapIcon className="mx-auto size-5 text-term-green" strokeWidth={1.75} />
          <h2 className="mt-4 font-mono text-2xl font-semibold tracking-tight text-balance">
            One key. Every model.
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
            OpenRouter reaches hundreds of models through a single provider, and the same
            OpenAI-compatible transport covers OpenAI, Groq, Together, DeepSeek, xAI, Ollama, vLLM,
            and LM Studio. Writing your own means implementing one method.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-2 font-mono text-xs">
            {PROVIDERS.map((name) => (
              <Badge key={name} variant="secondary" className="font-mono">
                {name}
              </Badge>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ───────────────────────────────────────────────────────────── */}
      <section>
        <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-6 px-6 py-20 text-center">
          <h2 className="font-mono text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            Running in about two minutes.
          </h2>
          <InstallTabs />
          <Link
            href={links.docs}
            className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-5 font-mono text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            Read the docs
            <ArrowRightIcon className="size-4" />
          </Link>
        </div>
      </section>
    </main>
  )
}
