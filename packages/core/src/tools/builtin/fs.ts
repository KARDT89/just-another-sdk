/**
 * Filesystem tools, rooted at a directory you name.
 *
 * A separate entry point (`just-another-sdk/tools/fs`) for the same reason
 * [`sessions/file`](../../sessions/file.ts) is one: a browser or edge bundle
 * that imports `tools` must never pull in `node:fs`.
 *
 * **The containment rule.** Every path is resolved to a real path and then
 * asserted to be inside the root. Normalising `..` away is *not* enough on its
 * own — a symlink inside the root pointing at `/etc` normalises to a perfectly
 * innocent-looking path and then reads `/etc` anyway. Resolving first is what
 * catches it, and there is a test that plants exactly that symlink.
 */

import {
  realpath,
  readFile as read,
  writeFile as write,
  mkdir,
  readdir,
  stat,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { ConfigurationError } from '../../errors/errors.js'
import { s } from '../../schema/mini.js'
import { tool, type AnyTool } from '../tool.js'

export interface FileToolsOptions {
  /**
   * The only directory these tools can see. **Required.**
   *
   * Everything is relative to it, and nothing outside it is reachable — not by
   * `..`, not by an absolute path, not through a symlink.
   */
  readonly root: string

  /**
   * Include `write_file`, `edit_file`, and directory creation. Default `false`.
   *
   * Separate from read because the two have very different consequences and
   * most agents only need one of them.
   */
  readonly write?: boolean

  /** Cap on a single read, in bytes. Default 256 KB. */
  readonly maxReadBytes?: number

  /** Cap on a single write, in bytes. Default 256 KB. */
  readonly maxWriteBytes?: number

  /** Entries returned by one `list_directory` or `search_files`. Default 200. */
  readonly maxEntries?: number
}

const DEFAULTS = Object.freeze({
  maxReadBytes: 256 * 1024,
  maxWriteBytes: 256 * 1024,
  maxEntries: 200,
})

/** Never listed, never read, never searched — whatever the root is set to. */
const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.env', '.ssh', '.aws', '.npmrc'])

/**
 * A rooted filesystem toolset.
 *
 * ```ts
 * import { fileTools } from 'just-another-sdk/tools/fs'
 *
 * new Agent({ name: 'assistant', model, tools: fileTools({ root: './workspace', write: true }) })
 * ```
 *
 * Read-only by default: `read_file`, `list_directory`, `search_files`. With
 * `write: true` you also get `write_file` and `edit_file`.
 */
export function fileTools(options: FileToolsOptions): readonly AnyTool[] {
  if (!options?.root || typeof options.root !== 'string') {
    throw new ConfigurationError('fileTools needs a `root` directory.', {
      hint:
        "Pass the one directory the agent may touch, e.g. { root: './workspace' }. " +
        'There is deliberately no default — an agent rooted at your home directory ' +
        'is one prompt injection away from reading your keys.',
    })
  }

  const config = {
    root: resolve(options.root),
    write: options.write ?? false,
    maxReadBytes: options.maxReadBytes ?? DEFAULTS.maxReadBytes,
    maxWriteBytes: options.maxWriteBytes ?? DEFAULTS.maxWriteBytes,
    maxEntries: options.maxEntries ?? DEFAULTS.maxEntries,
  }

  const tools = [readFile(config), listDirectory(config), searchFiles(config)]
  return config.write ? [...tools, writeFile(config), editFile(config)] : tools
}

type Config = {
  readonly root: string
  readonly write: boolean
  readonly maxReadBytes: number
  readonly maxWriteBytes: number
  readonly maxEntries: number
}

/* ------------------------------------------------------------------------- */
/* Containment                                                               */
/* ------------------------------------------------------------------------- */

/** Thrown when a path would leave the root. Never leaks the absolute path. */
export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(
      `"${requested}" is outside the directory this agent can access. ` +
        'Use a path relative to the root, without "..".',
    )
    this.name = 'PathEscapeError'
  }
}

/**
 * Resolves a model-supplied path to a real, contained absolute path.
 *
 * Three defences, in order, because each catches something the others do not:
 *
 *   1. **Reject `..` outright.** Not strictly needed given step 3, but it gives
 *      the model a message it can act on rather than a mysterious refusal.
 *   2. **Resolve against the root**, so an absolute path cannot simply replace it.
 *   3. **`realpath` the result and re-check** — the symlink defence. A link at
 *      `workspace/notes -> /etc` passes steps 1 and 2 and fails here.
 *
 * `mustExist: false` is for writes, where the file legitimately does not exist
 * yet; the *parent* is resolved instead, which is enough — you cannot create a
 * file inside a directory you could not have written to.
 */
async function containedPath(
  requested: string,
  config: Config,
  mustExist: boolean,
): Promise<string> {
  if (requested.split(/[\\/]/u).includes('..')) throw new PathEscapeError(requested)

  const candidate = resolve(config.root, requested)
  if (!isInside(candidate, config.root)) throw new PathEscapeError(requested)

  if (ALWAYS_SKIP.has(basenameOf(candidate))) {
    throw new PathEscapeError(requested)
  }

  const toResolve = mustExist ? candidate : dirname(candidate)

  let real: string
  try {
    real = await realpath(toResolve)
  } catch (cause) {
    if (mustExist && isNotFound(cause)) {
      throw new Error(`"${requested}" does not exist.`, { cause })
    }
    throw cause
  }

  // The check that actually matters.
  if (!isInside(real, await rootReal(config))) throw new PathEscapeError(requested)

  return candidate
}

/** The root's own real path, so a symlinked root compares correctly. */
const rootRealCache = new Map<string, Promise<string>>()

function rootReal(config: Config): Promise<string> {
  const cached = rootRealCache.get(config.root)
  if (cached) return cached

  const pending = realpath(config.root).catch(() => config.root)
  rootRealCache.set(config.root, pending)
  return pending
}

function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return true
  const rel = relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep) && !isAbsoluteLike(rel)
}

/** `path.isAbsolute` without importing it just for one call on two platforms. */
function isAbsoluteLike(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:/u.test(value)
}

function basenameOf(path: string): string {
  return path.split(/[\\/]/u).pop() ?? ''
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  )
}

/** Shown to the model, so it knows where it is. Never an absolute host path. */
function displayPath(absolute: string, config: Config): string {
  const rel = relative(config.root, absolute)
  return rel === '' ? '.' : rel.split(sep).join('/')
}

/* ------------------------------------------------------------------------- */
/* The tools                                                                 */
/* ------------------------------------------------------------------------- */

function readFile(config: Config): AnyTool {
  return tool({
    name: 'read_file',
    description:
      'Read a text file. Paths are relative to the working directory and cannot leave it.',
    inputSchema: s.object({
      path: s.string({ describe: 'File path relative to the working directory.' }),
      maxBytes: s.integer({
        describe: 'Cap on bytes returned.',
        min: 1,
        max: config.maxReadBytes,
        default: config.maxReadBytes,
      }),
    }),
    execute: async ({ path, maxBytes }) => {
      const absolute = await containedPath(path, config, true)

      const info = await stat(absolute)
      if (info.isDirectory()) {
        throw new Error(`"${path}" is a directory. Use list_directory instead.`)
      }

      const contents = await read(absolute, 'utf8')
      const cap = Math.min(maxBytes, config.maxReadBytes)
      const clipped = contents.slice(0, cap)

      return {
        path: displayPath(absolute, config),
        content: clipped,
        bytes: info.size,
        truncated: clipped.length < contents.length,
      }
    },
  })
}

function writeFile(config: Config): AnyTool {
  return tool({
    name: 'write_file',
    description:
      'Create or overwrite a text file. Paths are relative to the working directory and ' +
      'cannot leave it. Missing parent directories are created.',
    inputSchema: s.object({
      path: s.string({ describe: 'File path relative to the working directory.' }),
      content: s.string({ describe: 'The full contents to write.' }),
    }),
    execute: async ({ path, content }) => {
      const bytes = new TextEncoder().encode(content).byteLength
      if (bytes > config.maxWriteBytes) {
        throw new Error(
          `Refusing to write ${bytes.toLocaleString('en-US')} bytes; the limit is ` +
            `${config.maxWriteBytes.toLocaleString('en-US')}.`,
        )
      }

      const absolute = await containedPath(path, config, false)

      await mkdir(dirname(absolute), { recursive: true })
      await write(absolute, content, 'utf8')

      return { path: displayPath(absolute, config), bytes, written: true }
    },
  })
}

function editFile(config: Config): AnyTool {
  return tool({
    name: 'edit_file',
    description:
      'Replace an exact string in a file. Prefer this over write_file for a small change — ' +
      'it cannot accidentally discard the rest of the file. The old string must appear ' +
      'exactly once unless replaceAll is set.',
    inputSchema: s.object({
      path: s.string({ describe: 'File path relative to the working directory.' }),
      oldString: s.string({ describe: 'The exact text to replace, including whitespace.' }),
      newString: s.string({ describe: 'What to replace it with.' }),
      replaceAll: s.boolean({
        describe: 'Replace every occurrence instead of requiring exactly one.',
        default: false,
      }),
    }),
    execute: async ({ path, oldString, newString, replaceAll }) => {
      const absolute = await containedPath(path, config, true)
      const contents = await read(absolute, 'utf8')

      const occurrences = countOccurrences(contents, oldString)

      if (occurrences === 0) {
        throw new Error(`That exact text does not appear in "${path}". Read the file first.`)
      }
      // Ambiguity is refused rather than resolved: silently editing the first of
      // four matches is how an agent corrupts a file while reporting success.
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `That text appears ${occurrences} times in "${path}". Include more surrounding ` +
            'context to make it unique, or set replaceAll.',
        )
      }

      const updated = replaceAll
        ? contents.split(oldString).join(newString)
        : contents.replace(oldString, newString)

      await write(absolute, updated, 'utf8')

      return { path: displayPath(absolute, config), replacements: replaceAll ? occurrences : 1 }
    },
  })
}

function listDirectory(config: Config): AnyTool {
  return tool({
    name: 'list_directory',
    description:
      'List the files and folders in a directory. Use "." for the working directory itself.',
    inputSchema: s.object({
      path: s.string({
        describe: 'Directory path relative to the working directory.',
        default: '.',
      }),
    }),
    execute: async ({ path }) => {
      const absolute = await containedPath(path, config, true)

      const info = await stat(absolute)
      if (!info.isDirectory()) throw new Error(`"${path}" is a file, not a directory.`)

      const entries = await readdir(absolute, { withFileTypes: true })
      const visible = entries
        .filter((entry) => !ALWAYS_SKIP.has(entry.name))
        .slice(0, config.maxEntries)

      return {
        path: displayPath(absolute, config),
        entries: await Promise.all(
          visible.map(async (entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            ...(entry.isDirectory() ? {} : { bytes: await sizeOf(join(absolute, entry.name)) }),
          })),
        ),
        truncated: entries.length > visible.length,
      }
    },
  })
}

function searchFiles(config: Config): AnyTool {
  return tool({
    name: 'search_files',
    description:
      'Search file contents for a string or regular expression, recursively. Returns ' +
      'matching lines with their file and line number.',
    inputSchema: s.object({
      pattern: s.string({ describe: 'Text or regular expression to search for.' }),
      path: s.string({ describe: 'Directory to search under.', default: '.' }),
      regex: s.boolean({ describe: 'Treat the pattern as a regular expression.', default: false }),
      caseSensitive: s.boolean({ describe: 'Match case exactly.', default: false }),
      maxResults: s.integer({
        describe: 'Stop after this many matching lines.',
        min: 1,
        max: config.maxEntries,
        default: 50,
      }),
    }),
    execute: async ({ pattern, path, regex, caseSensitive, maxResults }) => {
      const absolute = await containedPath(path, config, true)

      let matcher: RegExp
      try {
        matcher = new RegExp(regex ? pattern : escapeRegExp(pattern), caseSensitive ? 'u' : 'iu')
      } catch (cause) {
        throw new Error(
          `"${pattern}" is not a valid regular expression: ${cause instanceof Error ? cause.message : ''}`,
          { cause },
        )
      }

      const matches: { path: string; line: number; text: string }[] = []
      await walk(absolute, config, async (file) => {
        if (matches.length >= maxResults) return false

        const contents = await read(file, 'utf8').catch(() => undefined)
        // Unreadable or binary is skipped rather than fatal: one stray file must
        // not fail a search across a whole tree. A NUL byte is the cheap and
        // conventional binary test.
        if (contents === undefined || contents.includes('\u0000')) return true

        for (const [index, line] of contents.split('\n').entries()) {
          if (matches.length >= maxResults) return false
          if (!matcher.test(line)) continue

          matches.push({
            path: displayPath(file, config),
            line: index + 1,
            text: line.trim().slice(0, 300),
          })
        }
        return true
      })

      return { pattern, matches, count: matches.length, truncated: matches.length >= maxResults }
    },
  })
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Walks the tree, calling `visit` per file until it returns `false`.
 *
 * Skips symlinks entirely rather than following them: a search has no reason to
 * leave the tree, and `withFileTypes` makes not-following free.
 */
async function walk(
  directory: string,
  config: Config,
  visit: (file: string) => Promise<boolean>,
): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    if (ALWAYS_SKIP.has(entry.name) || entry.isSymbolicLink()) continue

    const full = join(directory, entry.name)

    if (entry.isDirectory()) {
      if (!(await walk(full, config, visit))) return false
      continue
    }
    if (entry.isFile() && !(await visit(full))) return false
  }

  return true
}

async function sizeOf(path: string): Promise<number | undefined> {
  return stat(path)
    .then((info) => info.size)
    .catch(() => undefined)
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  return haystack.split(needle).length - 1
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
