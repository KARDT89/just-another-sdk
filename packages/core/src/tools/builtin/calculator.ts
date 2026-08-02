/**
 * An arithmetic expression evaluator.
 *
 * **There is no `eval` and no `Function` in this file, and there never will be.**
 * That is the entire reason it exists: the obvious three-line implementation of
 * a calculator tool hands a language model a general-purpose code execution
 * primitive, and a model does not have to be malicious to reach it — a prompt
 * injection in a fetched web page is enough. A test asserts this module's own
 * source contains neither identifier.
 *
 * What it is instead: a recursive-descent parser over a small grammar.
 *
 * ```text
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/' | '%') unary)*
 *   unary      := ('-' | '+') unary | power
 *   power      := primary ('^' unary)?          // right-associative
 *   primary    := number | name ('(' args ')')? | '(' expression ')'
 * ```
 *
 * Anything outside that grammar — a property access, a string, a semicolon — is
 * a parse error naming the offending character, not a silent surprise.
 */

/** Thrown for any malformed expression. Callers turn it into a tool result. */
export class ExpressionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpressionError'
  }
}

/** Constants a model can name. Lower-cased on lookup, so `PI` also works. */
const CONSTANTS: Readonly<Record<string, number>> = Object.freeze({
  pi: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
})

type Fn = (args: readonly number[]) => number

/**
 * The callable functions.
 *
 * A deliberately closed list. Reaching `Math` directly would expose whatever
 * that object happens to carry in a given runtime; this exposes exactly what is
 * written here.
 */
const FUNCTIONS: Readonly<Record<string, { arity: number | 'variadic'; fn: Fn }>> = Object.freeze({
  abs: { arity: 1, fn: ([x]) => Math.abs(x as number) },
  ceil: { arity: 1, fn: ([x]) => Math.ceil(x as number) },
  floor: { arity: 1, fn: ([x]) => Math.floor(x as number) },
  round: { arity: 1, fn: ([x]) => Math.round(x as number) },
  trunc: { arity: 1, fn: ([x]) => Math.trunc(x as number) },
  sign: { arity: 1, fn: ([x]) => Math.sign(x as number) },
  sqrt: {
    arity: 1,
    fn: ([x]) => {
      if ((x as number) < 0) throw new ExpressionError('sqrt of a negative number is not real.')
      return Math.sqrt(x as number)
    },
  },
  cbrt: { arity: 1, fn: ([x]) => Math.cbrt(x as number) },
  exp: { arity: 1, fn: ([x]) => Math.exp(x as number) },
  ln: { arity: 1, fn: ([x]) => logOf(Math.log, x as number, 'ln') },
  log: { arity: 1, fn: ([x]) => logOf(Math.log10, x as number, 'log') },
  log2: { arity: 1, fn: ([x]) => logOf(Math.log2, x as number, 'log2') },
  log10: { arity: 1, fn: ([x]) => logOf(Math.log10, x as number, 'log10') },
  pow: { arity: 2, fn: ([x, y]) => (x as number) ** (y as number) },
  sin: { arity: 1, fn: ([x]) => Math.sin(x as number) },
  cos: { arity: 1, fn: ([x]) => Math.cos(x as number) },
  tan: { arity: 1, fn: ([x]) => Math.tan(x as number) },
  asin: { arity: 1, fn: ([x]) => Math.asin(x as number) },
  acos: { arity: 1, fn: ([x]) => Math.acos(x as number) },
  atan: { arity: 1, fn: ([x]) => Math.atan(x as number) },
  atan2: { arity: 2, fn: ([y, x]) => Math.atan2(y as number, x as number) },
  hypot: { arity: 'variadic', fn: (args) => Math.hypot(...args) },
  min: { arity: 'variadic', fn: (args) => Math.min(...args) },
  max: { arity: 'variadic', fn: (args) => Math.max(...args) },
})

function logOf(fn: (x: number) => number, x: number, name: string): number {
  if (x <= 0) throw new ExpressionError(`${name} requires a positive number, received ${x}.`)
  return fn(x)
}

/** Bounds a pathological input before it becomes a parsing cost. */
const MAX_LENGTH = 1_000

/**
 * Evaluates an arithmetic expression.
 *
 * @throws {ExpressionError} for anything malformed, unknown, or non-finite.
 */
export function evaluateExpression(input: string): number {
  if (input.trim().length === 0) {
    throw new ExpressionError('The expression is empty.')
  }
  if (input.length > MAX_LENGTH) {
    throw new ExpressionError(`The expression is longer than ${MAX_LENGTH} characters.`)
  }

  const parser = new Parser(input)
  const value = parser.parseExpression()
  parser.expectEnd()

  if (!Number.isFinite(value)) {
    throw new ExpressionError(
      Number.isNaN(value)
        ? 'The expression is not a number.'
        : 'The result is too large to represent.',
    )
  }

  return value
}

/**
 * A hand-written parser over the character stream.
 *
 * No tokenizer pass: the grammar is small enough that reading characters on
 * demand is shorter than building a token array, and it makes error positions
 * exact for free.
 */
class Parser {
  private readonly source: string
  private index = 0

  constructor(source: string) {
    this.source = source
  }

  parseExpression(): number {
    let left = this.parseTerm()

    for (;;) {
      const operator = this.peekOperator('+', '-')
      if (!operator) return left

      this.index += 1
      const right = this.parseTerm()
      left = operator === '+' ? left + right : left - right
    }
  }

  private parseTerm(): number {
    let left = this.parseUnary()

    for (;;) {
      const operator = this.peekOperator('*', '/', '%')
      if (!operator) return left

      this.index += 1
      const right = this.parseUnary()

      if ((operator === '/' || operator === '%') && right === 0) {
        throw new ExpressionError('Division by zero.')
      }

      left = operator === '*' ? left * right : operator === '/' ? left / right : left % right
    }
  }

  private parseUnary(): number {
    this.skipSpace()
    const char = this.source[this.index]

    if (char === '-') {
      this.index += 1
      return -this.parseUnary()
    }
    if (char === '+') {
      this.index += 1
      return this.parseUnary()
    }

    return this.parsePower()
  }

  private parsePower(): number {
    const base = this.parsePrimary()

    // Right-associative on purpose: `2^3^2` is 512, not 64. Recursing into
    // `parseUnary` rather than `parsePower` is also what makes `2^-1` parse.
    if (this.peekOperator('^')) {
      this.index += 1
      return base ** this.parseUnary()
    }

    return base
  }

  private parsePrimary(): number {
    this.skipSpace()

    if (this.index >= this.source.length) {
      throw new ExpressionError('The expression ends unexpectedly.')
    }

    const char = this.source[this.index] as string

    if (char === '(') {
      this.index += 1
      const value = this.parseExpression()
      this.expect(')')
      return value
    }

    if (isDigit(char) || char === '.') return this.parseNumber()
    if (isNameStart(char)) return this.parseName()

    throw new ExpressionError(`Unexpected "${char}" at position ${this.index}.`)
  }

  private parseNumber(): number {
    const start = this.index

    while (this.index < this.source.length && isDigit(this.source[this.index] as string)) {
      this.index += 1
    }
    if (this.source[this.index] === '.') {
      this.index += 1
      while (this.index < this.source.length && isDigit(this.source[this.index] as string)) {
        this.index += 1
      }
    }

    // Scientific notation, but only when an exponent actually follows — so the
    // `e` in `2 * e` still resolves to Euler's number.
    const exponent = this.source[this.index]
    if (exponent === 'e' || exponent === 'E') {
      const save = this.index
      this.index += 1
      const sign = this.source[this.index]
      if (sign === '+' || sign === '-') this.index += 1

      if (isDigit(this.source[this.index] ?? '')) {
        while (this.index < this.source.length && isDigit(this.source[this.index] as string)) {
          this.index += 1
        }
      } else {
        this.index = save
      }
    }

    const text = this.source.slice(start, this.index)
    const value = Number(text)

    if (!Number.isFinite(value)) throw new ExpressionError(`"${text}" is not a valid number.`)
    return value
  }

  private parseName(): number {
    const start = this.index
    while (this.index < this.source.length && isNamePart(this.source[this.index] as string)) {
      this.index += 1
    }

    const raw = this.source.slice(start, this.index)
    const name = raw.toLowerCase()

    this.skipSpace()
    if (this.source[this.index] === '(') {
      this.index += 1
      const args = this.parseArguments()
      return this.callFunction(name, raw, args)
    }

    const constant = CONSTANTS[name]
    if (constant !== undefined) return constant

    throw new ExpressionError(
      `Unknown name "${raw}". Available: ${[...Object.keys(CONSTANTS), ...Object.keys(FUNCTIONS)].join(', ')}.`,
    )
  }

  private parseArguments(): number[] {
    const args: number[] = []

    this.skipSpace()
    if (this.source[this.index] === ')') {
      this.index += 1
      return args
    }

    for (;;) {
      args.push(this.parseExpression())
      this.skipSpace()

      if (this.source[this.index] === ',') {
        this.index += 1
        continue
      }

      this.expect(')')
      return args
    }
  }

  private callFunction(name: string, raw: string, args: readonly number[]): number {
    const entry = FUNCTIONS[name]
    if (!entry) {
      throw new ExpressionError(
        `Unknown function "${raw}". Available: ${Object.keys(FUNCTIONS).join(', ')}.`,
      )
    }

    if (entry.arity === 'variadic') {
      if (args.length === 0) throw new ExpressionError(`${raw} needs at least one argument.`)
    } else if (args.length !== entry.arity) {
      throw new ExpressionError(
        `${raw} takes ${entry.arity} argument${entry.arity === 1 ? '' : 's'}, received ${args.length}.`,
      )
    }

    return entry.fn(args)
  }

  expectEnd(): void {
    this.skipSpace()
    if (this.index < this.source.length) {
      throw new ExpressionError(
        `Unexpected "${this.source.slice(this.index)}" after a complete expression.`,
      )
    }
  }

  private expect(char: string): void {
    this.skipSpace()
    if (this.source[this.index] !== char) {
      throw new ExpressionError(`Expected "${char}" at position ${this.index}.`)
    }
    this.index += 1
  }

  /** Looks past whitespace for one of these operators, without consuming it. */
  private peekOperator<T extends string>(...operators: readonly T[]): T | undefined {
    this.skipSpace()
    const char = this.source[this.index]
    return operators.find((operator) => operator === char)
  }

  private skipSpace(): void {
    while (this.index < this.source.length && /\s/u.test(this.source[this.index] as string)) {
      this.index += 1
    }
  }
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9'
}

function isNameStart(char: string): boolean {
  return /[A-Za-z_]/u.test(char)
}

function isNamePart(char: string): boolean {
  return /[A-Za-z0-9_]/u.test(char)
}
