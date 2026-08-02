'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { TraceRow, type TraceLine, type TraceLineKind } from './trace'

/**
 * A terminal window that types out a scripted session.
 *
 * The script it replays is the *real* output of `pnpm example:tools` — the
 * console tracer that ships in the SDK produces exactly these lines. Showing
 * genuine output rather than a mock-up is the point: the hero is a demo, not an
 * illustration.
 */

/**
 * The line vocabulary is shared with the static {@link Trace} block, and defined
 * there — this file is `'use client'`, so owning the types would pull the
 * typewriter into every server component that just wants to print a trace.
 */
export type TerminalLineKind = TraceLineKind
export type TerminalLine = TraceLine

export function Terminal({
  lines,
  title = 'agent — zsh',
  className,
  typeSpeed = 14,
}: {
  lines: TerminalLine[]
  title?: string
  className?: string
  typeSpeed?: number
}) {
  const { visible, done } = useTypewriter(lines, typeSpeed)

  return (
    <div
      className={cn(
        'jas-scanlines relative overflow-hidden rounded-xl border bg-card shadow-2xl',
        'ring-1 ring-white/5',
        className,
      )}
    >
      {/* Title bar */}
      <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
        <span className="size-3 rounded-full bg-term-red/80" />
        <span className="size-3 rounded-full bg-term-yellow/80" />
        <span className="size-3 rounded-full bg-term-green/80" />
        <span className="ml-2 truncate font-mono text-xs text-muted-foreground">{title}</span>
      </div>

      {/* Body. `min-h` is fixed so the page does not reflow as lines appear. */}
      <div className="min-h-[19rem] overflow-x-auto p-4 font-mono text-[13px] leading-relaxed sm:min-h-[21rem] sm:p-5 sm:text-sm">
        {visible.map((line, index) => (
          <TraceRow key={index} line={line} />
        ))}
        {!done && (
          <span className="jas-cursor inline-block h-4 w-2 translate-y-0.5 bg-term-green" />
        )}
      </div>
    </div>
  )
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * Reads `prefers-reduced-motion` as an external store rather than in an effect.
 *
 * `useSyncExternalStore` is the right tool here: it gives a correct value on the
 * very first client render (no flash of animation), stays correct if the user
 * changes the preference mid-visit, and needs no `setState` inside an effect.
 */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false, // server render: assume motion is fine, then correct on hydration
  )
}

/**
 * Reveals lines one character at a time.
 *
 * Respects `prefers-reduced-motion` by rendering everything immediately — an
 * animation nobody asked for should never be the reason someone cannot read the
 * page.
 */
function useTypewriter(lines: TerminalLine[], speed: number) {
  const [lineIndex, setLineIndex] = useState(0)
  const [charIndex, setCharIndex] = useState(0)
  const instant = usePrefersReducedMotion()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (instant || lineIndex >= lines.length) return

    const current = lines[lineIndex]
    if (!current) return

    // Blank lines and fully-typed lines advance to the next line.
    if (current.kind === 'blank' || charIndex >= current.text.length) {
      timer.current = setTimeout(
        () => {
          setLineIndex((index) => index + 1)
          setCharIndex(0)
        },
        current.kind === 'blank' ? 90 : (lines[lineIndex + 1]?.delay ?? 130),
      )
      return () => clearTimeout(timer.current)
    }

    // Commands type character by character; output arrives in one go, which is
    // how a real terminal behaves.
    if (current.kind === 'command') {
      timer.current = setTimeout(() => setCharIndex((index) => index + 1), speed)
    } else {
      timer.current = setTimeout(() => setCharIndex(current.text.length), 40)
    }

    return () => clearTimeout(timer.current)
  }, [lineIndex, charIndex, lines, speed, instant])

  if (instant) return { visible: lines, done: true }

  const visible = lines
    .slice(0, lineIndex)
    .concat(
      lineIndex < lines.length && lines[lineIndex]
        ? [{ ...lines[lineIndex], text: lines[lineIndex].text.slice(0, charIndex) } as TerminalLine]
        : [],
    )

  return { visible, done: lineIndex >= lines.length }
}
