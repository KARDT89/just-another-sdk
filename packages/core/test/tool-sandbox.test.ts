import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { validate } from '../src/schema/standard-schema.js'
import { httpFetch, readUrl } from '../src/tools/builtin/http.js'
import { fileTools } from '../src/tools/builtin/fs.js'
import type { AnyTool, ToolContext } from '../src/tools/tool.js'

/**
 * The escape suite.
 *
 * Every other test in this repository asks "does the happy path work". This one
 * asks "does the dangerous path *fail*", which is the only question that matters
 * for a tool pack a language model drives. A test that merely proves
 * `read_file('notes.txt')` works tells you nothing about whether
 * `read_file('../../.ssh/id_rsa')` also works.
 *
 * Two boundaries, exhaustively:
 *
 *   • **the filesystem root** — `..`, absolute paths, and a planted symlink;
 *   • **the URL allowlist** — loopback, private ranges, cloud metadata, and a
 *     redirect from an allowed host to a blocked one.
 */

const context: ToolContext = {
  runId: 'run_test',
  toolCallId: 'call_1',
  agentName: 'test',
  turn: 1,
  signal: new AbortController().signal,
}

async function run<T = Record<string, unknown>>(t: AnyTool, input: unknown): Promise<T> {
  let value: unknown = input

  if (t.inputSchema) {
    const validated = await validate(t.inputSchema, input)
    if (!validated.ok) {
      throw new Error(`invalid input: ${validated.issues.map((issue) => issue.message).join('; ')}`)
    }
    value = validated.value
  }

  return (await t.execute(value, context)) as T
}

function byName(tools: readonly AnyTool[], name: string): AnyTool {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`no tool named ${name}`)
  return found
}

/* ------------------------------------------------------------------------- */
/* Filesystem containment                                                    */
/* ------------------------------------------------------------------------- */

describe('filesystem sandbox', () => {
  let root: string
  let outside: string
  let tools: readonly AnyTool[]

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'jas-sandbox-'))
    root = join(base, 'workspace')
    outside = join(base, 'secrets')

    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    await mkdir(join(root, 'nested'), { recursive: true })

    await writeFile(join(root, 'notes.txt'), 'hello from inside\nsecond line\n')
    await writeFile(join(root, 'nested', 'deep.txt'), 'nested content with NEEDLE in it\n')
    await writeFile(join(outside, 'id_rsa'), 'PRIVATE KEY MATERIAL')

    // The defence that normalising `..` alone would miss entirely.
    await symlink(outside, join(root, 'escape-hatch'), 'dir').catch(() => {})

    tools = fileTools({ root, write: true })
  })

  afterAll(async () => {
    await rm(join(root, '..'), { recursive: true, force: true })
  })

  it('reads a file inside the root', async () => {
    const result = await run<{ content: string }>(byName(tools, 'read_file'), {
      path: 'notes.txt',
    })
    expect(result.content).toContain('hello from inside')
  })

  it.each([
    ['a parent traversal', '../secrets/id_rsa'],
    ['a deep traversal', 'nested/../../secrets/id_rsa'],
    ['a traversal that normalises clean', 'nested/../nested/../../secrets/id_rsa'],
    ['a Windows-style traversal', '..\\secrets\\id_rsa'],
  ])('refuses %s', async (_label, path) => {
    await expect(run(byName(tools, 'read_file'), { path })).rejects.toThrow(
      /outside the directory/iu,
    )
  })

  it('refuses an absolute path outside the root', async () => {
    await expect(
      run(byName(tools, 'read_file'), { path: join(outside, 'id_rsa') }),
    ).rejects.toThrow(/outside the directory/iu)
  })

  it('refuses a symlink pointing out of the root', async () => {
    // THE assertion. This path contains no `..` and normalises to something
    // squarely inside the root; only resolving the real path catches it.
    await expect(run(byName(tools, 'read_file'), { path: 'escape-hatch/id_rsa' })).rejects.toThrow(
      /outside the directory/iu,
    )
  })

  it('refuses to write outside the root', async () => {
    await expect(
      run(byName(tools, 'write_file'), { path: '../secrets/planted.txt', content: 'x' }),
    ).rejects.toThrow(/outside the directory/iu)
  })

  it('refuses to write through a symlink', async () => {
    await expect(
      run(byName(tools, 'write_file'), { path: 'escape-hatch/planted.txt', content: 'x' }),
    ).rejects.toThrow(/outside the directory/iu)
  })

  it('refuses sensitive names even inside the root', async () => {
    await writeFile(join(root, '.env'), 'SECRET=1')
    await expect(run(byName(tools, 'read_file'), { path: '.env' })).rejects.toThrow(
      /outside the directory/iu,
    )
  })

  it('never leaks the absolute host path in an error', async () => {
    const error = await run(byName(tools, 'read_file'), { path: '../secrets/id_rsa' }).catch(
      (e: unknown) => e as Error,
    )
    expect(error.message).not.toContain(outside)
    expect(error.message).not.toContain(root)
  })

  it('is read-only unless write is enabled', () => {
    const readOnly = fileTools({ root })
    expect(readOnly.map((t) => t.name)).toEqual(['read_file', 'list_directory', 'search_files'])

    const writable = fileTools({ root, write: true })
    expect(writable.map((t) => t.name)).toContain('write_file')
    expect(writable.map((t) => t.name)).toContain('edit_file')
  })

  it('requires a root rather than defaulting to one', () => {
    expect(() => fileTools({} as never)).toThrow(/needs a `root` directory/iu)
  })

  it('caps a write instead of accepting it', async () => {
    const small = fileTools({ root, write: true, maxWriteBytes: 10 })
    await expect(
      run(byName(small, 'write_file'), { path: 'big.txt', content: 'x'.repeat(50) }),
    ).rejects.toThrow(/refusing to write/iu)
  })

  it('caps a read instead of returning everything', async () => {
    const result = await run<{ content: string; truncated: boolean }>(byName(tools, 'read_file'), {
      path: 'notes.txt',
      maxBytes: 5,
    })
    expect(result.content).toHaveLength(5)
    expect(result.truncated).toBe(true)
  })

  it('writes and reads back a round trip', async () => {
    await run(byName(tools, 'write_file'), { path: 'nested/new.txt', content: 'written' })
    const result = await run<{ content: string }>(byName(tools, 'read_file'), {
      path: 'nested/new.txt',
    })
    expect(result.content).toBe('written')
  })

  it('lists a directory without the skipped names', async () => {
    const result = await run<{ entries: { name: string }[] }>(byName(tools, 'list_directory'), {
      path: '.',
    })
    const names = result.entries.map((e) => e.name)

    expect(names).toContain('notes.txt')
    expect(names).not.toContain('.env')
  })

  it('searches file contents recursively', async () => {
    const result = await run<{ matches: { path: string; line: number }[] }>(
      byName(tools, 'search_files'),
      { pattern: 'NEEDLE', path: '.', regex: false, caseSensitive: true, maxResults: 10 },
    )

    expect(result.matches[0]?.path).toBe('nested/deep.txt')
    expect(result.matches[0]?.line).toBe(1)
  })

  it('refuses an ambiguous edit rather than picking one', async () => {
    await run(byName(tools, 'write_file'), { path: 'dup.txt', content: 'a\na\na\n' })

    await expect(
      run(byName(tools, 'edit_file'), {
        path: 'dup.txt',
        oldString: 'a',
        newString: 'b',
        replaceAll: false,
      }),
    ).rejects.toThrow(/appears 3 times/iu)
  })

  it('edits every occurrence when told to', async () => {
    await run(byName(tools, 'write_file'), { path: 'all.txt', content: 'a\na\n' })
    await run(byName(tools, 'edit_file'), {
      path: 'all.txt',
      oldString: 'a',
      newString: 'b',
      replaceAll: true,
    })

    const result = await run<{ content: string }>(byName(tools, 'read_file'), { path: 'all.txt' })
    expect(result.content).toBe('b\nb\n')
  })

  it('says so when the text to edit is not there', async () => {
    await expect(
      run(byName(tools, 'edit_file'), {
        path: 'notes.txt',
        oldString: 'not present',
        newString: 'x',
        replaceAll: false,
      }),
    ).rejects.toThrow(/does not appear/iu)
  })
})

/* ------------------------------------------------------------------------- */
/* URL policy                                                                */
/* ------------------------------------------------------------------------- */

/** Records the URLs a tool actually attempted, so a refusal can be proved. */
function recordingFetch(response: () => Response) {
  const attempted: string[] = []
  const impl = vi.fn(async (url: string | URL) => {
    attempted.push(String(url))
    return response()
  }) as unknown as typeof globalThis.fetch
  return { impl, attempted }
}

function ok(body = '{"ok":true}'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('URL policy', () => {
  it('requires an allowlist rather than defaulting to open', () => {
    expect(() => httpFetch({} as never)).toThrow(/needs an `allow` list/iu)
  })

  it('reaches an allowed host', async () => {
    const { impl } = recordingFetch(ok)
    const result = await run<{ status: number }>(
      httpFetch({ allow: ['api.example.com'], fetch: impl }),
      { url: 'https://api.example.com/things' },
    )
    expect(result.status).toBe(200)
  })

  it('refuses a host that is not allowed, without making a request', async () => {
    const { impl, attempted } = recordingFetch(ok)

    await expect(
      run(httpFetch({ allow: ['api.example.com'], fetch: impl }), {
        url: 'https://evil.example.net/',
      }),
    ).rejects.toThrow(/not in the allowed list/iu)

    expect(attempted).toEqual([])
  })

  it.each([
    ['loopback v4', 'http://127.0.0.1/'],
    ['loopback by name', 'http://localhost:8080/'],
    ['loopback v6', 'http://[::1]/'],
    ['unspecified', 'http://0.0.0.0/'],
    ['private 10/8', 'http://10.0.0.1/'],
    ['private 172.16/12', 'http://172.20.5.5/'],
    ['private 192.168/16', 'http://192.168.1.1/'],
    ['AWS metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['GCP metadata by name', 'http://metadata.google.internal/'],
    ['IPv6 unique-local', 'http://[fd00::1]/'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/'],
  ])('refuses %s even when the allowlist says *', async (_label, url) => {
    // The whole point: `allow: ['*']` is a statement of intent about *which*
    // hosts, and it must not be a statement about blast radius.
    const { impl, attempted } = recordingFetch(ok)

    await expect(run(httpFetch({ allow: ['*'], fetch: impl }), { url })).rejects.toThrow()
    expect(attempted, `${url} was actually requested`).toEqual([])
  })

  it('refuses a non-http scheme', async () => {
    const { impl } = recordingFetch(ok)
    await expect(
      run(httpFetch({ allow: ['*'], fetch: impl }), { url: 'file:///etc/passwd' }),
    ).rejects.toThrow(/not allowed; use http or https/iu)
  })

  it('refuses credentials embedded in the URL', async () => {
    const { impl } = recordingFetch(ok)
    await expect(
      run(httpFetch({ allow: ['*'], fetch: impl }), { url: 'https://user:pw@example.com/' }),
    ).rejects.toThrow(/embedded credentials/iu)
  })

  it('matches a wildcard subdomain on a dot boundary only', async () => {
    const { impl } = recordingFetch(ok)
    const fetchTool = httpFetch({ allow: ['*.wikipedia.org'], fetch: impl })

    await expect(run(fetchTool, { url: 'https://en.wikipedia.org/x' })).resolves.toMatchObject({
      status: 200,
    })

    // The classic bypass: a host that merely *ends with* the allowed string.
    await expect(run(fetchTool, { url: 'https://notwikipedia.org/x' })).rejects.toThrow(
      /not in the allowed list/iu,
    )
  })

  it('re-checks every redirect hop', async () => {
    // An allowed host that 302s to loopback. Following it would make the
    // allowlist decorative.
    const attempted: string[] = []
    const impl = vi.fn(async (url: string | URL) => {
      attempted.push(String(url))
      if (String(url).includes('api.example.com')) {
        return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } })
      }
      return ok()
    }) as unknown as typeof globalThis.fetch

    await expect(
      run(httpFetch({ allow: ['*'], fetch: impl }), { url: 'https://api.example.com/start' }),
    ).rejects.toThrow(/loopback/iu)

    expect(attempted).toEqual(['https://api.example.com/start'])
  })

  it('bounds a redirect loop', async () => {
    let hop = 0
    const impl = vi.fn(async () => {
      hop += 1
      return new Response(null, {
        status: 302,
        headers: { location: `https://api.example.com/hop-${hop}` },
      })
    }) as unknown as typeof globalThis.fetch

    await expect(
      run(httpFetch({ allow: ['api.example.com'], fetch: impl, maxRedirects: 2 }), {
        url: 'https://api.example.com/start',
      }),
    ).rejects.toThrow(/too many redirects/iu)
  })

  it('refuses a method outside the allowlist', async () => {
    const { impl, attempted } = recordingFetch(ok)

    await expect(
      run(httpFetch({ allow: ['*'], fetch: impl }), {
        url: 'https://api.example.com/',
        method: 'DELETE',
      }),
    ).rejects.toThrow(/DELETE method is not allowed/iu)

    expect(attempted).toEqual([])
  })

  it('caps an oversized response instead of buffering it', async () => {
    const impl = vi.fn(
      async () => new Response('x'.repeat(50_000), { status: 200 }),
    ) as unknown as typeof globalThis.fetch

    const result = await run<{ body: string; truncated: boolean }>(
      httpFetch({ allow: ['*'], fetch: impl, maxBytes: 100 }),
      { url: 'https://api.example.com/big' },
    )

    expect(result.body.length).toBeLessThanOrEqual(100)
    expect(result.truncated).toBe(true)
  })

  it('read_url strips markup down to prose', async () => {
    const html = `
      <html><head><title>A &amp; B</title></head>
      <body>
        <script>alert('should not appear')</script>
        <style>.x { color: red }</style>
        <h1>Heading</h1>
        <p>First paragraph.</p>
        <p>Second&nbsp;paragraph.</p>
      </body></html>`

    const impl = vi.fn(
      async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }),
    ) as unknown as typeof globalThis.fetch

    const result = await run<{ title: string; text: string }>(
      readUrl({ allow: ['docs.example.com'], fetch: impl }),
      { url: 'https://docs.example.com/page' },
    )

    expect(result.title).toBe('A & B')
    expect(result.text).toContain('First paragraph.')
    expect(result.text).toContain('Second paragraph.')
    expect(result.text).not.toContain('should not appear')
    expect(result.text).not.toContain('color: red')
    expect(result.text).not.toContain('<')
  })

  it('read_url reports an upstream failure rather than returning an error page', async () => {
    const impl = vi.fn(
      async () => new Response('Not found', { status: 404 }),
    ) as unknown as typeof globalThis.fetch

    await expect(
      run(readUrl({ allow: ['*'], fetch: impl }), { url: 'https://docs.example.com/missing' }),
    ).rejects.toThrow(/HTTP 404/u)
  })

  it('an empty allowlist reaches nothing, and says why', async () => {
    const { impl, attempted } = recordingFetch(ok)

    await expect(
      run(httpFetch({ allow: [], fetch: impl }), { url: 'https://api.example.com/' }),
    ).rejects.toThrow(/no hosts are allowed/iu)

    expect(attempted).toEqual([])
  })
})
