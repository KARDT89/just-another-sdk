import Link from 'next/link'
import {
  ArrowRightIcon,
  EyeIcon,
  InfinityIcon,
  PackageIcon,
  PlugZapIcon,
  ShieldCheckIcon,
  SplitIcon,
  WrenchIcon,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { InstallTabs } from '@/components/install-tabs'
import { Terminal, type TerminalLine } from '@/components/terminal'
import { Trace, type TraceLine } from '@/components/trace'
import { appName, links, packageName, version } from '@/lib/shared'

/**
 * The landing page.
 *
 * Proof-led on purpose. Every claim this SDK makes is *demonstrable* — the loop
 * terminates, the sandbox holds, the handoff shows up in a trace — so the page
 * shows real output rather than asserting adjectives. Each terminal block below
 * is copied from an actual run of an example in the repository, not mocked up.
 */

/** A bare install, then an agent that already has tools. Real output. */
const HERO_SESSION: TerminalLine[] = [
  { kind: 'command', text: `npm i ${packageName}` },
  { kind: 'dim', text: 'added 1 package in 0.4s', delay: 380 },
  { kind: 'blank', text: '' },
  { kind: 'command', text: 'node agent.ts', delay: 260 },
  { kind: 'output', text: '▶ run_m9x2k1p  assistant · anthropic/claude-opus-5', delay: 460 },
  { kind: 'tool', text: '  ↳ get_weather  {"location":"Paris"}', delay: 400 },
  { kind: 'result', text: '    → 18.2°C, clear sky                    1.5s', delay: 520 },
  { kind: 'tool', text: '  ↳ calculate    {"expression":"18.2*9/5+32"}', delay: 300 },
  { kind: 'result', text: '    → 64.76                                  0ms', delay: 280 },
  { kind: 'blank', text: '' },
  { kind: 'output', text: '"It\'s 18.2°C in Paris — about 65°F, and clear."', delay: 460 },
  { kind: 'blank', text: '' },
  { kind: 'success', text: '✔ finish · 2 turns · 412 in / 63 out · 2.1s', delay: 280 },
]

/** Real `pnpm example:handoffs` output. */
const HANDOFF_TRACE: readonly TraceLine[] = [
  { kind: 'output', text: '▶ run_msbpobom  triage · mock/triage' },
  { kind: 'tool', text: '  ↳ transfer_to_billing {"reason":"Duplicate March charge."}' },
  { kind: 'result', text: '    → {"transferred_to":"billing"}              0ms' },
  { kind: 'output', text: '  ⇄ handoff triage → billing · 4 messages carried' },
  { kind: 'tool', text: '  ↳ lookup_invoice {"month":"2026-03"}' },
  { kind: 'result', text: '    → {"charges":2,"total":"$98.00"}           84ms' },
  { kind: 'success', text: '✔ finish · 3 turns · 612 in / 88 out · triage → billing' },
]

/** Real `pnpm example:builtin-tools` output, from the two refusal acts. */
const REFUSAL_TRACE: readonly TraceLine[] = [
  { kind: 'tool', text: '  ↳ read_file  {"path":"../../../etc/passwd"}' },
  { kind: 'error', text: '    ✗ outside the directory this agent can access' },
  { kind: 'blank', text: '' },
  { kind: 'tool', text: '  ↳ http_fetch {"url":"http://169.254.169.254/…"}' },
  { kind: 'error', text: '    ✗ link-local address (cloud metadata)' },
  { kind: 'blank', text: '' },
  { kind: 'dim', text: "  allow: ['*'] — and it still refuses" },
  { kind: 'success', text: '✔ finish · the model read both and moved on' },
]

const INSTALL_STATS = [
  ['1', 'package installed'],
  ['17', 'tools in the box'],
  ['0', 'API keys to start'],
  ['579', 'tests, offline'],
] as const

const FEATURES = [
  {
    icon: PackageIcon,
    title: 'Zero dependencies',
    body: 'One package, and npm ls proves it. Providers are plain fetch calls — no vendor SDK to keep in sync, nothing transitive to audit, and it runs on Node, Bun, Deno, and the edge unchanged.',
  },
  {
    icon: InfinityIcon,
    title: 'A loop that cannot hang',
    body: 'Every exit path sets a stopReason. A model that calls tools forever costs you maxTurns requests, not your afternoon — and that budget is shared across a whole chain of agents.',
  },
  {
    icon: WrenchIcon,
    title: 'Seventeen tools in the box',
    body: 'Five are on every agent with no import. Weather, Wikipedia, geocoding, and currency need no API key. The calculator is a real parser, so there is no eval behind it.',
  },
  {
    icon: ShieldCheckIcon,
    title: 'Dangerous things refused by default',
    body: 'Filesystem tools cannot leave their root, not even through a symlink. HTTP refuses private and cloud-metadata addresses even when you allow every host. Secrets never reach a log.',
  },
  {
    icon: SplitIcon,
    title: 'Delegation that cannot loop',
    body: 'Hand a conversation to a specialist and it stays one run — one id, one usage total, one transcript. A cycle is refused rather than followed, and the route is in the result.',
  },
  {
    icon: EyeIcon,
    title: 'Observable by construction',
    body: 'Nineteen typed events feed tracing, metrics, and progress UIs from one stream. Every turn is recorded as it happens, so a trace is a formatter over data you already have.',
  },
] as const

const CODE_SAMPLE = `import { Agent } from '${packageName}'
import { openrouter } from '${packageName}/providers'
import { webTools } from '${packageName}/tools'

const support = new Agent({
  name: 'support',
  instructions: 'Help the customer. Use your tools.',
  model: openrouter('anthropic/claude-opus-5'),

  // calculate, current_time, date_math, unit_convert and
  // think are already here. These add real-world data.
  tools: [...webTools(), issueRefund],

  // A person approves anything that moves money.
  toolGuardrails: [
    {
      name: 'confirm-refunds',
      tools: ['issue_refund'],
      check: () => ({ requireApproval: true }),
    },
  ],

  // Escalate to a specialist when it needs one.
  handoffs: [billing, technical],
})

const result = await support.run(message, { sessionId: userId })

result.output      // the answer, typed
result.agentPath   // ['support', 'billing']
result.usage       // { inputTokens: 412, … }`

const CONCEPTS = [
  ['Agent', 'immutable config: model, tools, handoffs, policy'],
  ['tool()', 'schema in, typed handler out'],
  ['RunResult', 'output, steps, usage, agentPath'],
  ['ModelProvider', 'one method: generate()'],
] as const

const PROVIDERS = [
  'openrouter',
  'openai',
  'groq',
  'together',
  'deepseek',
  'xai',
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
                <span className="size-1.5 rounded-full bg-term-green" />v{version}
              </Badge>
              <Badge variant="outline" className="font-mono text-xs">
                MIT
              </Badge>
              <Badge variant="outline" className="font-mono text-xs">
                0 dependencies
              </Badge>
              <Badge variant="outline" className="font-mono text-xs">
                17 tools
              </Badge>
            </div>

            <h1 className="font-mono text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              An agent that works <span className="text-term-green">on install</span>.
            </h1>

            <p className="max-w-xl text-lg text-pretty text-muted-foreground">
              A TypeScript agent SDK with zero runtime dependencies. Define an agent, add tools, run
              a loop that cannot hang, get a typed result — on Node, Bun, Deno, or the edge.
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

      {/* ── What you get on install ───────────────────────────────────────── */}
      <section className="border-b bg-muted/20">
        <div className="mx-auto w-full max-w-5xl px-6 py-12">
          <dl className="grid grid-cols-2 gap-8 text-center sm:grid-cols-4">
            {INSTALL_STATS.map(([value, label]) => (
              <div key={label}>
                <dt className="font-mono text-3xl font-semibold text-term-green">{value}</dt>
                <dd className="mt-1 text-xs text-muted-foreground">{label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* ── The problem ───────────────────────────────────────────────────── */}
      <section className="border-b">
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
      <section className="border-b bg-muted/20">
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

      {/* ── Proof ─────────────────────────────────────────────────────────── */}
      <section className="border-b">
        <div className="mx-auto w-full max-w-6xl px-6 py-16">
          <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
            Not adjectives
          </p>
          <h2 className="mt-4 max-w-2xl font-mono text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            Every claim on this page is something you can run.
          </h2>
          <p className="mt-4 max-w-2xl text-muted-foreground">
            Both traces below are real output from examples in the repository, and both run offline
            with no API key at all.
          </p>

          <div className="mt-10 grid gap-6 lg:grid-cols-2">
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="font-mono text-sm font-semibold">Delegation, in one run</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  A router hands the conversation to a specialist. One run id, one usage total, one
                  transcript — and the route on the finish line. A transfer is a tool call, so it
                  inherits guardrails and approval for free.
                </p>
              </div>
              <Trace lines={HANDOFF_TRACE} label="pnpm example:handoffs" className="flex-1" />
            </div>

            <div className="flex flex-col gap-4">
              <div>
                <h3 className="font-mono text-sm font-semibold">Refused before it happens</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  A path that leaves the sandbox, and the cloud metadata endpoint that hands out
                  your credentials. Both refused, both while the allowlist says everything is fine —
                  and both as a tool result the model reads and works around.
                </p>
              </div>
              <Trace lines={REFUSAL_TRACE} label="pnpm example:builtin-tools" className="flex-1" />
            </div>
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
              separate; sessions are separate again. Tools are plain functions with a schema — any{' '}
              <a
                href="https://standardschema.dev"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-dotted underline-offset-4 hover:text-foreground"
              >
                Standard Schema
              </a>{' '}
              validator, so Zod is your choice and never our dependency.
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
              <span className="font-mono text-xs text-muted-foreground">support-agent.ts</span>
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
            and LM Studio. Writing your own means implementing one method. Add a{' '}
            <code className="font-mono text-foreground">fallbacks</code> chain and an outage on one
            vendor becomes a line in your trace instead of a failed request.
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
          <p className="max-w-xl text-muted-foreground">
            Ten runnable examples ship with the repository, and three of them need no API key.
          </p>
          <InstallTabs />
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href={links.docs}
              className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-5 font-mono text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Read the docs
              <ArrowRightIcon className="size-4" />
            </Link>
            <Link
              href={`${links.docs}/built-in-tools`}
              className="inline-flex h-10 items-center gap-2 rounded-md border px-5 font-mono text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Built-in tools
            </Link>
          </div>
        </div>
      </section>
    </main>
  )
}
