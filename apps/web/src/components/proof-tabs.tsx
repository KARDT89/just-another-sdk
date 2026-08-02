'use client'

import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'

import { Trace, type TraceLine } from './trace'

/**
 * Three pieces of evidence, one screen.
 *
 * The proof section is the strongest thing on the page, and three stacked
 * terminal blocks would push two of them below the fold where nobody reads
 * them. A tab switcher keeps all three one click apart, and the sliding
 * underline (`layoutId`) makes the switch legible rather than a jump cut.
 *
 * Each panel is still a `<Trace>` — the same static, real output the rest of the
 * site prints. This component only chooses which one is visible.
 */

export interface ProofPanel {
  readonly id: string
  readonly tab: string
  readonly heading: string
  readonly body: string
  readonly command: string
  readonly lines: readonly TraceLine[]
}

export function ProofTabs({ panels }: { panels: readonly ProofPanel[] }) {
  const [activeId, setActiveId] = useState(panels[0]?.id ?? '')
  const active = panels.find((panel) => panel.id === activeId) ?? panels[0]

  if (!active) return null

  return (
    <div className="mt-10">
      <div role="tablist" aria-label="Runnable proof" className="flex flex-wrap gap-1 border-b">
        {panels.map((panel) => {
          const selected = panel.id === active.id
          return (
            <button
              key={panel.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveId(panel.id)}
              className={`relative px-4 py-2.5 font-mono text-sm transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                selected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {panel.tab}
              {selected && (
                <motion.span
                  layoutId="proof-underline"
                  className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-term-green"
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                />
              )}
            </button>
          )
        })}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[0.85fr_1.15fr] lg:items-start">
        {/* `mode="wait"` so the outgoing panel clears before the next arrives —
            crossfading two terminal blocks is unreadable. */}
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${active.id}-copy`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
          >
            <h3 className="font-mono text-base font-semibold">{active.heading}</h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{active.body}</p>
          </motion.div>
        </AnimatePresence>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${active.id}-trace`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
          >
            <Trace lines={active.lines} label={active.command} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
}
