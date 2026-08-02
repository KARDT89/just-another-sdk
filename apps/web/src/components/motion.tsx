'use client'

import { MotionConfig, motion, useReducedMotion, type Variants } from 'motion/react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/**
 * A small, deliberately boring motion vocabulary.
 *
 * Four primitives, used everywhere, so the page moves like one thing rather than
 * a collection of effects. Keeping them here also keeps the rest of the page a
 * server component — only the sections that actually animate ship JavaScript.
 *
 * Everything respects `prefers-reduced-motion`: {@link MotionRoot} sets
 * `reducedMotion="user"`, which makes Motion drop transforms and opacity fades
 * for anyone who asked for less movement. The ambient background is stricter
 * still and renders nothing at all.
 */

/** Fast, slightly overshooting spring. Used for anything the pointer touches. */
const SPRING = { type: 'spring', stiffness: 400, damping: 30 } as const

/** The one easing curve on the page. Calm, no bounce, for scroll reveals. */
const EASE = [0.16, 1, 0.3, 1] as const

/** Reveal once, when scrolled into view. Never replays — a page that keeps
 * re-animating as you scroll back up reads as broken, not lively. */
const VIEWPORT = { once: true, margin: '-80px' } as const

export function MotionRoot({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>
}

export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode
  className?: string
  delay?: number
}) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={VIEWPORT}
      transition={{ duration: 0.55, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  )
}

const STAGGER_PARENT: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.07 } },
}

const STAGGER_CHILD: Variants = {
  hidden: { opacity: 0, y: 20 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } },
}

export function Stagger({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={className}
      variants={STAGGER_PARENT}
      initial="hidden"
      whileInView="shown"
      viewport={VIEWPORT}
    >
      {children}
    </motion.div>
  )
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} variants={STAGGER_CHILD}>
      {children}
    </motion.div>
  )
}

/** A card that lifts on hover. `y` only — scaling text makes it blurry mid-transition. */
export function Lift({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={cn('h-full', className)} whileHover={{ y: -4 }} transition={SPRING}>
      {children}
    </motion.div>
  )
}

/** Press feedback for the primary calls to action. */
export function Press({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div
      className={cn('inline-flex', className)}
      whileHover={{ scale: 1.03 }}
      whileTap={{ scale: 0.97 }}
      transition={SPRING}
    >
      {children}
    </motion.div>
  )
}

/**
 * The hero's ambient wash: two slow, counter-drifting radial gradients.
 *
 * Rendered as nothing under reduced motion rather than paused — a large static
 * green blob is not what someone who turned motion off is asking for. The
 * hero's own CSS gradient stays underneath either way, so the section never
 * looks empty.
 */
export function AmbientGlow() {
  const reduced = useReducedMotion()
  if (reduced) return null

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <motion.div
        className="absolute -top-40 left-1/4 size-[36rem] rounded-full blur-3xl"
        style={{
          background:
            'radial-gradient(circle, color-mix(in oklch, var(--color-term-green) 16%, transparent), transparent 70%)',
        }}
        animate={{ x: [0, 60, -30, 0], y: [0, 40, 10, 0] }}
        transition={{ duration: 26, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -top-24 right-1/4 size-[28rem] rounded-full blur-3xl"
        style={{
          background:
            'radial-gradient(circle, color-mix(in oklch, var(--color-term-cyan) 12%, transparent), transparent 70%)',
        }}
        animate={{ x: [0, -50, 20, 0], y: [0, 30, -20, 0] }}
        transition={{ duration: 32, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  )
}
