// Sessions restarting, taking over, and the daemon going away: what an agent and a page see when things end
// that they didn't end themselves.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import type { Batch } from '../src/shared/protocol.ts'
import { defaultSession, type PageState } from '../src/shared/page-protocol.ts'
import {
  callTool,
  comment,
  health,
  killDaemon,
  listenUrlFrom,
  openDevServer,
  openListener,
  startShim,
  tmp,
  useBridge,
} from './bridge-harness.ts'

useBridge()

const projectNamed = (name: string) => {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function sessionOn(projectRoot: string) {
  const devServer = await openDevServer()
  devServer.socket.send(JSON.stringify({ type: 'hello', projectRoot }))
  const message = await devServer.inbox.next(
    (m) => (m.type === 'state' || m.type === 'sessions') && m.sessions.some((entry) => entry.projectRoot === projectRoot)
  )
  const session =
    message.type === 'state' || message.type === 'sessions'
      ? message.sessions.findLast((entry) => entry.projectRoot === projectRoot)
      : undefined
  assert.ok(session)
  return { devServer, session }
}

async function until<T>(check: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check().catch(() => null)
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms: ${check.toString()}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

test('a batch the old session fetched but never finished goes to the new session', async () => {
  const projectRoot = projectNamed('fetched')
  const old = await startShim('claude-code')
  await callTool(old, 'live_connect', { projectRoot })
  const { devServer, session } = await sessionOn(projectRoot)
  devServer.socket.send(
    JSON.stringify({ type: 'send-batch', clientBatchId: 'f1', sessionId: session.id, comments: [comment('First'), comment('Second')] })
  )
  await devServer.inbox.next((m) => m.type === 'batch-accepted')
  const fetched = JSON.parse(await callTool(old, 'live_get_batch')) as Batch
  await callTool(old, 'live_reply', {
    batchId: fetched.id,
    replies: [{ commentId: fetched.comments[0]!.id, status: 'done', message: 'Did the first.' }],
  })
  // The session ends mid-batch: Claude Code quit, or the conversation was closed.
  await old.close()

  const next = await startShim('claude-code')
  const listener = await openListener(listenUrlFrom(await callTool(next, 'live_connect', { projectRoot })))
  // The new session is woken for it, and gets it without knowing its id.
  await listener.inbox.next((frame) => frame.includes(`batch ${fetched.id} ready`))
  const handed = JSON.parse(await callTool(next, 'live_get_batch')) as Batch
  assert.equal(handed.id, fetched.id)
  assert.deepEqual(
    handed.comments.map((c) => [c.text, c.status]),
    [
      ['First', 'done'],
      ['Second', 'pending'],
    ]
  )
  devServer.socket.close()
  listener.socket.close()
  await next.close()
})

test('the same comments sent twice make one batch', async () => {
  const projectRoot = projectNamed('twice')
  const agent = await startShim('claude-code')
  await callTool(agent, 'live_connect', { projectRoot })
  const { devServer, session } = await sessionOn(projectRoot)
  const comments = [comment('Only once')]
  devServer.socket.send(JSON.stringify({ type: 'send-batch', clientBatchId: 't1', sessionId: session.id, comments }))
  const first = await devServer.inbox.next((m) => m.type === 'batch-accepted' && m.clientBatchId === 't1')
  // The daemon died before its answer arrived, say, and the page sends the same stack again.
  devServer.socket.send(JSON.stringify({ type: 'send-batch', clientBatchId: 't2', sessionId: session.id, comments }))
  const second = await devServer.inbox.next((m) => m.type === 'batch-accepted' && m.clientBatchId === 't2')
  assert.equal(second.type === 'batch-accepted' && second.batch.id, first.type === 'batch-accepted' && first.batch.id)
  assert.deepEqual(fs.readdirSync(path.join(projectRoot, '.design-in-browser/batches')), ['001.json'])
  devServer.socket.close()
  await agent.close()
})

test('live_wait leaves an armed Monitor alone', async () => {
  const projectRoot = projectNamed('monitor-and-wait')
  const agent = await startShim('claude-code')
  const monitor = await openListener(listenUrlFrom(await callTool(agent, 'live_connect', { projectRoot })))
  const closed = new Promise<number>((resolve) => monitor.socket.once('close', resolve))
  assert.match(await callTool(agent, 'live_wait', { timeoutSeconds: 5 }), /No batch yet/)
  const result = await Promise.race([closed, new Promise<string>((resolve) => setTimeout(() => resolve('still open'), 300))])
  assert.equal(result, 'still open', 'the Monitor was replaced by live_wait')
  monitor.socket.close()
  await agent.close()
})

test('after the daemon crashes, the session comes back and its Monitor re-arms on the same URL', async () => {
  const projectRoot = projectNamed('crash-monitor')
  const agent = await startShim('claude-code')
  const url = listenUrlFrom(await callTool(agent, 'live_connect', { projectRoot }))
  const monitor = await openListener(url)
  const closed = new Promise<void>((resolve) => monitor.socket.once('close', () => resolve()))
  await killDaemon()
  await closed
  // The skill re-arms the same URL; with the MCP server back on its own, that works without a tool call.
  const rearmed = await until(() => openListener(url))
  const { devServer, session } = await sessionOn(projectRoot)
  devServer.socket.send(
    JSON.stringify({ type: 'send-batch', clientBatchId: 'c1', sessionId: session.id, comments: [comment('After the crash')] })
  )
  await rearmed.inbox.next((frame) => frame.includes('ready, 1 comment'))
  devServer.socket.close()
  rearmed.socket.close()
  await agent.close()
})

test('after the daemon crashes, live_wait still returns the next batch', async () => {
  const projectRoot = projectNamed('crash-wait')
  const agent = await startShim('opencode')
  await callTool(agent, 'live_connect', { projectRoot })
  const waiting = callTool(agent, 'live_wait', { timeoutSeconds: 60 })
  await new Promise((resolve) => setTimeout(resolve, 300))
  await killDaemon()
  const { devServer, session } = await until(() => sessionOn(projectRoot))
  devServer.socket.send(
    JSON.stringify({ type: 'send-batch', clientBatchId: 'w1', sessionId: session.id, comments: [comment('Wait through a crash')] })
  )
  const batch = JSON.parse(await waiting) as Batch
  assert.equal(batch.comments[0]!.text, 'Wait through a crash')
  devServer.socket.close()
  await agent.close()
})

test('an older build connects to a newer daemon without replacing it, and a newer build replaces an older one', async () => {
  const projectRoot = projectNamed('two-builds')
  const current = await startShim('claude-code')
  await callTool(current, 'live_connect', { projectRoot })
  const running = await until(() => health())
  // The same bundles with an older version in their build ID, as an outdated plugin copy would be.
  const older = path.join(tmp, 'older-build')
  fs.mkdirSync(older, { recursive: true })
  for (const file of ['mcp.mjs', 'daemon.mjs']) {
    fs.writeFileSync(
      path.join(older, file),
      fs.readFileSync(path.join('plugin/dist', file), 'utf8').replaceAll(running.buildId, '0.0.1-oldbuild00000')
    )
  }
  const outdated = await startShim('claude-code', path.join(older, 'mcp.mjs'))
  await callTool(outdated, 'live_connect', { projectRoot: projectNamed('two-builds-other') })
  await callTool(outdated, 'live_status')
  await callTool(current, 'live_status')
  const after = await health()
  assert.equal(after?.pid, running.pid, 'the older build replaced the newer daemon')
  await outdated.close()
  await current.close()

  // The other way round: an older daemon runs, and the current build's live_connect replaces it.
  process.kill(running.pid, 'SIGTERM')
  await until(async () => (await health()) === null)
  const outdatedFirst = await startShim('claude-code', path.join(older, 'mcp.mjs'))
  await callTool(outdatedFirst, 'live_connect', { projectRoot })
  assert.equal((await until(() => health())).buildId, '0.0.1-oldbuild00000')
  const upToDate = await startShim('claude-code')
  await callTool(upToDate, 'live_connect', { projectRoot })
  assert.equal((await until(() => health())).buildId, running.buildId)
  // The outdated session registers again with the newer daemon, without taking it back.
  await callTool(outdatedFirst, 'live_status')
  assert.equal((await health())?.buildId, running.buildId)
  await outdatedFirst.close()
  await upToDate.close()
})

test('the OpenCode plugin comes back after a daemon crash, and goes quiet when its session ends', async () => {
  type AfterCall = { tool: string; sessionID: string; status: 'completed'; result: { content: string } }
  type Setup = (ctx: unknown) => Promise<() => Promise<void>>
  const modulePath: string = '../dist/opencode.mjs'
  const { default: plugin } = (await import(modulePath)) as { default: { setup: Setup } }
  const registration = { dispose: async () => {} }
  const prompts: Array<{ sessionID: string; text: string }> = []
  let afterTool: (call: AfterCall) => void = () => {}
  const cleanup = await plugin.setup({
    mcp: { transform: async () => registration },
    command: { transform: async () => registration },
    tool: { hook: async (_name: string, callback: (call: AfterCall) => void) => ((afterTool = callback), registration) },
    session: { prompt: async (input: { sessionID: string; text: string }) => void prompts.push(input) },
  })
  const projectRoot = projectNamed('opencode-crash')
  const agent = await startShim('opencode')
  afterTool({
    tool: 'design-in-browser_live_connect',
    sessionID: 'ses_c',
    status: 'completed',
    result: { content: await callTool(agent, 'live_connect', { projectRoot }) },
  })
  await until(async () => (await sessionOn(projectRoot)).session.listening)
  await killDaemon()
  // The MCP server registers again and the plugin's socket returns to the same URL: the session listens again.
  const { devServer, session } = await until(async () => {
    const found = await sessionOn(projectRoot)
    return found.session.listening ? found : (found.devServer.socket.close(), null)
  })
  devServer.socket.send(
    JSON.stringify({ type: 'send-batch', clientBatchId: 'oc1', sessionId: session.id, comments: [comment('After the crash')] })
  )
  await until(async () => prompts.some((entry) => entry.text.includes('ready, 1 comment')))
  // The session ends: its listener closes with "session ended", and the plugin doesn't ask the agent to reconnect.
  await agent.close()
  await new Promise((resolve) => setTimeout(resolve, 2500))
  assert.equal(prompts.filter((entry) => entry.text.includes('lost the connection')).length, 0)
  devServer.socket.close()
  await cleanup()
})

test('with two sessions on one project, the newest takes new comments, answers reach the asker, and a pick follows a restart', async () => {
  const projectRoot = projectNamed('two-sessions')
  const a = await startShim('claude-code')
  await callTool(a, 'live_connect', { projectRoot })
  const { devServer, session: first } = await sessionOn(projectRoot)
  devServer.socket.send(JSON.stringify({ type: 'send-batch', clientBatchId: 's1', sessionId: first.id, comments: [comment('Ask me')] }))
  await devServer.inbox.next((m) => m.type === 'batch-accepted' && m.clientBatchId === 's1')
  const asked = JSON.parse(await callTool(a, 'live_get_batch')) as Batch
  await callTool(a, 'live_reply', {
    batchId: asked.id,
    replies: [{ commentId: asked.comments[0]!.id, status: 'question', message: 'Which color?' }],
  })

  const b = await startShim('opencode')
  await callTool(b, 'live_connect', { projectRoot })
  const both = await devServer.inbox.next(
    (m) => m.type === 'sessions' && m.sessions.filter((entry) => entry.projectRoot === projectRoot).length === 2
  )
  const sessions = both.type === 'sessions' ? both.sessions : []
  const state = { connection: 'connected', projectRoot, sessions, pickedSessionId: null } as unknown as PageState
  const newest = defaultSession(state)
  assert.equal(newest?.agent, 'OpenCode', 'new comments go to the newest session')

  // An answer to A's question, sent to B, the session the page picks now: B gets it and can close A's question.
  const answer = {
    ...comment('Blue'),
    inReplyTo: { batchId: asked.id, commentId: asked.comments[0]!.id, comment: 'Ask me', question: 'Which color?' },
  }
  devServer.socket.send(JSON.stringify({ type: 'send-batch', clientBatchId: 's2', sessionId: newest!.id, comments: [answer] }))
  await devServer.inbox.next((m) => m.type === 'batch-accepted' && m.clientBatchId === 's2')
  const received = JSON.parse(await callTool(b, 'live_get_batch')) as Batch
  assert.equal(received.comments[0]!.inReplyTo?.batchId, asked.id)
  await callTool(b, 'live_reply', {
    batchId: asked.id,
    replies: [{ commentId: asked.comments[0]!.id, status: 'done', message: 'Blue it is.' }],
  })

  // A manual pick of A survives until A restarts; then the page falls back to the newest session.
  const picked = { ...state, pickedSessionId: first.id }
  assert.equal(defaultSession(picked)?.id, first.id)
  await a.close()
  const gone = await devServer.inbox.next((m) => m.type === 'sessions' && !m.sessions.some((entry) => entry.id === first.id))
  assert.equal(defaultSession({ ...picked, sessions: gone.type === 'sessions' ? gone.sessions : [] })?.agent, 'OpenCode')
  devServer.socket.close()
  await b.close()
})
