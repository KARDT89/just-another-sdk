import { ConfigurationError } from '../errors/errors.js'
import type { ModelMessage } from '../types/messages.js'
import { assertValidSessionId, type LoadOptions, type SessionStore } from './store.js'

export interface SqliteSessionOptions {
  /** Database file. Use `':memory:'` for a throwaway database. */
  readonly path: string
  /** Table name. Default `agent_session_messages`. */
  readonly table?: string
  /** Create the table and index on first use. Default `true`. */
  readonly ensureTable?: boolean
}

/** The slice of `node:sqlite`'s `DatabaseSync` this adapter uses. */
interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
  }
}

const DEFAULT_TABLE = 'agent_session_messages'

/**
 * Conversations in SQLite, through Node's built-in `node:sqlite`. Durable,
 * transactional, and still **zero dependencies** — there is no `better-sqlite3`
 * to install or compile.
 *
 * ```ts
 * import { sqliteSession } from 'just-another-sdk/sessions/sqlite'
 *
 * const agent = new Agent({ name: 'support', model, session: sqliteSession('./chat.db') })
 * ```
 *
 * The table is created on first use. Pass `ensureTable: false` when migrations
 * own your schema; the DDL is in the sessions documentation.
 *
 * **Requires Node ≥ 22.5**, where `node:sqlite` landed — the package's own floor
 * is 20.19, so an older runtime gets a `ConfigurationError` naming the version
 * rather than a bare module-not-found.
 */
export function sqliteSession(pathOrOptions: string | SqliteSessionOptions): SessionStore {
  const options = typeof pathOrOptions === 'string' ? { path: pathOrOptions } : pathOrOptions
  const table = quoteIdentifier(options.table ?? DEFAULT_TABLE)
  const ensureTable = options.ensureTable ?? true

  if (!options.path || options.path.trim().length === 0) {
    throw new TypeError('sqliteSession needs a path, e.g. sqliteSession("./chat.db").')
  }

  // Opened on first use, not at construction: building an Agent should never
  // touch the disk, and the dynamic import has to be awaited somewhere.
  let opening: Promise<SqliteDatabase> | undefined

  const db = (): Promise<SqliteDatabase> => {
    opening ??= openDatabase(options.path).then((database) => {
      if (ensureTable) {
        database.exec(
          `create table if not exists ${table} (
             seq        integer primary key autoincrement,
             session_id text    not null,
             message    text    not null,
             created_at integer not null
           );
           create index if not exists ${quoteIdentifier(`${options.table ?? DEFAULT_TABLE}_session_idx`)}
             on ${table} (session_id, seq);`,
        )
      }
      return database
    })
    return opening
  }

  return {
    async load(sessionId: string, options?: LoadOptions): Promise<ModelMessage[]> {
      assertValidSessionId(sessionId)
      const database = await db()
      const limit = options?.limit

      // Windowed reads take the newest rows and flip them back into order —
      // `desc … limit` uses the (session_id, seq) index, where `asc` with an
      // offset would have to walk the whole conversation first.
      const rows = (
        limit === undefined
          ? database
              .prepare(`select message from ${table} where session_id = ? order by seq asc`)
              .all(sessionId)
          : database
              .prepare(
                `select message from ${table} where session_id = ? order by seq desc limit ?`,
              )
              .all(sessionId, limit)
              .reverse()
      ) as { message: string }[]

      return rows.map((row) => JSON.parse(row.message) as ModelMessage)
    },

    async append(sessionId: string, messages: readonly ModelMessage[]): Promise<void> {
      assertValidSessionId(sessionId)
      if (messages.length === 0) return

      const database = await db()
      const insert = database.prepare(
        `insert into ${table} (session_id, message, created_at) values (?, ?, ?)`,
      )
      const now = Date.now()

      // One transaction, so a crash mid-turn leaves either the whole turn or
      // none of it — never an assistant tool-call without its results.
      database.exec('begin')
      try {
        for (const message of messages) insert.run(sessionId, JSON.stringify(message), now)
        database.exec('commit')
      } catch (cause) {
        database.exec('rollback')
        throw cause
      }
    },

    async clear(sessionId: string): Promise<void> {
      assertValidSessionId(sessionId)
      const database = await db()
      database.prepare(`delete from ${table} where session_id = ?`).run(sessionId)
    },

    async pop(sessionId: string): Promise<ModelMessage | undefined> {
      assertValidSessionId(sessionId)
      const database = await db()
      const rows = database
        .prepare(
          `delete from ${table}
             where seq = (select max(seq) from ${table} where session_id = ?)
             returning message`,
        )
        .all(sessionId) as { message: string }[]

      const row = rows[0]
      return row ? (JSON.parse(row.message) as ModelMessage) : undefined
    },
  }
}

async function openDatabase(path: string): Promise<SqliteDatabase> {
  let module: { DatabaseSync: new (path: string) => SqliteDatabase }

  try {
    // Dynamic so that importing this module never crashes a runtime without
    // `node:sqlite`, and so bundlers do not try to resolve it eagerly.
    module = await import('node:sqlite')
  } catch (cause) {
    throw new ConfigurationError('`node:sqlite` is not available in this runtime.', {
      cause,
      hint:
        'sqliteSession() needs Node 22.5 or newer. Use fileSession() on older Node, ' +
        'or postgresSession()/redisSession() with a client you already have.',
    })
  }

  return new module.DatabaseSync(path)
}

/**
 * A table name cannot be a bound parameter, so it is interpolated — and
 * therefore has to be quoted rather than trusted.
 */
function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(
      `Invalid table name "${name}": use letters, digits, and underscores, starting with a letter.`,
    )
  }
  return `"${name}"`
}
