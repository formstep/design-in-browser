// One daemon per machine. It holds three kinds of sockets:
//   /ext                     the Chrome extension (Origin must be the pinned extension)
//   /shim?token=...          one MCP shim per Claude Code session that ran /live
//   /listen/<session>?key=   Claude's Monitor; each text frame wakes Claude
// Batches live in the project's journal folder; memory only caches them.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import {
  LISTENER_REPLACED_CLOSE_CODE,
  PRODUCT_NAME,
  START_COMMAND,
  type Batch,
  type ConnectParams,
  type ConnectResult,
  type DaemonToExtension,
  type GetBatchParams,
  type Health,
  type ReplyParams,
  type SessionInfo,
  type ShimRequest,
  type ShimResponse,
  type StatusResult,
} from '../shared/protocol.ts'
import { BUILD_ID, config, tokenPath } from './config.ts'
import { appendEvent, ensureJournal, nextBatchId, readBatches, writeBatch } from './journal.ts'
import { draftCommentSchema } from './schemas.ts'

const log = (...parts: unknown[]) => console.error(new Date().toISOString(), ...parts)

type Session = {
  id: string
  projectRoot: string
  agent: string
  origins: string[]
  connectedAt: string
  shim: WebSocket
  listenKey: string
  listener: WebSocket | null
}

const sessions = new Map<string, Session>()
const extensions = new Set<WebSocket>()
/** projectRoot -> batchId -> batch */
const projects = new Map<string, Map<string, Batch>>()
let lastActivity = Date.now()

function readOrCreateToken(): string {
  fs.mkdirSync(config.home, { recursive: true, mode: 0o700 })
  const file = tokenPath()
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  const token = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, token + '\n', { mode: 0o600 })
  return token
}

const token = readOrCreateToken()

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

// --- projects and batches ---------------------------------------------------

function projectBatches(projectRoot: string): Map<string, Batch> {
  const cached = projects.get(projectRoot)
  if (cached) return cached
  const loaded = new Map(readBatches(projectRoot).map((batch) => [batch.id, batch]))
  projects.set(projectRoot, loaded)
  return loaded
}

function saveBatch(batch: Batch, event: Record<string, unknown>): void {
  projectBatches(batch.projectRoot).set(batch.id, batch)
  writeBatch(batch)
  appendEvent(batch.projectRoot, { batch: batch.id, ...event })
  broadcast({ type: 'batch-updated', batch })
}

function recentBatches(): Batch[] {
  const roots = new Set([...sessions.values()].map((session) => session.projectRoot))
  return [...roots]
    .flatMap((root) => [...projectBatches(root).values()])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30)
}

function unfetchedFor(session: Session): Batch[] {
  return [...projectBatches(session.projectRoot).values()].filter(
    (batch) => batch.sessionId === session.id && batch.status === 'queued',
  )
}

function ringDoorbell(session: Session, batch: Batch): void {
  if (session.listener?.readyState !== WebSocket.OPEN) return
  const count = batch.comments.length
  const noun = count === 1 ? 'comment' : 'comments'
  session.listener.send(`${PRODUCT_NAME}: batch ${batch.id} ready, ${count} ${noun}. Call live_get_batch.`)
}

// --- sessions ------------------------------------------------------------------

function sessionInfo(session: Session): SessionInfo {
  return {
    id: session.id,
    label: path.basename(session.projectRoot),
    agent: session.agent,
    projectRoot: session.projectRoot,
    origins: session.origins,
    listening: session.listener !== null,
    connectedAt: session.connectedAt,
  }
}

function broadcast(message: DaemonToExtension): void {
  const data = JSON.stringify(message)
  for (const socket of extensions) socket.send(data)
}

function broadcastSessions(): void {
  broadcast({ type: 'sessions', sessions: [...sessions.values()].map(sessionInfo) })
}

function requireSession(sessionId: string): Session {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`No connected session ${sessionId}. Call live_connect first.`)
  return session
}

function connect(params: ConnectParams, shim: WebSocket): ConnectResult {
  if (!path.isAbsolute(params.projectRoot)) throw new Error(`projectRoot must be absolute: ${params.projectRoot}`)
  if (!fs.statSync(params.projectRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`projectRoot is not a directory: ${params.projectRoot}`)
  }
  const journalDir = ensureJournal(params.projectRoot)
  // A repeated connect updates the session in place: listener close handlers hold on to this object.
  const existing = sessions.get(params.sessionId)
  const session: Session = existing ?? {
    id: params.sessionId,
    projectRoot: params.projectRoot,
    agent: params.agent,
    origins: params.origins,
    connectedAt: new Date().toISOString(),
    shim,
    listenKey: crypto.randomBytes(16).toString('hex'),
    listener: null,
  }
  session.projectRoot = params.projectRoot
  session.agent = params.agent
  session.origins = params.origins
  session.shim = shim
  sessions.set(session.id, session)

  // Open batches whose session is gone move to this one, so nothing sent is lost.
  for (const batch of projectBatches(session.projectRoot).values()) {
    if (batch.status === 'done' || batch.sessionId === session.id || sessions.has(batch.sessionId)) continue
    saveBatch({ ...batch, sessionId: session.id, agent: session.agent }, { type: 'adopted', session: session.id })
  }

  broadcastSessions()
  log('session connected', session.id, session.projectRoot, session.origins.join(','))
  return {
    listenUrl: `ws://127.0.0.1:${config.port}/listen/${session.id}?key=${session.listenKey}`,
    journalDir,
    unfetched: unfetchedFor(session).map((batch) => batch.id),
  }
}

function getBatch(params: GetBatchParams): Batch | null {
  const session = requireSession(params.sessionId)
  const batches = projectBatches(session.projectRoot)
  const batch =
    params.batchId === undefined
      ? unfetchedFor(session)[0]
      : batches.get(params.batchId)
  if (!batch) {
    if (params.batchId !== undefined) throw new Error(`No batch ${params.batchId} in ${session.projectRoot}`)
    return null
  }
  if (batch.status !== 'queued') return batch
  const fetched: Batch = { ...batch, status: 'fetched', sessionId: session.id, agent: session.agent }
  saveBatch(fetched, { type: 'fetched', session: session.id })
  return fetched
}

function reply(params: ReplyParams): Batch {
  const session = requireSession(params.sessionId)
  const batch = projectBatches(session.projectRoot).get(params.batchId)
  if (!batch) throw new Error(`No batch ${params.batchId} in ${session.projectRoot}`)
  const byId = new Map(params.replies.map((entry) => [entry.commentId, entry]))
  const unknown = [...byId.keys()].filter((id) => !batch.comments.some((comment) => comment.id === id))
  if (unknown.length > 0) throw new Error(`Unknown comment ids in batch ${batch.id}: ${unknown.join(', ')}`)
  const comments = batch.comments.map((comment) => {
    const entry = byId.get(comment.id)
    return entry ? { ...comment, status: entry.status, reply: entry.message } : comment
  })
  const allAnswered = comments.every((comment) => comment.status !== 'pending')
  const updated: Batch = {
    ...batch,
    comments,
    summary: params.summary ?? batch.summary,
    status: allAnswered ? 'done' : 'fetched',
  }
  saveBatch(updated, { type: 'replied', session: session.id, comments: [...byId.keys()] })
  return updated
}

function status(sessionId: string): StatusResult {
  const session = requireSession(sessionId)
  const open = [...projectBatches(session.projectRoot).values()].filter(
    (batch) => batch.sessionId === session.id && batch.status !== 'done',
  )
  return {
    sessionId,
    listening: session.listener !== null,
    extensionsConnected: extensions.size,
    unfetched: unfetchedFor(session).map((batch) => batch.id),
    open: open.map((batch) => ({
      id: batch.id,
      status: batch.status,
      pending: batch.comments.filter((comment) => comment.status === 'pending').length,
    })),
  }
}

function handleShimRequest(request: ShimRequest, shim: WebSocket): unknown {
  switch (request.method) {
    case 'connect':
      return connect(request.params, shim)
    case 'getBatch':
      return getBatch(request.params)
    case 'reply':
      return reply(request.params)
    case 'status':
      return status(request.params.sessionId)
  }
}

// --- extension messages -----------------------------------------------------

const extensionMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), extensionVersion: z.string() }),
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('send-batch'),
    clientBatchId: z.string().max(100),
    sessionId: z.string().max(100),
    comments: z.array(draftCommentSchema).min(1).max(50),
  }),
])

function handleExtensionMessage(socket: WebSocket, raw: string): void {
  const parsed = extensionMessageSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    send(socket, { type: 'error', message: `Bad message: ${parsed.error.message}` })
    return
  }
  const message = parsed.data
  switch (message.type) {
    case 'hello':
      send(socket, { type: 'state', sessions: [...sessions.values()].map(sessionInfo), batches: recentBatches() })
      return
    case 'ping':
      send(socket, { type: 'pong' })
      return
    case 'send-batch': {
      const session = sessions.get(message.sessionId)
      if (!session) {
        send(socket, {
          type: 'error',
          message: `That agent session has ended. Connect a session again (in Claude Code: ${START_COMMAND}), then send.`,
          clientBatchId: message.clientBatchId,
        })
        return
      }
      // An answer must reach the project whose batch asked the question.
      const known = projectBatches(session.projectRoot)
      const misrouted = message.comments.some(
        ({ inReplyTo }) => inReplyTo && !known.get(inReplyTo.batchId)?.comments.some((original) => original.id === inReplyTo.commentId),
      )
      if (misrouted) {
        send(socket, {
          type: 'error',
          message: `An answer goes to the project that asked the question, not ${path.basename(session.projectRoot)}. Pick that project's session and send again.`,
          clientBatchId: message.clientBatchId,
        })
        return
      }
      ensureJournal(session.projectRoot)
      const batch: Batch = {
        id: nextBatchId(session.projectRoot),
        projectRoot: session.projectRoot,
        agent: session.agent,
        sessionId: session.id,
        createdAt: new Date().toISOString(),
        status: 'queued',
        summary: null,
        comments: message.comments.map((comment) => ({ ...comment, status: 'pending', reply: null })),
      }
      saveBatch(batch, { type: 'created', session: session.id, comments: batch.comments.length })
      send(socket, { type: 'batch-accepted', clientBatchId: message.clientBatchId, batch })
      ringDoorbell(session, batch)
      return
    }
  }
}

function send(socket: WebSocket, message: DaemonToExtension): void {
  socket.send(JSON.stringify(message))
}

// --- http + upgrade -----------------------------------------------------------

const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`])
const allowedOrigins = new Set(config.allowedExtensionIds.map((id) => `chrome-extension://${id}`))

const server = http.createServer((req, res) => {
  if (!allowedHosts.has(req.headers.host ?? '')) {
    res.writeHead(403).end()
    return
  }
  if (req.method === 'GET' && req.url === '/health') {
    const health: Health = { name: PRODUCT_NAME, buildId: BUILD_ID, pid: process.pid }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(health))
    return
  }
  if (req.method === 'POST' && req.url === '/shutdown') {
    if (!sameSecret(req.headers.authorization ?? '', `Bearer ${token}`)) {
      res.writeHead(401).end()
      return
    }
    res.writeHead(204).end()
    shutdown('asked to stop')
    return
  }
  res.writeHead(404).end()
})

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const reject = (code: number) => {
    socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n\r\n`)
  }
  if (!allowedHosts.has(req.headers.host ?? '')) return reject(403)

  if (url.pathname === '/ext') {
    if (!allowedOrigins.has(req.headers.origin ?? '')) {
      log('rejected extension socket from origin', req.headers.origin)
      return reject(403)
    }
    wss.handleUpgrade(req, socket, head, (ws) => acceptExtension(ws))
    return
  }

  if (url.pathname === '/shim') {
    if (!sameSecret(url.searchParams.get('token') ?? '', token)) return reject(401)
    wss.handleUpgrade(req, socket, head, (ws) => acceptShim(ws))
    return
  }

  const listen = /^\/listen\/([\w-]+)$/.exec(url.pathname)
  if (listen) {
    const session = sessions.get(listen[1] ?? '')
    if (!session) return reject(404)
    if (!sameSecret(url.searchParams.get('key') ?? '', session.listenKey)) return reject(401)
    wss.handleUpgrade(req, socket, head, (ws) => acceptListener(session, ws))
    return
  }

  reject(404)
})

function acceptExtension(ws: WebSocket): void {
  extensions.add(ws)
  ws.on('message', (data) => {
    try {
      handleExtensionMessage(ws, data.toString())
    } catch (error) {
      log('extension message failed', error)
      send(ws, { type: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  })
  ws.on('close', () => extensions.delete(ws))
}

function acceptShim(ws: WebSocket): void {
  lastActivity = Date.now()
  ws.on('message', (data) => {
    lastActivity = Date.now()
    let request: ShimRequest
    try {
      request = JSON.parse(data.toString()) as ShimRequest
    } catch {
      return
    }
    let response: ShimResponse
    try {
      response = { id: request.id, result: handleShimRequest(request, ws) }
    } catch (error) {
      response = { id: request.id, error: error instanceof Error ? error.message : String(error) }
    }
    ws.send(JSON.stringify(response))
  })
  ws.on('close', () => {
    for (const session of [...sessions.values()]) {
      if (session.shim !== ws) continue
      sessions.delete(session.id)
      session.listener?.close(1001, 'session ended')
      log('session ended', session.id)
    }
    lastActivity = Date.now()
    broadcastSessions()
  })
}

function acceptListener(session: Session, ws: WebSocket): void {
  const previous = session.listener
  session.listener = ws
  if (previous) previous.close(LISTENER_REPLACED_CLOSE_CODE, 'replaced by a newer listener')
  ws.on('close', () => {
    if (session.listener !== ws) return
    session.listener = null
    broadcastSessions()
  })
  broadcastSessions()
  // Ring again for everything not fetched yet. The previous Monitor may have died before a
  // doorbell reached Claude; a repeat costs one live_get_batch that answers "No unfetched batch".
  // The short wait keeps a frame out of the handshake's packet, for clients that listen late.
  setTimeout(() => {
    if (session.listener !== ws) return
    for (const batch of unfetchedFor(session)) ringDoorbell(session, batch)
  }, 250)
}

function shutdown(reason: string): void {
  log('shutting down:', reason)
  for (const session of sessions.values()) session.listener?.close(1001, 'daemon stopping')
  for (const client of wss.clients) client.terminate()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

setInterval(() => {
  if (sessions.size === 0 && Date.now() - lastActivity > config.idleExitMs) shutdown('idle')
}, 30_000).unref()

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.on('error', (error: NodeJS.ErrnoException) => {
  log(error.code === 'EADDRINUSE' ? `port ${config.port} is in use` : error)
  process.exit(1)
})

server.listen(config.port, '127.0.0.1', () => log(`${PRODUCT_NAME} daemon ${BUILD_ID} on 127.0.0.1:${config.port}`))
