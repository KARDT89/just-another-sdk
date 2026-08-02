/**
 * Example 5 — A streaming chat server.
 *
 * A chat backend in one file: token streaming to the client, a persisted session
 * per user, tool calls visible in the stream, and undo.
 *
 *   echo "OPENROUTER_API_KEY=sk-or-..." > examples/.env
 *   pnpm example:server
 *
 * Then, in another terminal:
 *
 *   curl -N "http://localhost:8787/chat?user=ada" -d "My name is Ada."
 *   curl -N "http://localhost:8787/chat?user=ada" -d "What is my name?"
 *   curl -N "http://localhost:8787/events?user=ada" -d "Weather in Paris?"
 *   curl     "http://localhost:8787/history?user=ada"
 *   curl -X POST "http://localhost:8787/undo?user=ada"
 *
 * `-N` disables curl's own buffering, so you see tokens as they arrive.
 *
 * The persistence and the streaming are one line each. Everything else in this
 * file is `node:http` boilerplate that a real framework would give you.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { Agent, isAgentError, messageText, tool } from 'just-another-sdk'
import { openrouter } from 'just-another-sdk/providers'
import { fileSession } from 'just-another-sdk/sessions/file'
import * as z from 'zod'

const MODEL = process.env['OPENROUTER_MODEL'] ?? 'openai/gpt-4o-mini'
const PORT = Number(process.env['PORT'] ?? 8787)

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => {
    await new Promise((resolve) => setTimeout(resolve, 600))
    return { city, tempC: 18, summary: 'clear' }
  },
})

const agent = new Agent({
  name: 'support',
  instructions: 'You are a concise assistant. Use tools when they help.',
  model: openrouter(MODEL),
  tools: [getWeather],

  // ── Persistence: one line ─────────────────────────────────────────────────
  session: fileSession('./.sessions'),
  context: { maxTokens: 8_000, summarize: true },
})

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    const message = isAgentError(error) ? `${error.code}: ${error.message}` : String(error)
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
    response.end(message)
  })
})

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`)
  const user = url.searchParams.get('user') ?? 'anonymous'
  const chat = agent.session(user)

  switch (url.pathname) {
    // ── Plain text tokens. The whole handler is two lines. ──────────────────
    case '/chat': {
      const message = await readBody(request)
      const stream = agent.stream(message || 'Say hello.', { sessionId: user })
      return send(response, stream.toResponse())
    }

    // ── Every event, so a UI can render "calling get_weather…" too. ─────────
    case '/events': {
      const message = await readBody(request)
      const stream = agent.stream(message || 'Say hello.', { sessionId: user })
      return send(response, stream.toEventResponse())
    }

    case '/history': {
      const messages = await chat.messages({ limit: 20 })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(messages, null, 2))
      return
    }

    // ── Undo: drop the reply and the message that caused it. ────────────────
    //
    // `pop()` removes one message, so a plain exchange takes two. A turn that
    // used tools has more — the assistant's tool call and the tool results are
    // messages too — so pop until the user's own message comes back.
    case '/undo': {
      const removed: string[] = []
      for (let i = 0; i < 8; i += 1) {
        const message = await chat.pop()
        if (!message) break
        removed.push(`${message.role}: ${messageText(message).slice(0, 60) || '(tool call)'}`)
        if (message.role === 'user') break
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(
        removed.length > 0 ? `Removed:\n  ${removed.join('\n  ')}\n` : 'Nothing to undo.\n',
      )
      return
    }

    case '/clear': {
      await chat.clear()
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('Forgotten.\n')
      return
    }

    default:
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('Try /chat, /events, /history, /undo, or /clear.\n')
  }
}

/**
 * The only Node-specific line in the file.
 *
 * The SDK produces a web `Response` because that is what Next.js, Hono, Bun,
 * Deno, and Workers all take directly. `node:http` predates it, so its body gets
 * bridged here — once, at the edge.
 */
function send(response: ServerResponse, from: Response): void {
  response.writeHead(from.status, Object.fromEntries(from.headers))
  if (!from.body) {
    response.end()
    return
  }
  Readable.fromWeb(from.body).pipe(response)
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

server.listen(PORT, () => {
  console.log(`\nlistening on http://localhost:${PORT}\n`)
  console.log(`  curl -N "http://localhost:${PORT}/chat?user=ada" -d "My name is Ada."`)
  console.log(`  curl -N "http://localhost:${PORT}/chat?user=ada" -d "What is my name?"`)
  console.log(`  curl -N "http://localhost:${PORT}/events?user=ada" -d "Weather in Paris?"`)
  console.log(`  curl    "http://localhost:${PORT}/history?user=ada"`)
  console.log(`  curl -X POST "http://localhost:${PORT}/undo?user=ada"\n`)
})
