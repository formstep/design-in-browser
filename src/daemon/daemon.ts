// One daemon per machine, started by the first agent session that connects. It holds three kinds of sockets:
//   /page?token=...          a Vite dev server running the plugin, relaying for its pages
//   /shim?token=...          one MCP server per agent session that ran /design-in-browser:live
//   /listen/<session>?key=   the agent's Monitor; each text frame wakes the agent
// The state (sessions and batches) lives in state.ts; this file is the network and the process.
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { z } from 'zod'
import {
  LISTENER_REPLACED_CLOSE_CODE,
  PRODUCT_NAME,
  type DaemonToPlugin,
  type Health,
  type ShimRequest,
  type ShimResponse,
} from '../shared/protocol.ts'
import { BUILD_ID, config, tokenPath } from '../node/config.ts'
import { draftCommentSchema } from './schemas.ts'
import * as state from './state.ts'

const log = (...parts: unknown[]) => console.error(new Date().toISOString(), ...parts)

/** Vite dev servers running the plugin. */
const devServers = new Set<WebSocket>()
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

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

function send(socket: WebSocket, message: DaemonToPlugin): void {
  socket.send(JSON.stringify(message))
}

function broadcast(message: DaemonToPlugin): void {
  for (const socket of devServers) send(socket, message)
}

state.onChanges({
  batchSaved: (batch) => broadcast({ type: 'batch-updated', batch }),
  sessionsChanged: () => broadcast({ type: 'sessions', sessions: state.allSessions().map(state.sessionInfo) }),
})

// --- MCP servers ---------------------------------------------------------------------

function handleShimRequest(request: ShimRequest, shim: WebSocket): unknown {
  switch (request.method) {
    case 'connect': {
      const { session, result } = state.connect(request.params, shim)
      log('session connected', session.id, session.projectRoot, session.origins.join(','))
      return result
    }
    case 'getBatch':
      return state.getBatch(request.params)
    case 'reply':
      return state.reply(request.params)
    case 'note':
      return state.note(request.params)
    case 'status':
      return state.status(request.params.sessionId, devServers.size)
  }
}

function acceptShim(ws: WebSocket): void {
  lastActivity = Date.now()
  ws.on('message', (data) => {
    lastActivity = Date.now()
    let request: ShimRequest
    try {
      // The token proved this is our own MCP server; its requests are typed, not validated.
      request = JSON.parse(data.toString()) as ShimRequest
    } catch {
      return
    }
    let response: ShimResponse
    try {
      response = { id: request.id, result: handleShimRequest(request, ws) }
    } catch (error) {
      response = { id: request.id, error: errorMessage(error) }
    }
    ws.send(JSON.stringify(response))
  })
  ws.on('close', () => {
    for (const session of state.endSessionsOf(ws)) log('session ended', session.id)
    lastActivity = Date.now()
  })
}

function acceptListener(session: state.Session, ws: WebSocket): void {
  const previous = session.listener
  session.listener = ws
  if (previous) previous.close(LISTENER_REPLACED_CLOSE_CODE, 'replaced by a newer listener')
  ws.on('close', () => {
    if (session.listener !== ws) return
    session.listener = null
    broadcast({ type: 'sessions', sessions: state.allSessions().map(state.sessionInfo) })
  })
  broadcast({ type: 'sessions', sessions: state.allSessions().map(state.sessionInfo) })
  // Ring again for everything not fetched yet. The previous Monitor may have died before a doorbell reached the
  // agent; a repeat costs one live_get_batch that answers "No unfetched batch". The short wait keeps a frame out
  // of the handshake's packet, for clients that listen late.
  setTimeout(() => {
    if (session.listener !== ws) return
    for (const batch of state.unfetchedFor(session)) state.ringDoorbell(session, batch)
  }, 250)
}

// --- Vite dev servers ------------------------------------------------------------------

const pluginMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), projectRoot: z.string().max(2000).optional() }),
  z.object({ type: z.literal('ping') }),
  z.object({
    type: z.literal('send-batch'),
    clientBatchId: z.string().max(100),
    sessionId: z.string().max(100),
    comments: z.array(draftCommentSchema).min(1).max(50),
  }),
])

function handlePluginMessage(socket: WebSocket, raw: string): void {
  const parsed = pluginMessageSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    send(socket, { type: 'error', message: `Bad message: ${parsed.error.message}` })
    return
  }
  const message = parsed.data
  switch (message.type) {
    case 'hello':
      send(socket, {
        type: 'state',
        sessions: state.allSessions().map(state.sessionInfo),
        batches: state.recentBatches(message.projectRoot),
      })
      return
    case 'ping':
      send(socket, { type: 'pong' })
      return
    case 'send-batch':
      try {
        const batch = state.queueBatch(message.sessionId, message.comments)
        send(socket, { type: 'batch-accepted', clientBatchId: message.clientBatchId, batch })
      } catch (error) {
        send(socket, { type: 'error', message: errorMessage(error), clientBatchId: message.clientBatchId })
      }
      return
  }
}

function acceptDevServer(ws: WebSocket): void {
  devServers.add(ws)
  ws.on('message', (data) => {
    try {
      handlePluginMessage(ws, data.toString())
    } catch (error) {
      log('dev server message failed', error)
      send(ws, { type: 'error', message: errorMessage(error) })
    }
  })
  ws.on('close', () => devServers.delete(ws))
}

// --- http + upgrade -----------------------------------------------------------

const allowedHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`])

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

  // The Vite plugin's dev server and the MCP servers are Node clients on this machine: they prove themselves with
  // the token in ~/.design-in-browser, which a web page can't read.
  if (url.pathname === '/page' || url.pathname === '/shim') {
    if (!sameSecret(url.searchParams.get('token') ?? '', token)) return reject(401)
    const accept = url.pathname === '/page' ? acceptDevServer : acceptShim
    wss.handleUpgrade(req, socket, head, accept)
    return
  }

  const listen = /^\/listen\/([\w-]+)$/.exec(url.pathname)
  if (listen) {
    const session = state.getSession(listen[1] ?? '')
    if (!session) return reject(404)
    if (!sameSecret(url.searchParams.get('key') ?? '', session.listenKey)) return reject(401)
    wss.handleUpgrade(req, socket, head, (ws) => acceptListener(session, ws))
    return
  }

  reject(404)
})

// --- lifecycle ------------------------------------------------------------------------

function shutdown(reason: string): void {
  log('shutting down:', reason)
  for (const session of state.allSessions()) session.listener?.close(1001, 'daemon stopping')
  for (const client of wss.clients) client.terminate()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
}

setInterval(() => {
  if (state.sessionCount() === 0 && Date.now() - lastActivity > config.idleExitMs) shutdown('idle')
}, 30_000).unref()

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

server.on('error', (error: NodeJS.ErrnoException) => {
  log(error.code === 'EADDRINUSE' ? `port ${config.port} is in use` : error)
  process.exit(1)
})

server.listen(config.port, '127.0.0.1', () => log(`${PRODUCT_NAME} daemon ${BUILD_ID} on 127.0.0.1:${config.port}`))
