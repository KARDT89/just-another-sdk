/**
 * The tools every agent gets.
 *
 * Five pure functions. No network, no disk, no configuration, nothing to lock
 * down — which is the whole reason these and only these are automatic. A tool
 * that can reach the network or the filesystem must never appear on an agent
 * nobody configured; see `just-another-sdk/tools` for those.
 *
 * Each one earns its place by being something models reliably get wrong on their
 * own: arithmetic, the current date, date arithmetic, and unit conversion are
 * four of the most common sources of a confidently wrong answer.
 */

import { s } from '../../schema/mini.js'
import { tool, type AnyTool } from '../tool.js'
import { evaluateExpression } from './calculator.js'
import { convertUnits, supportedUnits } from './units.js'

/**
 * Arithmetic, without handing the model a code execution primitive.
 *
 * See [`calculator.ts`](./calculator.ts) — there is no `eval` behind this.
 */
export const calculate: AnyTool = tool({
  name: 'calculate',
  description:
    'Evaluate an arithmetic expression and return the exact result. Use this for ANY ' +
    'calculation rather than working it out yourself, including simple ones. Supports ' +
    '+ - * / % ^, parentheses, and functions: abs, round, floor, ceil, sqrt, pow, min, ' +
    'max, hypot, log, ln, exp, sin, cos, tan. Constants: pi, e.',
  inputSchema: s.object({
    expression: s.string({
      describe: 'The expression to evaluate, e.g. "(1200 * 1.08) / 12" or "sqrt(2) * 100".',
      maxLength: 1000,
    }),
  }),
  // A malformed expression throws, and `executeToolCall` turns that into a
  // recoverable `tool-result` carrying the parse error verbatim — so the model
  // reads "Division by zero." and fixes it on the next turn.
  execute: ({ expression }) => ({ expression, result: evaluateExpression(expression) }),
})

/**
 * The current date and time.
 *
 * Models have no clock, and the one in their training data is wrong. Timezone
 * handling is `Intl`, which is built into every supported runtime — so this
 * stays zero-dependency.
 */
export const currentTime: AnyTool = tool({
  name: 'current_time',
  description:
    'Get the current date and time. Call this before any reasoning that depends on ' +
    '"today", "now", or how long ago something was — you do not otherwise know the date.',
  inputSchema: s.object({
    timezone: s.optional(
      s.string({
        describe: 'IANA timezone, e.g. "Europe/Paris" or "America/New_York". Defaults to UTC.',
      }),
    ),
  }),
  execute: ({ timezone }) => {
    const now = new Date()
    const zone = timezone ?? 'UTC'

    let formatted: string
    try {
      formatted = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(now)
    } catch {
      throw new Error(
        `Unknown timezone "${zone}". Use an IANA name such as "Europe/Paris" or "UTC".`,
      )
    }

    return {
      iso: now.toISOString(),
      timezone: zone,
      formatted,
      unixSeconds: Math.floor(now.getTime() / 1000),
      weekday: new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'long' }).format(now),
    }
  },
})

const DATE_UNITS = ['minutes', 'hours', 'days', 'weeks', 'months', 'years'] as const
type DateUnit = (typeof DATE_UNITS)[number]

/**
 * Calendar arithmetic.
 *
 * Separate from `unit_convert` because months and years are not ratios: adding
 * one month to 31 January is a calendar question, not a multiplication, and
 * getting it wrong by a day is the kind of error nobody notices until it
 * matters.
 */
export const dateMath: AnyTool = tool({
  name: 'date_math',
  description:
    'Shift a date, measure the gap between two dates, or describe one. Use this rather ' +
    'than counting days yourself — month lengths and leap years make that unreliable. ' +
    'Dates are ISO 8601, or "now".',
  inputSchema: s.object({
    operation: s.enum(['add', 'subtract', 'difference', 'describe'], {
      describe: 'difference needs `other`; add and subtract need `amount` and `unit`.',
    }),
    date: s.string({ describe: 'The base date, e.g. "2026-03-14" or "now".' }),
    amount: s.optional(s.number({ describe: 'How much to add or subtract.' })),
    unit: s.optional(s.enum(DATE_UNITS)),
    other: s.optional(s.string({ describe: 'The second date, for difference.' })),
  }),
  execute: ({ operation, date, amount, unit, other }) => {
    const base = parseDate(date, 'date')

    if (operation === 'describe') return describeDate(base)

    if (operation === 'difference') {
      if (other === undefined) {
        throw new Error('`other` is required for a difference. Pass the second date.')
      }
      return differenceBetween(base, parseDate(other, 'other'))
    }

    if (amount === undefined || unit === undefined) {
      throw new Error(`\`amount\` and \`unit\` are both required for ${operation}.`)
    }

    const signed = operation === 'subtract' ? -amount : amount
    const result = shiftDate(base, signed, unit)

    return {
      result: result.toISOString(),
      ...describeDate(result),
      from: base.toISOString(),
      applied: `${signed >= 0 ? '+' : ''}${signed} ${unit}`,
    }
  },
})

/**
 * A place to think.
 *
 * Does nothing, on purpose. It gives the model somewhere to lay out a plan
 * mid-loop without that reasoning having to be the final answer, which measurably
 * improves long tool-using runs. Costs one cheap turn and cannot fail.
 */
export const think: AnyTool = tool({
  name: 'think',
  description:
    'Record a private thought without taking any action. Use it to plan before a ' +
    'complex sequence of tool calls, to check a result against what you expected, or ' +
    'to work through a decision. Nothing happens and nobody sees it — it is scratch space.',
  inputSchema: s.object({
    thought: s.string({ describe: 'What you are working through.', maxLength: 10_000 }),
  }),
  execute: () => ({ recorded: true }),
})

/** Convert between units of length, mass, temperature, volume, speed, data, and more. */
export const unitConvert: AnyTool = tool({
  name: 'unit_convert',
  description:
    'Convert a value between units. Use this rather than converting yourself — a silent ' +
    'unit error is worse than no answer. Dimensions: length, mass, temperature, volume, ' +
    'speed, data, duration, area. Note kb is 1000 bytes and kib is 1024.',
  inputSchema: s.object({
    value: s.number({ describe: 'The quantity to convert.' }),
    from: s.string({ describe: 'Unit to convert from, e.g. "km", "lb", "c", "gb".' }),
    to: s.string({ describe: 'Unit to convert to, e.g. "mi", "kg", "f", "mib".' }),
  }),
  execute: ({ value, from, to }) => {
    const converted = convertUnits(value, from, to)
    return {
      value: converted.value,
      unit: converted.to,
      dimension: converted.dimension,
      input: { value, unit: converted.from },
    }
  },
})

/**
 * The tools added to every agent unless `builtins: false`.
 *
 * Order matters only for the trace: this is the order the model sees them in.
 */
export const PURE_BUILTINS: readonly AnyTool[] = Object.freeze([
  calculate,
  currentTime,
  dateMath,
  unitConvert,
  think,
])

/** Exported for the docs, so the page listing units cannot drift from the code. */
export { supportedUnits }

/* ------------------------------------------------------------------------- */
/* Date helpers                                                              */
/* ------------------------------------------------------------------------- */

function parseDate(value: string, field: string): Date {
  if (value.trim().toLowerCase() === 'now') return new Date()

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `\`${field}\` is not a valid date: ${JSON.stringify(value)}. ` +
        'Use ISO 8601, e.g. "2026-03-14" or "2026-03-14T09:30:00Z", or "now".',
    )
  }
  return parsed
}

/**
 * Shifts a date, keeping months calendar-correct.
 *
 * Adding a month to 31 January gives 28 February (or 29 in a leap year) rather
 * than rolling into March, which is what `setMonth` does on its own and what
 * almost every hand-rolled version gets wrong.
 */
function shiftDate(base: Date, amount: number, unit: DateUnit): Date {
  const result = new Date(base.getTime())

  switch (unit) {
    case 'minutes':
      result.setUTCMinutes(result.getUTCMinutes() + amount)
      return result
    case 'hours':
      result.setUTCHours(result.getUTCHours() + amount)
      return result
    case 'days':
      result.setUTCDate(result.getUTCDate() + amount)
      return result
    case 'weeks':
      result.setUTCDate(result.getUTCDate() + amount * 7)
      return result
    case 'months':
      return addMonths(result, amount)
    case 'years':
      return addMonths(result, amount * 12)
  }
}

function addMonths(date: Date, months: number): Date {
  const day = date.getUTCDate()
  const shifted = new Date(date.getTime())

  // Clamp to the 1st before shifting, so the month arithmetic cannot overflow,
  // then restore the day capped to whatever the target month actually has.
  shifted.setUTCDate(1)
  shifted.setUTCMonth(shifted.getUTCMonth() + months)

  const lastDay = new Date(
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0),
  ).getUTCDate()

  shifted.setUTCDate(Math.min(day, lastDay))
  return shifted
}

function differenceBetween(from: Date, to: Date): Record<string, unknown> {
  const ms = to.getTime() - from.getTime()
  const seconds = Math.trunc(ms / 1000)

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    milliseconds: ms,
    seconds,
    minutes: round(ms / 60_000),
    hours: round(ms / 3_600_000),
    days: round(ms / 86_400_000),
    weeks: round(ms / 604_800_000),
    // Whole calendar days, which is what "how many days until" usually means.
    calendarDays: Math.round(
      (Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) -
        Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate())) /
        86_400_000,
    ),
    direction: ms === 0 ? 'same' : ms > 0 ? 'after' : 'before',
  }
}

function describeDate(date: Date): Record<string, unknown> {
  const year = date.getUTCFullYear()
  const startOfYear = Date.UTC(year, 0, 1)
  const dayOfYear = Math.floor((date.getTime() - startOfYear) / 86_400_000) + 1

  return {
    iso: date.toISOString(),
    date: date.toISOString().slice(0, 10),
    weekday: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' }).format(date),
    year,
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    dayOfYear,
    isoWeek: isoWeekNumber(date),
    isLeapYear: (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0,
    daysInMonth: new Date(Date.UTC(year, date.getUTCMonth() + 1, 0)).getUTCDate(),
  }
}

/** ISO-8601 week number: weeks start Monday, week 1 contains the first Thursday. */
function isoWeekNumber(date: Date): number {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNumber = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNumber + 3)

  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3)

  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / 604_800_000)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
