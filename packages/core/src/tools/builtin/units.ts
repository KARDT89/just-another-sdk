/**
 * Unit conversion tables.
 *
 * Separated from the tool so the data is readable as data. Everything except
 * temperature is a ratio to one base unit per dimension, which makes a
 * conversion two multiplications and makes adding a unit a one-line change.
 * Temperature has offsets, so it is handled explicitly rather than bent into the
 * same shape.
 */

export type Dimension =
  'length' | 'mass' | 'temperature' | 'volume' | 'speed' | 'data' | 'duration' | 'area'

/** Every alias a model might plausibly emit, mapped to its ratio to the base. */
type Table = Readonly<Record<string, number>>

/** Base: metre. */
const LENGTH: Table = {
  nm: 1e-9,
  um: 1e-6,
  mm: 0.001,
  cm: 0.01,
  m: 1,
  metre: 1,
  meter: 1,
  km: 1000,
  kilometre: 1000,
  kilometer: 1000,
  in: 0.0254,
  inch: 0.0254,
  inches: 0.0254,
  ft: 0.3048,
  foot: 0.3048,
  feet: 0.3048,
  yd: 0.9144,
  yard: 0.9144,
  mi: 1609.344,
  mile: 1609.344,
  miles: 1609.344,
  nmi: 1852,
  ly: 9.4607304725808e15,
  au: 1.495978707e11,
}

/** Base: kilogram. */
const MASS: Table = {
  mg: 1e-6,
  g: 0.001,
  gram: 0.001,
  grams: 0.001,
  kg: 1,
  kilogram: 1,
  kilograms: 1,
  t: 1000,
  tonne: 1000,
  oz: 0.028349523125,
  ounce: 0.028349523125,
  lb: 0.45359237,
  lbs: 0.45359237,
  pound: 0.45359237,
  pounds: 0.45359237,
  st: 6.35029318,
  stone: 6.35029318,
}

/** Base: litre. */
const VOLUME: Table = {
  ml: 0.001,
  cl: 0.01,
  dl: 0.1,
  l: 1,
  litre: 1,
  liter: 1,
  litres: 1,
  liters: 1,
  m3: 1000,
  floz: 0.0295735295625,
  cup: 0.2365882365,
  pt: 0.473176473,
  pint: 0.473176473,
  qt: 0.946352946,
  quart: 0.946352946,
  gal: 3.785411784,
  gallon: 3.785411784,
  gallons: 3.785411784,
  tbsp: 0.01478676478125,
  tsp: 0.00492892159375,
}

/** Base: metres per second. */
const SPEED: Table = {
  mps: 1,
  'm/s': 1,
  kph: 1 / 3.6,
  'km/h': 1 / 3.6,
  kmh: 1 / 3.6,
  mph: 0.44704,
  fps: 0.3048,
  kn: 0.514444,
  knot: 0.514444,
  knots: 0.514444,
}

/**
 * Base: byte.
 *
 * Both conventions are here on purpose, and they differ: `kb` is 1000 and `kib`
 * is 1024. Silently picking one is how a storage estimate ends up 7% wrong.
 */
const DATA: Table = {
  b: 1,
  byte: 1,
  bytes: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
  pb: 1e15,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  pib: 1024 ** 5,
  bit: 1 / 8,
  bits: 1 / 8,
}

/** Base: second. */
const DURATION: Table = {
  ms: 0.001,
  s: 1,
  sec: 1,
  second: 1,
  seconds: 1,
  min: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hour: 3600,
  hours: 3600,
  d: 86_400,
  day: 86_400,
  days: 86_400,
  wk: 604_800,
  week: 604_800,
  weeks: 604_800,
  // Calendar-aware arithmetic belongs in `date_math`; these are fixed spans, and
  // a "month" that is sometimes 28 days has no place in a ratio table.
  yr: 31_557_600,
  year: 31_557_600,
  years: 31_557_600,
}

/** Base: square metre. */
const AREA: Table = {
  mm2: 1e-6,
  cm2: 1e-4,
  m2: 1,
  km2: 1e6,
  ha: 1e4,
  hectare: 1e4,
  in2: 0.00064516,
  ft2: 0.09290304,
  yd2: 0.83612736,
  ac: 4046.8564224,
  acre: 4046.8564224,
  mi2: 2_589_988.110336,
}

const TEMPERATURE = new Set(['c', 'celsius', 'f', 'fahrenheit', 'k', 'kelvin', 'r', 'rankine'])

const TABLES: Readonly<Record<Exclude<Dimension, 'temperature'>, Table>> = {
  length: LENGTH,
  mass: MASS,
  volume: VOLUME,
  speed: SPEED,
  data: DATA,
  duration: DURATION,
  area: AREA,
}

export interface ConversionResult {
  readonly value: number
  readonly dimension: Dimension
  /** The canonical name of the unit, so a model learns the vocabulary. */
  readonly from: string
  readonly to: string
}

export class ConversionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConversionError'
  }
}

/** Normalises `"Km"`, `" km "`, and `"KM"` to the same key. */
function normalize(unit: string): string {
  return unit.trim().toLowerCase().replace(/\s+/gu, '')
}

function dimensionOf(unit: string): Dimension | undefined {
  if (TEMPERATURE.has(unit)) return 'temperature'
  for (const [dimension, table] of Object.entries(TABLES)) {
    if (unit in table) return dimension as Dimension
  }
  return undefined
}

/**
 * Converts between two units of the same dimension.
 *
 * Refuses a cross-dimension conversion rather than producing a number: "3 km in
 * kilograms" has no answer, and inventing one is worse than an error the model
 * can read and correct.
 */
export function convertUnits(value: number, fromUnit: string, toUnit: string): ConversionResult {
  const from = normalize(fromUnit)
  const to = normalize(toUnit)

  const fromDimension = dimensionOf(from)
  const toDimension = dimensionOf(to)

  if (!fromDimension) throw new ConversionError(unknownUnit(fromUnit))
  if (!toDimension) throw new ConversionError(unknownUnit(toUnit))

  if (fromDimension !== toDimension) {
    throw new ConversionError(
      `Cannot convert ${fromUnit} (${fromDimension}) to ${toUnit} (${toDimension}) — they measure different things.`,
    )
  }

  const converted =
    fromDimension === 'temperature'
      ? fromKelvin(toKelvin(value, from), to)
      : ratioConvert(value, from, to, fromDimension)

  return { value: converted, dimension: fromDimension, from, to }
}

function ratioConvert(
  value: number,
  from: string,
  to: string,
  dimension: Exclude<Dimension, 'temperature'>,
): number {
  const table = TABLES[dimension]
  return (value * (table[from] as number)) / (table[to] as number)
}

function toKelvin(value: number, unit: string): number {
  switch (unit) {
    case 'c':
    case 'celsius':
      return value + 273.15
    case 'f':
    case 'fahrenheit':
      return (value - 32) / 1.8 + 273.15
    case 'r':
    case 'rankine':
      return value / 1.8
    default:
      return value
  }
}

function fromKelvin(kelvin: number, unit: string): number {
  switch (unit) {
    case 'c':
    case 'celsius':
      return kelvin - 273.15
    case 'f':
    case 'fahrenheit':
      return (kelvin - 273.15) * 1.8 + 32
    case 'r':
    case 'rankine':
      return kelvin * 1.8
    default:
      return kelvin
  }
}

function unknownUnit(unit: string): string {
  return (
    `Unknown unit "${unit}". Supported dimensions: ` +
    `${[...Object.keys(TABLES), 'temperature'].join(', ')}. ` +
    'Use a short symbol such as km, kg, l, mph, gb, h, m2, or c.'
  )
}

/** Every unit the tool accepts, so the docs page cannot drift from the tables. */
export function supportedUnits(): Readonly<Record<Dimension, readonly string[]>> {
  const listed = {} as Record<Dimension, readonly string[]>

  for (const dimension of Object.keys(TABLES) as (keyof typeof TABLES)[]) {
    listed[dimension] = Object.keys(TABLES[dimension])
  }
  listed.temperature = [...TEMPERATURE]

  return listed
}
