import { ConfigurationError } from '../errors/errors.js'
import type { ModelMessage } from '../types/messages.js'
import { assertValidSessionId, type LoadOptions, type SessionStore } from './store.js'

/**
 * The one thing this adapter needs: run parameterised SQL, get rows back.
 *
 * Placeholders are Postgres-style (`$1`, `$2`). Every supported client already
 * speaks this, which is why no driver has to be imported.
 */
export type SqlQuery = (sql: string, params: readonly unknown[]) => Promise<unknown>

/** `pg`'s `Pool` and `Client`, structurally. */
export interface PgClientLike {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: unknown[] }>
}

/** A `postgres.js` tagged-template client, structurally. */
export interface PostgresJsLike {
  unsafe(sql: string, params?: readonly unknown[]): PromiseLike<unknown>
}

export type PostgresClient = SqlQuery | PgClientLike | PostgresJsLike

export interface PostgresSessionOptions {
  readonly client: PostgresClient
  /** Table name. Default `agent_session_messages`. */
  readonly table?: string
  /** Schema-qualify the table, e.g. `'app'`. Default: none. */
  readonly schema?: string
  /** Create the table and index on first use. Default `true`. */
  readonly ensureTable?: boolean
}

const DEFAULT_TABLE = 'agent_session_messages'

/**
 * Conversations in Postgres, using **the client you already have**.
 *
 * ```ts
 * import { Pool } from 'pg'
 * import { postgresSession } from 'just-another-sdk/sessions'
 *
 * const pool = new Pool({ connectionString: process.env.DATABASE_URL })
 * const agent = new Agent({ name: 'support', model, session: postgresSession(pool) })
 * ```
 *
 * Accepted without any adapter code of your own:
 *
 * | You pass                      | Detected via               |
 * | ----------------------------- | -------------------------- |
 * | `pg` `Pool` / `Client`        | `.query(sql, params)`      |
 * | `postgres.js` `sql`           | `.unsafe(sql, params)`     |
 * | `async (sql, params) => rows` | it is already the function |
 *
 * An ORM is one line, because both expose the escape hatch this needs:
 *
 * ```ts
 * postgresSession(db.$client)                                     // Drizzle
 * postgresSession((sql, p) => prisma.$queryRawUnsafe(sql, ...p))  // Prisma
 * ```
 *
 * No driver is imported and none is a dependency — the types above are
 * structural, so the SDK keeps its zero-dependency guarantee whatever you use.
 *
 * The table is created on first use. With `ensureTable: false` you own the
 * schema; the DDL is in the sessions documentation.
 */
export function postgresSession(
  clientOrOptions: PostgresClient | PostgresSessionOptions,
): SessionStore {
  const options = isPostgresSessionOptions(clientOrOptions)
    ? clientOrOptions
    : { client: clientOrOptions }

  const tableName = options.table ?? DEFAULT_TABLE
  const table = options.schema
    ? `${quoteIdentifier(options.schema)}.${quoteIdentifier(tableName)}`
    : quoteIdentifier(tableName)
  const ensureTable = options.ensureTable ?? true
  const query = toSqlQuery(options.client)

  let ensured: Promise<void> | undefined
  const ready = (): Promise<void> => {
    if (!ensureTable) return Promise.resolve()
    ensured ??= (async () => {
      await query(
        `create table if not exists ${table} (
           seq        bigserial   primary key,
           session_id text        not null,
           message    jsonb       not null,
           created_at timestamptz not null default now()
         )`,
        [],
      )
      await query(
        `create index if not exists ${quoteIdentifier(`${tableName}_session_idx`)}
           on ${table} (session_id, seq)`,
        [],
      )
    })()
    return ensured
  }

  return {
    async load(sessionId: string, options?: LoadOptions): Promise<ModelMessage[]> {
      assertValidSessionId(sessionId)
      await ready()
      const limit = options?.limit

      // Windowed reads take the newest rows and flip them back into order: the
      // (session_id, seq) index serves `desc … limit` directly, where `asc` with
      // an offset would scan the whole conversation first.
      const rows =
        limit === undefined
          ? toRows(
              await query(`select message from ${table} where session_id = $1 order by seq asc`, [
                sessionId,
              ]),
            )
          : toRows(
              await query(
                `select message from ${table} where session_id = $1 order by seq desc limit $2`,
                [sessionId, limit],
              ),
            ).reverse()

      return rows.map((row) => parseMessage((row as { message: unknown }).message))
    },

    async append(sessionId: string, messages: readonly ModelMessage[]): Promise<void> {
      assertValidSessionId(sessionId)
      if (messages.length === 0) return
      await ready()

      // One multi-row insert rather than one round trip per message: a turn with
      // three tool results should not cost four network hops.
      const values = messages.map((_, index) => `($1, $${index + 2}::jsonb)`).join(', ')
      await query(`insert into ${table} (session_id, message) values ${values}`, [
        sessionId,
        ...messages.map((message) => JSON.stringify(message)),
      ])
    },

    async clear(sessionId: string): Promise<void> {
      assertValidSessionId(sessionId)
      await ready()
      await query(`delete from ${table} where session_id = $1`, [sessionId])
    },

    async pop(sessionId: string): Promise<ModelMessage | undefined> {
      assertValidSessionId(sessionId)
      await ready()
      const rows = toRows(
        await query(
          `delete from ${table}
             where seq = (select max(seq) from ${table} where session_id = $1)
             returning message`,
          [sessionId],
        ),
      )

      const row = rows[0]
      return row === undefined ? undefined : parseMessage((row as { message: unknown }).message)
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Client detection                                                          */
/* ------------------------------------------------------------------------- */

function toSqlQuery(client: PostgresClient): SqlQuery {
  if (typeof client === 'function') return client

  if (typeof client !== 'object' || client === null) {
    throw unrecognised(client)
  }

  const candidate = client as Partial<PostgresJsLike & PgClientLike>

  if (typeof candidate.unsafe === 'function') {
    const postgresJs = client as PostgresJsLike
    return async (sql, params) => postgresJs.unsafe(sql, params)
  }

  if (typeof candidate.query === 'function') {
    const pg = client as PgClientLike
    return async (sql, params) => pg.query(sql, params)
  }

  throw unrecognised(client)
}

function unrecognised(client: unknown): ConfigurationError {
  return new ConfigurationError('postgresSession() did not recognise that client.', {
    hint:
      'Pass a pg Pool/Client, a postgres.js client, or a function ' +
      '`(sql, params) => Promise<rows>`. For Drizzle, pass the driver underneath: ' +
      'postgresSession(db.$client). For Prisma, wrap it: ' +
      'postgresSession((sql, p) => prisma.$queryRawUnsafe(sql, ...p)).',
    details: { received: typeof client },
  })
}

/** `pg` answers with `{ rows }`; `postgres.js` answers with an array. */
function toRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result
  if (
    typeof result === 'object' &&
    result !== null &&
    Array.isArray((result as { rows?: unknown[] }).rows)
  ) {
    return (result as { rows: unknown[] }).rows
  }
  return []
}

/** Drivers differ on whether `jsonb` arrives parsed. Accept either. */
function parseMessage(value: unknown): ModelMessage {
  return typeof value === 'string' ? (JSON.parse(value) as ModelMessage) : (value as ModelMessage)
}

function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(
      `Invalid identifier "${name}": use letters, digits, and underscores, starting with a letter.`,
    )
  }
  return `"${name}"`
}

function isPostgresSessionOptions(
  value: PostgresClient | PostgresSessionOptions,
): value is PostgresSessionOptions {
  return typeof value === 'object' && value !== null && 'client' in value
}
