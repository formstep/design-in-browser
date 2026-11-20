// Runs the built plugin bundles end to end: MCP shim over stdio, the daemon it starts,
// a fake Vite-plugin socket, and a listener standing in for the agent's Monitor.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { defaultSession, sameProject, type PageState } from '../src/shared/page-protocol.ts'
import { agentLabel, LISTENER_REPLACED_CLOSE_CODE, type Batch } from '../src/shared/protocol.ts'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  callTool,
  comment,
  env,
  listenUrlFrom,
  open,
  openDevServer,
  openListener,
  port,
  project,
  startShim,
  tmp,
  useBridge,
} from './bridge-harness.ts'

useBridge()

/** The MCP server the first tests share, as one agent session. */
let firstAgent: Client

test('the shim stays inert until live_connect', async () => {
  const client = await startShim()
  firstAgent = client
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    'live_connect',
    'live_get_batch',
    'live_note',
    'live_reply',
    'live_status',
    'live_wait',
  ])
  await assert.rejects(fetch(`http://127.0.0.1:${port}/health`))
})

test('a full round trip: send, doorbell, fetch, reply', async () => {
  const client = firstAgent
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
  const client = firstAgent
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
  await firstAgent.close()
  const devServer = await openDevServer()
  devServer.socket.send(JSON.stringify({ type: 'hello' }))
  await devServer.inbox.next((m) => m.type === 'state' && m.sessions.length === 0)

  const client = await startShim()
  await callTool(client, 'live_connect', { projectRoot: project })
  const status = JSON.parse(await callTool(client, 'live_status')) as { open: unknown[] }
  // Fetched by the old session but never finished: queued again, so the new session gets it without its id.
  assert.deepEqual(status.open, [{ id: '002', status: 'queued', pending: 1 }])
  const batch = JSON.parse(await callTool(client, 'live_get_batch')) as Batch
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
    build: 'dev',
    connection: 'connected',
    projectRoot: '/repo/apps/web',
    sessions: [session('old', '/repo', '2026-01-01'), session('new', '/repo', '2026-01-02'), session('other', '/elsewhere', '2026-01-03')],
    batches: [],
    sending: false,
    lastError: null,
    pickedSessionId: null,
    variantChoices: {},
    tweakValues: {},
    dismissed: [],
    cleared: null,
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

test('the agent leaves notes on a page: they never ring, and a question among them takes an answer', async () => {
  const notesProject = path.join(tmp, 'notes')
  fs.mkdirSync(notesProject)
  const client = await startShim('claude-code')
  const listener = await openListener(listenUrlFrom(await callTool(client, 'live_connect', { projectRoot: notesProject })))
  const devServer = await openDevServer()
  devServer.socket.send(JSON.stringify({ type: 'hello' }))
  const state = await devServer.inbox.next((m) => m.type === 'state')
  const session = state.type === 'state' ? state.sessions.find((entry) => entry.projectRoot === notesProject) : undefined
  assert.ok(session)

  await callTool(client, 'live_note', {
    url: 'http://localhost:5173/pricing',
    notes: [
      { selector: 'main > h1', note: 'The headline is 40px now.' },
      { source: 'src/Pricing.tsx:12:7', note: 'Keep the subtitle?', question: true },
      // Agents often know both; the source is tried first, the selector after.
      { source: 'src/Pricing.tsx:3:5', selector: 'main', note: 'Both ways to find it.' },
    ],
  })
  const updated = await devServer.inbox.next((m) => m.type === 'batch-updated' && m.batch.projectRoot === notesProject)
  const notes = updated.type === 'batch-updated' ? updated.batch : assert.fail()
  assert.equal(notes.from, 'agent')
  assert.equal(notes.status, 'done')
  assert.deepEqual(
    notes.comments.map((note) => [note.status, note.reply, note.anchor, note.text]),
    [
      ['note', 'The headline is 40px now.', { selector: 'main > h1' }, ''],
      ['question', 'Keep the subtitle?', { source: 'src/Pricing.tsx:12:7' }, ''],
      ['note', 'Both ways to find it.', { source: 'src/Pricing.tsx:3:5', selector: 'main' }, ''],
    ]
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(listener.inbox.items.length, 0, 'notes must not ring the doorbell')
  assert.equal(await callTool(client, 'live_get_batch'), 'No unfetched batch.')

  // The user answers the question; the answer reaches the agent pointing at the note.
  const question = notes.comments[1]!
  const answer = {
    ...comment('Yes, keep it'),
    inReplyTo: { batchId: notes.id, commentId: question.id, comment: '', question: 'Keep the subtitle?' },
  }
  devServer.socket.send(JSON.stringify({ type: 'send-batch', clientBatchId: 'n1', sessionId: session.id, comments: [answer] }))
  await devServer.inbox.next((m) => m.type === 'batch-accepted' && m.clientBatchId === 'n1')
  const fetched = JSON.parse(await callTool(client, 'live_get_batch')) as Batch
  assert.equal(fetched.from, 'user')
  assert.equal(fetched.comments[0]!.inReplyTo?.commentId, question.id)
  devServer.socket.close()
  listener.socket.close()
  await client.close()
})

test('a drawing comment keeps its marks, and its screenshot reaches the agent as an image', async () => {
  const drawProject = path.join(tmp, 'drawing')
  fs.mkdirSync(drawProject)
  const client = await startShim('claude-code')
  await callTool(client, 'live_connect', { projectRoot: drawProject })
  const devServer = await openDevServer()
  devServer.socket.send(JSON.stringify({ type: 'hello' }))
  const state = await devServer.inbox.next((m) => m.type === 'state')
  const session = state.type === 'state' ? state.sessions.find((entry) => entry.projectRoot === drawProject) : undefined
  assert.ok(session)

  const jpeg = Buffer.from('not really a jpeg').toString('base64')
  const drawn = {
    ...comment('Too much space between these'),
    marks: [
      { kind: 'box', x: 10, y: 20, width: 200, height: 80 },
      { kind: 'arrow', from: { x: 5, y: 5 }, to: { x: 40, y: 30 } },
    ],
    screenshot: `data:image/jpeg;base64,${jpeg}`,
  }
  devServer.socket.send(JSON.stringify({ type: 'send-batch', clientBatchId: 'd1', sessionId: session.id, comments: [drawn] }))
  const accepted = await devServer.inbox.next((m) => m.type === 'batch-accepted' && m.clientBatchId === 'd1')
  const sent = accepted.type === 'batch-accepted' ? accepted.batch.comments[0]! : assert.fail()
  // The batch carries a file path, not the image: batches stay small to send and to rewrite.
  assert.equal(sent.screenshotFile, `screenshots/${drawn.id}.jpg`)
  assert.equal('screenshot' in sent, false)
  assert.equal(fs.readFileSync(path.join(drawProject, '.design-in-browser', sent.screenshotFile!), 'utf8'), 'not really a jpeg')

  const result = (await client.callTool({ name: 'live_get_batch', arguments: {} })) as {
    content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  }
  const batch = JSON.parse(result.content[0]!.text!) as Batch
  assert.deepEqual(batch.comments[0]!.marks, drawn.marks)
  const image = result.content.find((part) => part.type === 'image')
  assert.equal(image?.mimeType, 'image/jpeg')
  assert.equal(image?.data, jpeg)
  devServer.socket.close()
  await client.close()
})

test('the OpenCode plugin adds the server and command, and wakes the session on each doorbell', async () => {
  type Registration = { dispose: () => Promise<void> }
  type AfterCall = { tool: string; sessionID: string; status: 'completed'; result: { content: string } }
  type Setup = (ctx: unknown) => Promise<() => Promise<void>>
  const modulePath: string = '../dist/opencode.mjs'
  const { default: plugin } = (await import(modulePath)) as { default: { id: string; setup: Setup } }
  // OpenCode's V2 plugin API: setup(ctx).
  const registration: Registration = { dispose: async () => {} }
  const servers = new Map<string, { type: string; command: string[] }>()
  const commands = new Map<string, { execute: (input: { sessionID: string }) => Promise<void> }>()
  const prompts: Array<{ sessionID: string; text: string }> = []
  let afterTool: (call: AfterCall) => void = () => {}
  // The parts of OpenCode's plugin context the plugin uses.
  const ctx = {
    mcp: {
      transform: async (edit: (editor: unknown) => void) => (
        edit({ set: (name: string, config: { type: string; command: string[] }) => servers.set(name, config) }),
        registration
      ),
    },
    command: {
      transform: async (edit: (editor: unknown) => void) => (
        edit({
          add: (definition: { name: string; execute: (input: { sessionID: string }) => Promise<void> }) =>
            commands.set(definition.name, definition),
        }),
        registration
      ),
    },
    tool: { hook: async (_name: string, callback: (call: AfterCall) => void) => ((afterTool = callback), registration) },
    session: { prompt: async (input: { sessionID: string; text: string }) => void prompts.push(input) },
  }
  const cleanup = await plugin.setup(ctx)
  assert.equal(plugin.id, 'design-in-browser')
  assert.equal(servers.get('design-in-browser')?.command[0], 'node')
  assert.ok(fs.existsSync(servers.get('design-in-browser')!.command[1]!), 'the server path points at the bundled MCP server')

  // The command hands the session the listening instructions.
  await commands.get('design-in-browser')!.execute({ sessionID: 'ses_1' })
  assert.match(prompts[0]!.text, /^Listen for comments/)

  // When the agent connects, the plugin listens on its doorbell like a Monitor, and each doorbell becomes a message.
  const ocProject = path.join(tmp, 'opencode')
  fs.mkdirSync(ocProject)
  const client = await startShim('opencode')
  const connected = await callTool(client, 'live_connect', { projectRoot: ocProject })
  const devServer = await openDevServer()
  devServer.socket.send(JSON.stringify({ type: 'hello' }))
  afterTool({ tool: 'design-in-browser_live_connect', sessionID: 'ses_1', status: 'completed', result: { content: connected } })
  const listening = await devServer.inbox.next(
    (m) => m.type === 'sessions' && m.sessions.some((entry) => entry.projectRoot === ocProject && entry.listening)
  )
  const session = listening.type === 'sessions' ? listening.sessions.find((entry) => entry.projectRoot === ocProject)! : assert.fail()
  devServer.socket.send(
    JSON.stringify({ type: 'send-batch', clientBatchId: 'o1', sessionId: session.id, comments: [comment('Wake OpenCode')] })
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.deepEqual(prompts.at(-1), { sessionID: 'ses_1', text: 'design-in-browser: batch 001 ready, 1 comment. Call live_get_batch.' })

  await cleanup()
  devServer.socket.close()
  await client.close()
})

test('the OpenCode plugin works on OpenCode 1.x too: config, and a doorbell into the session', async () => {
  type Hooks = {
    config: (config: Record<string, Record<string, unknown> | undefined>) => Promise<void>
    'tool.execute.after': (
      input: { tool: string; sessionID: string; callID: string; args: unknown },
      output: { title: string; output: string; metadata: unknown }
    ) => Promise<void>
    dispose: () => Promise<void>
  }
  const modulePath: string = '../dist/opencode.mjs'
  const { default: plugin } = (await import(modulePath)) as { default: { server: (input: unknown) => Promise<Hooks> } }
  const prompts: unknown[] = []
  // OpenCode's V1 plugin API: server({ client, ... }) returns hooks.
  const hooks = await plugin.server({ client: { session: { prompt: async (input: unknown) => void prompts.push(input) } } })
  const config: Record<string, Record<string, unknown> | undefined> = { mcp: { other: { type: 'remote', url: 'https://x' } } }
  await hooks.config(config)
  assert.deepEqual(Object.keys(config.mcp!), ['other', 'design-in-browser'])
  assert.match((config.command!['design-in-browser'] as { template: string }).template, /^Listen for comments/)

  const v1Project = path.join(tmp, 'opencode-v1')
  fs.mkdirSync(v1Project)
  const client = await startShim('opencode')
  const connected = await callTool(client, 'live_connect', { projectRoot: v1Project })
  const devServer = await openDevServer()
  devServer.socket.send(JSON.stringify({ type: 'hello' }))
  await hooks['tool.execute.after'](
    { tool: 'design-in-browser_live_connect', sessionID: 'ses_v1', callID: 'c', args: {} },
    { title: '', output: connected, metadata: {} }
  )
  const listening = await devServer.inbox.next(
    (m) => m.type === 'sessions' && m.sessions.some((entry) => entry.projectRoot === v1Project && entry.listening)
  )
  const session = listening.type === 'sessions' ? listening.sessions.find((entry) => entry.projectRoot === v1Project)! : assert.fail()
  devServer.socket.send(
    JSON.stringify({ type: 'send-batch', clientBatchId: 'v1', sessionId: session.id, comments: [comment('Wake OpenCode 1')] })
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.deepEqual(prompts.at(-1), {
    path: { id: 'ses_v1' },
    body: { parts: [{ type: 'text', text: 'design-in-browser: batch 001 ready, 1 comment. Call live_get_batch.' }] },
  })
  await hooks.dispose()
  devServer.socket.close()
  await client.close()
})

test('an agent without a Monitor waits with live_wait, and reads as listening meanwhile', async () => {
  const waitProject = path.join(tmp, 'waiting')
  fs.mkdirSync(waitProject)
  const client = await startShim('opencode')
  await callTool(client, 'live_connect', { projectRoot: waitProject })
  const devServer = await openDevServer()
  devServer.socket.send(JSON.stringify({ type: 'hello' }))
  const state = await devServer.inbox.next((m) => m.type === 'state')
  const session = state.type === 'state' ? state.sessions.find((entry) => entry.projectRoot === waitProject) : undefined
  assert.ok(session)
  assert.equal(session.agent, 'OpenCode')

  const waiting = callTool(client, 'live_wait', { timeoutSeconds: 20 })
  await devServer.inbox.next((m) => m.type === 'sessions' && m.sessions.some((entry) => entry.id === session.id && entry.listening))
  devServer.socket.send(
    JSON.stringify({ type: 'send-batch', clientBatchId: 'w1', sessionId: session.id, comments: [comment('Wait for me')] })
  )
  const batch = JSON.parse(await waiting) as Batch
  assert.equal(batch.status, 'fetched')
  assert.equal(batch.comments[0]!.text, 'Wait for me')
  assert.match(await callTool(client, 'live_wait', { timeoutSeconds: 5 }), /No batch yet/)
  devServer.socket.close()
  await client.close()
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
