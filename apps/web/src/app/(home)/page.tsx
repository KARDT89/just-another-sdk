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
import {
  AmbientGlow,
  Lift,
  MotionRoot,
  Press,
  Reveal,
  Stagger,
  StaggerItem,
} from '@/components/motion'
import { ProofTabs, type ProofPanel } from '@/components/proof-tabs'
import { Terminal, type TerminalLine } from '@/components/terminal'
import { appName, links, packageName, version } from '@/lib/shared'

/**
 * The landing page.
 *
 * Proof-led on purpose. Every claim this SDK makes is *demonstrable* — the loop
 * terminates, the sandbox holds, the handoff shows up in a trace, an outage
 * fails over — so the page shows real output rather than asserting adjectives.
 * Each terminal block below is copied from an actual run in this repository,
 * not mocked up.
 *
 * It deliberately does not count things. Tool counts, test counts, and package
 * counts age badly, invite the wrong comparison, and say nothing a trace does
 * not say better.
 */

/** A bare install, then an agent that already has tools. Real output. */
const HERO_SESSION: TerminalLine[] = [
  { kind: 'command', text: `npm i ${packageName}` },
  { kind: 'blank', text: '' },
  { kind: 'command', text: 'node agent.ts', delay: 260 },
  { kind: 'output', text: '▶ run_m9x2k1p  assistant · claude-opus-5', delay: 460 },
  { kind: 'tool', text: '  ↳ get_weather  {"location":"Paris"}', delay: 400 },
  { kind: 'result', text: '    → 18.2°C, clear sky                    1.5s', delay: 520 },
  { kind: 'tool', text: '  ↳ calculate    {"expression":"18.2*9/5+32"}', delay: 300 },
  { kind: 'result', text: '    → 64.76                                  0ms', delay: 280 },
  { kind: 'blank', text: '' },
  { kind: 'output', text: '"It\'s 18.2°C in Paris — about 65°F, and clear."', delay: 460 },
  { kind: 'blank', text: '' },
  { kind: 'success', text: '✔ finish · 2 turns · 412 in / 63 out · 2.1s', delay: 280 },
]

const PROOF: readonly ProofPanel[] = [
  {
    id: 'fallback',
    tab: 'Outage',
    heading: 'A vendor goes down. The run does not.',
    body:
      'Anthropic returns 529. The retry policy backs off, gives up, and the same run continues on ' +
      'the next provider — one run id, one usage total, one transcript. Failing over is a line in ' +
      'your trace instead of a page in your incident channel.',
    command: 'anthropic 529 → fallbacks: [google(…)]',
    lines: [
      { kind: 'output', text: '▶ run_msbtg147_qsa69f  assistant · claude-opus-5' },
      { kind: 'dim', text: '  ⟳ retry 1/2 · provider_error · waiting 181ms' },
      { kind: 'output', text: '  ⇄ fallback → gemini-2.5-pro · after provider_error' },
      { kind: 'tool', text: '  ↳ get_weather {"city":"Paris"}' },
      { kind: 'result', text: '    → {"city":"Paris","tempC":18,"summary":"clear"} 1ms' },
      { kind: 'success', text: '✔ finish · 2 turns · 20 in / 10 out · 296ms' },
    ],
  },
  {
    id: 'handoff',
    tab: 'Delegation',
    heading: 'Delegation, in one run',
    body:
      'A router hands the conversation to a specialist and it stays one run — one id, one usage ' +
      'total, one transcript, and the route on the finish line. A transfer is a tool call, so it ' +
      'inherits guardrails and approval for free, and a cycle is refused rather than followed.',
    command: 'pnpm example:handoffs',
    lines: [
      { kind: 'output', text: '▶ run_msbpobom  triage · mock/triage' },
      { kind: 'tool', text: '  ↳ transfer_to_billing {"reason":"Duplicate March charge."}' },
      { kind: 'result', text: '    → {"transferred_to":"billing"}              0ms' },
      { kind: 'output', text: '  ⇄ handoff triage → billing · 4 messages carried' },
      { kind: 'tool', text: '  ↳ lookup_invoice {"month":"2026-03"}' },
      { kind: 'result', text: '    → {"charges":2,"total":"$98.00"}           84ms' },
      { kind: 'success', text: '✔ finish · 3 turns · 612 in / 88 out · triage → billing' },
    ],
  },
  {
    id: 'refusal',
    tab: 'Blast radius',
    heading: 'Refused before it happens',
    body:
      'A path that leaves the sandbox, and the cloud metadata endpoint that hands out your ' +
      'credentials. Both refused while the allowlist says everything is fine — and both returned ' +
      'as a tool result the model reads and works around, rather than an exception that ends the run.',
    command: 'pnpm example:builtin-tools',
    lines: [
      { kind: 'tool', text: '  ↳ read_file  {"path":"../../../etc/passwd"}' },
      { kind: 'error', text: '    ✗ outside the directory this agent can access' },
      { kind: 'blank', text: '' },
      { kind: 'tool', text: '  ↳ http_fetch {"url":"http://169.254.169.254/…"}' },
      { kind: 'error', text: '    ✗ link-local address (cloud metadata)' },
      { kind: 'blank', text: '' },
      { kind: 'dim', text: "  allow: ['*'] — and it still refuses" },
      { kind: 'success', text: '✔ finish · the model read both and moved on' },
    ],
  },
]

const FEATURES = [
  {
    icon: PackageIcon,
    title: 'Zero dependencies',
    body: 'One package, and npm ls proves it. Every provider is a plain fetch call — no vendor SDK to keep in sync, nothing transitive to audit, and it runs on Node, Bun, Deno, and the edge unchanged.',
  },
  {
    icon: InfinityIcon,
    title: 'A loop that cannot hang',
    body: 'Every exit path sets a stopReason. A model that calls tools forever costs you maxTurns requests, not your afternoon — and that budget is shared across a whole chain of agents.',
  },
  {
    icon: WrenchIcon,
    title: 'Batteries, not a shopping list',
    body: 'Maths, time, and reasoning tools are on every agent with no import. Weather, Wikipedia, geocoding, and currency need no API key. The calculator is a real parser, so there is no eval behind it.',
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
    body: 'One typed event stream feeds tracing, metrics, and progress UIs. Every turn is recorded as it happens, so a trace is a formatter over data you already have rather than a parallel logging path.',
  },
] as const

const CODE_SAMPLE = `import { Agent } from '${packageName}'
import { anthropic, google } from '${packageName}/providers'
import { webTools } from '${packageName}/tools'

const support = new Agent({
  name: 'support',
  instructions: 'Help the customer. Use your tools.',

  // Native Claude. If Anthropic is having a day,
  // the same run continues on Gemini.
  model: anthropic('claude-opus-5'),
  fallbacks: [google('gemini-2.5-pro')],

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

/** Native transports first — the rest ride the OpenAI-compatible one. */
const NATIVE_PROVIDERS = ['anthropic', 'openai', 'gemini', 'openrouter'] as const

const COMPATIBLE_PROVIDERS = [
  'groq',
  'together',
  'fireworks',
  'deepseek',
  'xai',
  'ollama',
  'vllm',
  'lm studio',
] as const

export default function HomePage() {
  return (
    <MotionRoot>
      <main className="flex flex-1 flex-col">
        {/* ── Hero ────────────────────────────────────────────────────────── */}
        <section className="relative overflow-hidden border-b">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklch,var(--color-term-green)_9%,transparent),transparent)]"
          />
          <AmbientGlow />

          <div className="relative mx-auto grid w-full max-w-6xl gap-12 px-6 py-16 lg:grid-cols-2 lg:items-center lg:gap-10 lg:py-24">
            <Reveal className="flex flex-col items-start gap-6">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="gap-1.5 font-mono text-xs">
                  <span className="size-1.5 rounded-full bg-term-green" />v{version}
                </Badge>
                <Badge variant="outline" className="font-mono text-xs">
                  MIT
                </Badge>
              </div>

              <h1 className="font-mono text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                Ship the agent. <span className="text-term-green">Keep the pager quiet.</span>
              </h1>

              <p className="max-w-xl text-lg text-pretty text-muted-foreground">
                A TypeScript agent SDK for teams putting an agent in front of real users. Define an
                agent, add tools, run a loop that cannot hang, get a typed result — with the
                production problems already solved, and nothing in your dependency tree.
              </p>

              <InstallTabs />

              <div className="flex flex-wrap items-center gap-3">
                <Press>
                  <Link
                    href={links.quickstart}
                    className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-5 font-mono text-sm font-medium text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    Quick start
                    <ArrowRightIcon className="size-4" />
                  </Link>
                </Press>
                <Press>
                  <Link
                    href={links.github}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-10 items-center gap-2 rounded-md border px-5 font-mono text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    GitHub
                  </Link>
                </Press>
                <Press>
                  <Link
                    href={links.npm}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-10 items-center gap-2 rounded-md border px-5 font-mono text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    npm
                  </Link>
                </Press>
              </div>
            </Reveal>

            <Terminal lines={HERO_SESSION} title={`${appName} — demo`} />
          </div>
        </section>

        {/* ── The problem ─────────────────────────────────────────────────── */}
        <section className="border-b bg-muted/20">
          <div className="mx-auto w-full max-w-4xl px-6 py-16">
            <Reveal>
              <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
                Why another one
              </p>
              <h2 className="mt-4 font-mono text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                The demo is the easy half. The bill, the breach, and the outage are the other one.
              </h2>
              <div className="mt-6 space-y-4 text-muted-foreground">
                <p>
                  Every agent framework demos beautifully. Then you put one in front of real users,
                  and the interesting problems turn out to be the unglamorous ones: a model that
                  loops until your bill spikes, a tool exception that takes down a request, an API
                  key that ends up in a CI log, a filesystem tool that reads one directory too far,
                  a vendor outage with no second path, and no way to see what your agent actually
                  did.
                </p>
                <p className="text-foreground">
                  {appName} treats those as the product, not the appendix. Every one of them is a
                  default, a type, or a test — not something you remember to add on the Friday
                  before launch.
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── Proof ───────────────────────────────────────────────────────── */}
        <section className="border-b">
          <div className="mx-auto w-full max-w-6xl px-6 py-16">
            <Reveal>
              <p className="font-mono text-xs tracking-widest text-muted-foreground uppercase">
                Not adjectives
              </p>
              <h2 className="mt-4 max-w-2xl font-mono text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                Every claim on this page is something you can run.
              </h2>
              <p className="mt-4 max-w-2xl text-muted-foreground">
                Real output, copied from actual runs in the repository. All three run offline, with
                no API key at all.
              </p>
            </Reveal>

            <ProofTabs panels={PROOF} />
          </div>
        </section>

        {/* ── Features ────────────────────────────────────────────────────── */}
        <section className="border-b bg-muted/20">
          <div className="mx-auto w-full max-w-6xl px-6 py-16">
            <Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <StaggerItem key={title}>
                  <Lift>
                    <Card className="h-full border-border/70 bg-card/50 transition-colors hover:border-term-green/40">
                      <CardContent className="flex flex-col gap-3">
                        <Icon className="size-5 text-term-green" strokeWidth={1.75} />
                        <h3 className="font-mono text-sm font-semibold">{title}</h3>
                        <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
                      </CardContent>
                    </Card>
                  </Lift>
                </StaggerItem>
              ))}
            </Stagger>
          </div>
        </section>

        {/* ── Code ────────────────────────────────────────────────────────── */}
        <section className="border-b">
          <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-16 lg:grid-cols-[1fr_1.15fr] lg:items-center">
            <Reveal className="flex flex-col gap-5">
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
            </Reveal>

            <Reveal delay={0.1}>
              <div className="overflow-hidden rounded-xl border bg-card shadow-xl">
                <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
                  <span className="font-mono text-xs text-muted-foreground">support-agent.ts</span>
                </div>
                <pre className="overflow-x-auto p-5 font-mono text-[12.5px] leading-relaxed">
                  <code>{CODE_SAMPLE}</code>
                </pre>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ── Providers ───────────────────────────────────────────────────── */}
        <section className="border-b bg-muted/20">
          <div className="mx-auto w-full max-w-4xl px-6 py-16 text-center">
            <Reveal>
              <PlugZapIcon className="mx-auto size-5 text-term-green" strokeWidth={1.75} />
              <h2 className="mt-4 font-mono text-2xl font-semibold tracking-tight text-balance">
                Three vendors, natively. The rest for free.
              </h2>
              <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
                Claude speaks the Messages API, Gemini speaks{' '}
                <code className="font-mono text-foreground">generateContent</code>, and OpenAI
                speaks Chat Completions — each a direct{' '}
                <code className="font-mono text-foreground">fetch</code> call, not a vendor SDK.
                OpenRouter reaches hundreds more through one key, and the same compatible transport
                covers anything that speaks the OpenAI shape. Writing your own means implementing
                one method.
              </p>
            </Reveal>

            <Stagger className="mt-8 flex flex-wrap items-center justify-center gap-2 font-mono text-xs">
              {NATIVE_PROVIDERS.map((name) => (
                <StaggerItem key={name}>
                  <Badge className="border-term-green/40 bg-term-green/10 font-mono text-term-green">
                    {name}
                  </Badge>
                </StaggerItem>
              ))}
              {COMPATIBLE_PROVIDERS.map((name) => (
                <StaggerItem key={name}>
                  <Badge variant="secondary" className="font-mono">
                    {name}
                  </Badge>
                </StaggerItem>
              ))}
            </Stagger>

            <Reveal delay={0.1}>
              <p className="mt-6 font-mono text-xs text-muted-foreground">
                <span className="text-term-green">■</span> native transport &nbsp;·&nbsp;
                <span className="text-muted-foreground">■</span> OpenAI-compatible
              </p>
            </Reveal>
          </div>
        </section>

        {/* ── CTA ─────────────────────────────────────────────────────────── */}
        <section>
          <div className="mx-auto flex w-full max-w-4xl flex-col items-center gap-6 px-6 py-20 text-center">
            <Reveal className="flex flex-col items-center gap-6">
              <h2 className="font-mono text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                Running in about two minutes.
              </h2>
              <p className="max-w-xl text-muted-foreground">
                Runnable examples ship with the repository, and several of them need no API key.
              </p>
              <InstallTabs />
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Press>
                  <Link
                    href={links.docs}
                    className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-5 font-mono text-sm font-medium text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    Read the docs
                    <ArrowRightIcon className="size-4" />
                  </Link>
                </Press>
                <Press>
                  <Link
                    href={`${links.docs}/providers`}
                    className="inline-flex h-10 items-center gap-2 rounded-md border px-5 font-mono text-sm font-medium transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    Providers
                  </Link>
                </Press>
              </div>
            </Reveal>
          </div>
        </section>
      </main>
    </MotionRoot>
  )
}
