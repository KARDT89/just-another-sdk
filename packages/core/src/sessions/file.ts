import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelMessage } from '../types/messages.js'
import { assertValidSessionId, type LoadOptions, type SessionStore } from './store.js'

export interface FileSessionOptions {
  /** Directory to hold one `.jsonl` file per session. Created on first write. */
  readonly dir: string
}

/**
 * One JSONL file per session. Zero setup, survives a restart, and the transcript
 * is a text file you can read.
 *
 * ```ts
 * import { fileSession } from 'just-another-sdk/sessions/file'
 *
 * const agent = new Agent({ name: 'cli', model, session: fileSession('./.sessions') })
 * ```
 *
 * ### Crash tolerance
 *
 * Each message is one appended line. If the process dies mid-write the file ends
 * in a partial line, so `load()` **skips a malformed final line** rather than
 * throwing: a crash costs the last message, not the conversation. A malformed
 * line anywhere else is a real corruption and does throw.
 *
 * ### Concurrency
 *
 * `appendFile` on a POSIX filesystem is atomic for writes under `PIPE_BUF`, which
 * covers ordinary messages, so two processes appending to one session interleave
 * cleanly. Very large tool results are the exception; use
 * {@link sqliteSession} or {@link postgresSession} if multiple writers are the
 * norm rather than the edge case.
 *
 * Node only — it imports `node:fs`. Import it from
 * `just-another-sdk/sessions/file` so an edge or browser bundle never sees it.
 */
export function fileSession(dirOrOptions: string | FileSessionOptions): SessionStore {
  const dir = typeof dirOrOptions === 'string' ? dirOrOptions : dirOrOptions.dir

  if (!dir || dir.trim().length === 0) {
    throw new TypeError('fileSession needs a directory, e.g. fileSession("./.sessions").')
  }

  let ensured: Promise<void> | undefined
  const ensureDir = (): Promise<void> => {
    ensured ??= mkdir(dir, { recursive: true }).then(() => undefined)
    return ensured
  }

  const pathFor = (sessionId: string): string => {
    assertValidSessionId(sessionId)
    // Percent-encoding collapses `/`, `..`, and anything else path-shaped into a
    // safe basename. Session ids are usually user ids off a request, so this is
    // the difference between a store and a path-traversal primitive.
    return join(dir, `${encodeURIComponent(sessionId)}.jsonl`)
  }

  /** Parses the file, tolerating a torn final line. Shared by `load` and `pop`. */
  const readAll = async (path: string): Promise<ModelMessage[]> => {
    let raw: string
    try {
      raw = await readFile(path, 'utf8')
    } catch (cause) {
      if (isNotFound(cause)) return []
      throw cause
    }

    const lines = raw.split('\n')
    const messages: ModelMessage[] = []

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]?.trim()
      if (!line) continue

      try {
        messages.push(JSON.parse(line) as ModelMessage)
      } catch (cause) {
        // A torn write can only ever be the last line in the file.
        const isLastLine = lines.slice(i + 1).every((rest) => rest.trim().length === 0)
        if (isLastLine) break
        throw new SyntaxError(`Session file ${path} is corrupt: line ${i + 1} is not valid JSON.`, {
          cause,
        })
      }
    }

    return messages
  }

  return {
    async load(sessionId: string, options?: LoadOptions): Promise<ModelMessage[]> {
      // `limit` is honoured but not cheap here: a line-delimited file cannot be
      // tailed without reading it, so this saves allocation, not I/O. Use
      // sqliteSession or postgresSession when the read cost matters.
      const messages = await readAll(pathFor(sessionId))
      const limit = options?.limit
      return limit !== undefined && limit < messages.length ? messages.slice(-limit) : messages
    },

    async append(sessionId: string, messages: readonly ModelMessage[]): Promise<void> {
      if (messages.length === 0) return
      const path = pathFor(sessionId)
      await ensureDir()
      const payload = messages.map((message) => `${JSON.stringify(message)}\n`).join('')
      await appendFile(path, payload, 'utf8')
    },

    async clear(sessionId: string): Promise<void> {
      await rm(pathFor(sessionId), { force: true })
    },

    async pop(sessionId: string): Promise<ModelMessage | undefined> {
      const path = pathFor(sessionId)
      const messages = await readAll(path)
      const removed = messages.pop()
      if (removed === undefined) return undefined

      // Rewritten whole, because a line-delimited file has no way to drop its
      // last record in place. Written to a temporary file and renamed so a crash
      // mid-write cannot leave a truncated transcript — `rename` is atomic.
      const payload = messages.map((message) => `${JSON.stringify(message)}\n`).join('')
      const temporary = `${path}.tmp`
      await writeFile(temporary, payload, 'utf8')
      await rename(temporary, path)

      return removed
    },
  }
}

function isNotFound(cause: unknown): boolean {
  return (
    typeof cause === 'object' && cause !== null && (cause as { code?: string }).code === 'ENOENT'
  )
}
