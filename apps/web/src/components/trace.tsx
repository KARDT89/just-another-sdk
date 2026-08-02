import { cn } from '@/lib/utils'

/**
 * A static block of real agent trace output.
 *
 * The animated {@link Terminal} earns its typewriter in the hero, where there is
 * one of them and it is the thing you are meant to watch. Everywhere else the
 * output is *evidence* — you want to read it, compare two of them, and scroll
 * past. So this renders instantly, is a server component, and costs no
 * JavaScript.
 *
 * The line kinds and their colours live here rather than in `terminal.tsx`
 * because that file is `'use client'`, and importing from it would drag the
 * whole typewriter into every page that only wanted to print eight lines.
 */

export type TraceLineKind =
  'command' | 'output' | 'dim' | 'success' | 'error' | 'tool' | 'result' | 'blank'

export interface TraceLine {
  kind: TraceLineKind
  text: string
  /** Extra pause before this line, ms. Ignored here; used by `Terminal`. */
  delay?: number
}

export const TRACE_KIND_STYLES: Record<TraceLineKind, string> = {
  command: 'text-foreground',
  output: 'text-foreground/85',
  dim: 'text-muted-foreground',
  success: 'text-term-green',
  error: 'text-term-red',
  tool: 'text-term-yellow',
  result: 'text-term-cyan',
  blank: '',
}

export function TraceRow({ line }: { line: TraceLine }) {
  if (line.kind === 'blank') return <div className="h-3" aria-hidden />

  return (
    <div className={cn('whitespace-pre', TRACE_KIND_STYLES[line.kind])}>
      {line.kind === 'command' && <span className="mr-2 select-none text-term-green">$</span>}
      {line.text}
    </div>
  )
}

/**
 * Evidence, framed.
 *
 * `overflow-x-auto` rather than wrapping: a trace line that wraps stops being a
 * trace line, and these are narrow enough that a phone scrolls a little rather
 * than reading a scrambled tree.
 */
export function Trace({
  lines,
  label,
  className,
}: {
  lines: readonly TraceLine[]
  /** Small caption above the block, e.g. the command that produced it. */
  label?: string
  className?: string
}) {
  return (
    <figure className={cn('overflow-hidden rounded-xl border bg-card', className)}>
      {label && (
        <figcaption className="border-b bg-muted/40 px-4 py-2.5 font-mono text-xs text-muted-foreground">
          {label}
        </figcaption>
      )}
      <div className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed sm:p-5">
        {lines.map((line, index) => (
          <TraceRow key={index} line={line} />
        ))}
      </div>
    </figure>
  )
}
