// Runs the built plugin bundles end to end: MCP shim over stdio, the daemon it starts,
// a fake Vite-plugin socket, and a listener standing in for the agent's Monitor.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import WebSocket from 'ws'
import { defaultSession, sameProject, type PageState } from '../src/shared/page-protocol.ts'
import { agentLabel, LISTENER_REPLACED_CLOSE_CODE, type Batch, type DaemonToPlugin, type DraftComment } from '../src/shared/protocol.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dib-test-'))
const home = path.join(tmp, 'home')
const project = path.join(tmp, 'project')
fs.mkdirSync(project)
let port = 0
let env: Record<string, string> = {}
const shims: Client[] = []
const sockets: WebSocket[] = []

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo
      server.close(() => resolve(address.port))
    })
  })
}

async function startShim(): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['plugin/dist/mcp.mjs'], env, stderr: 'pipe' })
  const client = new Client({ name: 'bridge-test', version: '0' })
  await client.connect(transport)
  shims.push(client)
  return client
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
  const text = result.content.map((part) => part.text).join('\n')
  assert.ok(!result.isError, `${name} failed: ${text}`)
  return text
}

type Inbox<T> = { items: T[]; next: (match: (item: T) => boolean, timeoutMs?: number) => Promise<T> }

function inbox<T>(socket: WebSocket, parse: (raw: string) => T): Inbox<T> {
  const items: T[] = []
  const waiters: Array<{ match: (item: T) => boolean; resolve: (item: T) => void }> = []
  let seen = 0
  socket.on('message', (data) => {
    const item = parse(data.toString())
    items.push(item)
    for (const waiter of waiters.filter((entry) => entry.match(item))) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(item)
    }
  })
  return {
    items,
    next(match, timeoutMs = 3000) {
      // Look at messages that arrived since the last match first.
      const index = items.findIndex((item, i) => i >= seen && match(item))
      if (index !== -1) {
        seen = index + 1
        return Promise.resolve(items[index]!)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${match.toString()}; got ${JSON.stringify(items).slice(0, 600)}`)),
          timeoutMs
        )
        waiters.push({ match, resolve: (item) => (clearTimeout(timer), (seen = items.length), resolve(item)) })
      })
    },
  }
}

/** The inbox is attached before the handshake: a frame can arrive in the same packet as the 101 response. */
function open<T>(url: string, parse: (raw: string) => T, origin?: string): Promise<{ socket: WebSocket; inbox: Inbox<T> }> {
  const socket = new WebSocket(url, origin ? { origin } : {})
  sockets.push(socket)
  const box = inbox(socket, parse)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, inbox: box }))
    socket.once('error', reject)
    socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
  })
}

const openDevServer = () =>
  open<DaemonToPlugin>(`ws://127.0.0.1:${port}/page?token=${fs.readFileSync(path.join(home, 'token'), 'utf8').trim()}`, (raw) =>
    JSON.parse(raw)
  )

const openListener = (url: string) => open<string>(url, (raw) => raw)

function comment(text: string, selector = 'main > h1'): DraftComment {
  return {
    id: crypto.randomUUID(),
    text,
    page: { url: 'http://localhost:5173/pricing', title: 'Pricing', viewport: { width: 1280, height: 800 } },
    element: {
      selector,
      tag: 'h1',
      id: null,
      classes: ['title'],
      text: 'Simple pricing',
      html: '<h1 class="title">Simple pricing</h1>',
      rect: { x: 0, y: 0, width: 400, height: 40 },
      styles: { 'font-size': '32px' },
      ancestors: ['main'],
      sources: ['src/Pricing.tsx:12:7'],
    },
    inReplyTo: null,
    createdAt: new Date().toISOString(),
  }
}

const listenUrlFrom = (text: string) => {
  const match = /ws:\/\/\S+\/listen\/\S+/.exec(text)
  assert.ok(match, `no listen url in: ${text}`)
  return match[0].replace(/,$/, '')
}

before(async () => {
  port = await freePort()
  env = { ...(process.env as Record<string, string>), DIB_PORT: String(port), DIB_HOME: home }
})

after(async () => {
  for (const socket of sockets) socket.terminate()
  for (const client of shims) await client.close().catch(() => {})
  const token = fs.existsSync(path.join(home, 'token')) ? fs.readFileSync(path.join(home, 'token'), 'utf8').trim() : ''
  await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {})
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('the shim stays inert until live_connect', async () => {
  const client = await startShim()
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['live_connect', 'live_get_batch', 'live_reply', 'live_status'])
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`))
})

test('a full round trip: send, doorbell, fetch, reply', async () => {
  const client = shims[0]!
  const connected = await callTool(client, 'live_connect', { projectRoot: project, origins: ['http://localhost:5173/'] })
  const listenUrl = listenUrlFrom(connected)

  const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { name: string }
  assert.equal(health.name, 'design-in-browser')

  const devServer = await openDevServer()
  devServer.socket.send(JSON.stringify({ type: 'hello' }))
  const state = await devServer.inbox.next((m) => m.type === 'state')
  assert.equal(state.type === 'state' && state.sessions.length, 1)
  const session = state.type === 'state' ? state.sessions[0]! : assert.fail()
  assert.deepEqual(session.origins, ['http://localhost:5173'])
  // The test client's MCP name ("bridge-test") is no agent we know.
  assert.equal(session.agent, 'Agent')
  assert.equal(session.listening, false)

  const listener = await openListener(listenUrl)
  const listening = await devServer.inbox.next((m) => m.type === 'sessions' && m.sessions[0]?.listening === true)
  assert.ok(listening)

  const first = comment('Make the title bigger')
  const second = comment('Use the brand color here', 'main > p')
  devServer.socket.send(JSON.stringify({ type: 'send-batch', clientBatchId: 'c1', sessionId: session.id, comments: [first, second] }))
  const accepted = await devServer.inbox.next((m) => m.type === 'batch-accepted')
  assert.equal(accepted.type === 'batch-accepted' && accepted.batch.id, '001')

  const doorbell = await listener.inbox.next(() => true)
  assert.equal(doorbell, 'design-in-browser: batch 001 ready, 2 comments. Call live_get_batch.')

  const journal = path.join(project, '.design-in-browser')
  assert.equal(fs.readFileSync(path.join(journal, '.gitignore'), 'utf8'), '*\n')
  assert.ok(fs.existsSync(path.join(journal, 'batches', '001.json')))

  const fetched = JSON.parse(await callTool(client, 'live_get_batch')) as Batch
  assert.equal(fetched.status, 'fetched')
  assert.deepEqual(
    fetched.comments.map((c) => c.text),
    ['Make the title bigger', 'Use the brand color here']
  )
  await devServer.inbox.next((m) => m.type === 'batch-updated' && m.batch.status === 'fetched')
  assert.equal(await callTool(client, 'live_get_batch'), 'No unfetched batch.')

  const partly = await callTool(client, 'live_reply', {
    batchId: '001',
    replies: [{ commentId: first.id, status: 'done', message: 'Title is now 40px.' }],
  })
  assert.match(partly, /Batch 001 is fetched\. 1 comment\(s\) still pending/)

  await callTool(client, 'live_reply', {
    batchId: '001',
    replies: [{ commentId: second.id, status: 'question', message: 'Accent or primary?' }],
    summary: 'One change, one question.',
  })
  const done = await devServer.inbox.next((m) => m.type === 'batch-updated' && m.batch.status === 'done')
  assert.ok(done.type === 'batch-updated')
  assert.deepEqual(
    done.batch.comments.map((c) => [c.status, c.reply]),
    [
      ['done', 'Title is now 40px.'],
      ['question', 'Accent or primary?'],
    ]
  )
  assert.equal(done.batch.summary, 'One change, one question.')

  const events = fs
    .readFileSync(path.join(journal, 'journal.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).type)
  assert.deepEqual(events, ['created', 'fetched', 'replied', 'replied'])

  listener.socket.close()
  devServer.socket.close()
})

test('a batch rings when a listener connects, and again on re-arm until it is fetched', async () => {
  const client = shims[0]!
  const listenUrl = listenUrlFrom(await callTool(client, 'live_connect', { projectRoot: project }))
  const devServer = await openDevServer()
  devServer.socket.send(JSON.stringify({ type: 'hello' }))
  const state = await devServer.inbox.next((m) => m.type === 'state')
  const sessionId = state.type === 'state' ? state.sessions[0]!.id : assert.fail()

  devServer.socket.send(JSON.stringify({ type: 'send-batch', clientBatchId: 'c2', sessionId, comments: [comment('Tighter spacing')] }))
  await devServer.inbox.next((m) => m.type === 'batch-accepted')

  const firstListener = await openListener(listenUrl)
  assert.equal(await firstListener.inbox.next(() => true), 'design-in-browser: batch 002 ready, 1 comment. Call live_get_batch.')

  // A re-arm replaces the old Monitor and rings again, since Claude has not fetched 002.
  const closed = new Promise<number>((resolve) => firstListener.socket.once('close', (code) => resolve(code)))
  const secondListener = await openListener(listenUrl)
  assert.equal(await closed, LISTENER_REPLACED_CLOSE_CODE)
  assert.equal(await secondListener.inbox.next(() => true), 'design-in-browser: batch 002 ready, 1 comment. Call live_get_batch.')

  const status = JSON.parse(await callTool(client, 'live_status')) as { listening: boolean; unfetched: string[] }
  assert.equal(status.listening, true)
  assert.deepEqual(status.unfetched, ['002'])

  // Once fetched, a re-arm stays quiet.
  assert.equal((JSON.parse(await callTool(client, 'live_get_batch')) as Batch).id, '002')
  const thirdListener = await openListener(listenUrl)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(thirdListener.inbox.items, [])
  devServer.socket.close()
})

test('a new session on the same project takes over open batches', async () => {
  await shims[0]!.close()
  const devServer = await openDevServer()
  devServer.socket.send(JSON.stringify({ type: 'hello' }))
  await devServer.inbox.next((m) => m.type === 'state' && m.sessions.length === 0)

  const client = await startShim()
  await callTool(client, 'live_connect', { projectRoot: project })
  const status = JSON.parse(await callTool(client, 'live_status')) as { open: unknown[] }
  assert.deepEqual(status.open, [{ id: '002', status: 'fetched', pending: 1 }])
  const batch = JSON.parse(await callTool(client, 'live_get_batch', { batchId: '002' })) as Batch
  assert.equal(batch.comments[0]!.text, 'Tighter spacing')
  devServer.socket.close()
})

test('the daemon refuses wrong tokens and foreign hosts', async () => {
  await assert.rejects(open(`ws://127.0.0.1:${port}/shim?token=wrong`, String), /HTTP 401/)
  await assert.rejects(open(`ws://127.0.0.1:${port}/page?token=wrong`, String), /HTTP 401/)
  const status = await new Promise<number>((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/health', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0))
  })
  assert.equal(status, 403)
})

test('a bad comment is refused without dropping the socket', async () => {
  const devServer = await openDevServer()
  devServer.socket.send(JSON.stringify({ type: 'send-batch', clientBatchId: 'c3', sessionId: 'x', comments: [{ text: '' }] }))
  const error = await devServer.inbox.next((m) => m.type === 'error')
  assert.ok(error.type === 'error' && error.message.startsWith('Bad message'))
  devServer.socket.send(JSON.stringify({ type: 'ping' }))
  await devServer.inbox.next((m) => m.type === 'pong')
  devServer.socket.close()
})

test('an answer is refused by a session whose project never asked the question', async () => {
  const devServer = await openDevServer()
  devServer.socket.send(JSON.stringify({ type: 'hello' }))
  const state = await devServer.inbox.next((m) => m.type === 'state' && m.sessions.length > 0)
  const sessionId = state.type === 'state' ? state.sessions[0]!.id : assert.fail()
  const answer = {
    ...comment('Purple'),
    inReplyTo: { batchId: '999', commentId: 'nope', comment: 'Use the accent', question: 'Which one?' },
  }
  devServer.socket.send(JSON.stringify({ type: 'send-batch', clientBatchId: 'c4', sessionId, comments: [answer] }))
  const error = await devServer.inbox.next((m) => m.type === 'error')
  assert.ok(error.type === 'error' && error.message.startsWith('An answer goes to the project that asked the question'))
  assert.equal(error.type === 'error' && error.clientBatchId, 'c4')
  devServer.socket.close()
})

test('agents are named from their MCP client name', () => {
  assert.equal(agentLabel('claude-code'), 'Claude')
  assert.equal(agentLabel('OpenCode'), 'OpenCode')
  assert.equal(agentLabel('something-else'), 'Agent')
  assert.equal(agentLabel(undefined), 'Agent')
})

test('the dock routes to the session on its project, or to none', () => {
  assert.ok(sameProject('/repo', '/repo'))
  assert.ok(sameProject('/repo', '/repo/apps/web'))
  assert.ok(sameProject('/repo/apps/web/', '/repo'))
  assert.ok(!sameProject('/repo', '/repo-other'))
  const session = (id: string, projectRoot: string, connectedAt: string) => ({
    id,
    label: id,
    agent: 'Claude',
    projectRoot,
    origins: [],
    listening: true,
    connectedAt,
  })
  const state: PageState = {
    connection: 'connected',
    projectRoot: '/repo/apps/web',
    sessions: [session('old', '/repo', '2026-01-01'), session('new', '/repo', '2026-01-02'), session('other', '/elsewhere', '2026-01-03')],
    batches: [],
    draft: [],
    sending: false,
    lastError: null,
    pickedSessionId: null,
    sendOnAdd: false,
    variantChoices: {},
    tweakValues: {},
  }
  assert.equal(defaultSession(state)?.id, 'new')
  assert.equal(defaultSession({ ...state, pickedSessionId: 'other' })?.id, 'other')
  assert.equal(defaultSession({ ...state, sessions: [state.sessions[2]!] }), null)
})

test('a stale choice or tweak from older source falls back to what the page has now', async () => {
  const { bridge, shownIndex, valuesFor } = await import('../src/shared/variants-bridge.ts')
  const shared = bridge()
  // Saved before the agent removed a version: index 2 of a group that now has two versions.
  shared.choices.hero = 2
  assert.equal(shownIndex('hero', 2), 1)
  assert.equal(shownIndex('hero', 3), 2)
  assert.equal(shownIndex('solo', 1), 0)
  // A saved value of the wrong kind, and one for a tweak that is gone, give way to the defaults.
  shared.values['hero#1'] = { padding: 'wide', gone: true, badge: false }
  const specs = {
    padding: { kind: 'range', label: 'Padding', min: 0, max: 96, step: 8, default: 48 },
    badge: { kind: 'toggle', label: 'Badge', default: true },
  } as const
  assert.deepEqual(valuesFor('hero', 1, specs), { padding: 48, badge: false })
})

test('the MCP server leaves when its agent closes stdio, so no ghost session stays', async () => {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['plugin/dist/mcp.mjs'], { stdio: ['pipe', 'pipe', 'ignore'], env })
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + '\n')
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  })
  await new Promise((resolve) => setTimeout(resolve, 200))
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'live_connect', arguments: { projectRoot: project } } })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  child.stdin.end()
  const code = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 3000))])
  assert.equal(code, 0)
})
