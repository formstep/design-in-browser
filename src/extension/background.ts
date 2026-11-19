// Service worker: holds the socket to the daemon and is the only writer of shared state.
import { START_COMMAND, type Batch, type DaemonToExtension, type ExtensionToDaemon } from '../shared/protocol.ts'
import { readState, writeState, type BackgroundMessage } from './state.ts'

const KEEPALIVE_MS = 20_000
let socket: WebSocket | null = null
let keepalive: ReturnType<typeof setInterval> | null = null
let retryMs = 1000
/** clientBatchId -> ids of the draft comments in that send */
const inFlight = new Map<string, string[]>()
/** State updates read, then write. Running them one at a time keeps two updates from overwriting each other. */
let updates: Promise<unknown> = Promise.resolve()
function serially<T>(task: () => Promise<T>): Promise<T> {
  const next = updates.then(task, task)
  updates = next.catch(() => {})
  return next
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})

function upsert(batches: Batch[], batch: Batch): Batch[] {
  const rest = batches.filter((entry) => !(entry.id === batch.id && entry.projectRoot === batch.projectRoot))
  return [batch, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30)
}

function post(message: ExtensionToDaemon): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(message))
  return true
}

async function connect(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  const { port } = await readState()
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ext`)
  socket = ws
  ws.onopen = () => {
    retryMs = 1000
    post({ type: 'hello', extensionVersion: chrome.runtime.getManifest().version })
    keepalive = setInterval(() => post({ type: 'ping' }), KEEPALIVE_MS)
    void serially(() => writeState({ connection: 'connected', lastError: null }))
  }
  ws.onmessage = (event) => void serially(() => handle(JSON.parse(String(event.data)) as DaemonToExtension))
  ws.onclose = () => {
    if (socket !== ws) return
    socket = null
    if (keepalive) clearInterval(keepalive)
    inFlight.clear()
    void serially(() => writeState({ connection: 'offline', sessions: [], sending: false }))
    setTimeout(() => void connect(), retryMs)
    // The daemon starts when a session connects; a refused localhost socket is cheap, so retry often
    // enough that the panel notices within a couple of seconds.
    retryMs = Math.min(retryMs * 2, 2000)
  }
}

async function handle(message: DaemonToExtension): Promise<void> {
  const state = await readState()
  switch (message.type) {
    case 'state':
      await writeState({ sessions: message.sessions, batches: message.batches })
      return
    case 'sessions':
      await writeState({ sessions: message.sessions })
      return
    case 'batch-accepted': {
      const sent = new Set(inFlight.get(message.clientBatchId) ?? [])
      inFlight.delete(message.clientBatchId)
      await writeState({
        draft: state.draft.filter((comment) => !sent.has(comment.id)),
        batches: upsert(state.batches, message.batch),
        sending: inFlight.size > 0,
      })
      return
    }
    case 'batch-updated':
      await writeState({ batches: upsert(state.batches, message.batch) })
      return
    case 'error':
      if (message.clientBatchId) inFlight.delete(message.clientBatchId)
      await writeState({ lastError: message.message, sending: inFlight.size > 0 })
      return
    case 'pong':
      return
  }
}

async function onMessage(message: BackgroundMessage): Promise<void> {
  const state = await readState()
  switch (message.type) {
    case 'add-comment':
      await writeState({ draft: [...state.draft, message.comment], lastError: null })
      return
    case 'update-comment':
      await writeState({
        draft: state.draft.map((comment) => (comment.id === message.id ? { ...comment, text: message.text } : comment)),
      })
      return
    case 'remove-comment':
      await writeState({ draft: state.draft.filter((comment) => comment.id !== message.id) })
      return
    case 'send': {
      const comments = state.draft.filter((comment) => comment.text.trim() !== '')
      if (comments.length === 0) return
      const clientBatchId = crypto.randomUUID()
      inFlight.set(clientBatchId, comments.map((comment) => comment.id))
      const sent = post({ type: 'send-batch', clientBatchId, sessionId: message.sessionId, comments })
      if (!sent) {
        inFlight.delete(clientBatchId)
        await writeState({ lastError: `Not connected to a coding agent. Connect a session (in Claude Code: ${START_COMMAND}), then send again.` })
        return
      }
      await writeState({ sending: true, lastError: null })
      return
    }
    case 'reconnect':
      socket?.close()
      socket = null
      retryMs = 1000
      await connect()
      return
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundMessage, _sender, sendResponse) => {
  serially(() => onMessage(message)).then(
    () => sendResponse({ ok: true }),
    (error: unknown) => sendResponse({ ok: false, error: String(error) }),
  )
  return true
})

// A changed port (set by tests, or by hand in the console) takes effect right away.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('port' in changes)) return
  socket?.close()
  socket = null
  retryMs = 1000
  void connect()
})

// Alarms wake the worker after Chrome stops it, so it reconnects even with no page open.
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(() => void connect())
chrome.runtime.onStartup.addListener(() => void connect())
chrome.runtime.onInstalled.addListener(() => void connect())

void serially(() => writeState({ connection: 'offline', sessions: [], sending: false })).then(connect)
