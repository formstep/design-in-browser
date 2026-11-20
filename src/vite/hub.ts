// The plugin's state: the user's choices (saved in the project's journal folder, so they survive reloads and
// dev-server restarts), plus sessions and batches from the daemon. Comments go to the agent as they are made.
// Batches belong to the project, but each app's thread shows only those made on its own dev server, so two apps
// in one repo don't share a chat. It never starts the daemon: an agent session does that when it connects.
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import type { Batch, DaemonToPlugin, DraftComment, PluginToDaemon } from '../shared/protocol.ts'
import { START_COMMAND } from '../shared/protocol.ts'
import { PAGE_BUILD, sameProject, versionKey, type PageOp, type PageState } from '../shared/page-protocol.ts'
import { config, tokenPath } from '../node/config.ts'
import { ensureJournal } from '../node/journal.ts'

const RETRY_MS = 2000
const KEEPALIVE_MS = 20_000

type Saved = Pick<PageState, 'pickedSessionId' | 'variantChoices' | 'tweakValues' | 'dismissed' | 'cleared'>

/** The port a page URL is served on; pages of one dev server share it, whatever the loopback name. */
function portOf(url: string): string {
  const { port, protocol } = new URL(url)
  return port || (protocol === 'https:' ? '443' : '80')
}

export class Hub {
  readonly state: PageState
  private socket: WebSocket | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private keepalive: ReturnType<typeof setInterval> | null = null
  private stopped = false
  /** Sends the daemon hasn't answered yet: clientBatchId -> how to settle the page's operation (null when taken). */
  private readonly inFlight = new Map<string, (error: string | null) => void>()
  private readonly savedFile: string
  private readonly broadcast: (state: PageState) => void
  /** This project's batches from the daemon, newest first, before this app's view of them. */
  private projectBatches: Batch[] = []
  /** The dev server's port: a batch belongs to this app when its comments were made on it. */
  private readonly port: string

  /** `appRoot` and `port` are the dev server's: two apps in one repo each keep their own stack and thread. */
  constructor(projectRoot: string, appRoot: string, port: number, broadcast: (state: PageState) => void) {
    this.broadcast = broadcast
    this.port = String(port)
    const app = path.relative(projectRoot, appRoot).replace(/[^\w.-]+/g, '-') || 'root'
    this.savedFile = path.join(projectRoot, '.design-in-browser', `page-state.${app}.json`)
    const saved = this.load()
    this.state = {
      build: PAGE_BUILD,
      connection: 'offline',
      projectRoot,
      sessions: [],
      batches: [],
      sending: false,
      lastError: null,
      pickedSessionId: saved.pickedSessionId,
      variantChoices: saved.variantChoices,
      tweakValues: saved.tweakValues,
      dismissed: saved.dismissed,
      cleared: saved.cleared,
    }
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    if (this.keepalive) clearInterval(this.keepalive)
    this.socket?.close()
    this.socket = null
  }

  // --- operations from pages -----------------------------------------------------------

  /** Applies one operation; resolves to an error message for the page, or null. */
  async apply(op: PageOp): Promise<string | null> {
    switch (op.type) {
      case 'send-comment':
        return this.sendComment(op.sessionId, op.comment)
      case 'pick-session':
        this.update({ pickedSessionId: op.sessionId }, true)
        return null
      case 'dismiss':
        if (!this.state.dismissed.includes(op.commentId)) this.update({ dismissed: [...this.state.dismissed, op.commentId] }, true)
        return null
      case 'start-over': {
        // What the agent is still working on stays in view until it answers; the rest of the thread goes.
        const keep = this.state.batches.filter((batch) => batch.status !== 'done').map((batch) => batch.id)
        const cleared = { at: new Date().toISOString(), keep }
        this.update({ cleared, dismissed: [], batches: this.visible(cleared) }, true)
        return null
      }
      case 'show-variant':
        this.update({ variantChoices: { ...this.state.variantChoices, [op.group]: op.index } }, true)
        return null
      case 'set-tweak': {
        const key = versionKey(op.group, op.index)
        this.update({ tweakValues: { ...this.state.tweakValues, [key]: { ...this.state.tweakValues[key], [op.id]: op.value } } }, true)
        return null
      }
    }
  }

  /** Sends one comment, and settles once the daemon has taken it or refused it: until then the page keeps its text. */
  private sendComment(sessionId: string, comment: DraftComment): Promise<string | null> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.resolve(`Not connected to a coding agent. Connect a session (in Claude Code: ${START_COMMAND}), then send again.`)
    }
    const clientBatchId = crypto.randomUUID()
    return new Promise((settle) => {
      this.inFlight.set(clientBatchId, settle)
      this.post({ type: 'send-batch', clientBatchId, sessionId, comments: [comment] })
      this.update({ sending: true, lastError: null })
    })
  }

  /** Answers one send, with null when the daemon took it, or why not. */
  private settle(clientBatchId: string, error: string | null): void {
    this.inFlight.get(clientBatchId)?.(error)
    this.inFlight.delete(clientBatchId)
  }

  // --- daemon ----------------------------------------------------------------------------

  private connect(): void {
    if (this.stopped || this.socket) return
    let token: string
    try {
      token = fs.readFileSync(tokenPath(), 'utf8').trim()
    } catch {
      // No daemon has run on this machine yet; an agent session starts one.
      this.scheduleRetry()
      return
    }
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}/page?token=${token}`)
    this.socket = ws
    ws.on('open', () => {
      this.post({ type: 'hello', projectRoot: this.state.projectRoot })
      this.keepalive = setInterval(() => this.post({ type: 'ping' }), KEEPALIVE_MS)
      this.update({ connection: 'connected', lastError: null })
    })
    ws.on('message', (data) => this.handle(JSON.parse(data.toString()) as DaemonToPlugin))
    ws.on('error', () => {})
    ws.on('close', () => {
      if (this.socket !== ws) return
      this.socket = null
      if (this.keepalive) clearInterval(this.keepalive)
      for (const clientBatchId of this.inFlight.keys())
        this.settle(clientBatchId, 'Lost the connection to the coding agent before it got this. Send it again.')
      this.update({ connection: 'offline', sessions: [], sending: false })
      this.scheduleRetry()
    })
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.connect()
    }, RETRY_MS)
  }

  private post(message: PluginToDaemon): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message))
  }

  private ours(batch: Batch): boolean {
    return sameProject(batch.projectRoot, this.state.projectRoot)
  }

  /** This app's thread: the project's batches made on this dev server, less those cleared by starting over. */
  private visible(cleared = this.state.cleared): Batch[] {
    return this.projectBatches
      .filter((batch) => batch.comments.some((comment) => portOf(comment.page.url) === this.port))
      .filter((batch) => cleared === null || batch.createdAt >= cleared.at || cleared.keep.includes(batch.id))
      .slice(0, 30)
  }

  /** Takes in the daemon's latest copy of a batch, and returns this app's thread with it. */
  private upsert(batch: Batch): Batch[] {
    const rest = this.projectBatches.filter((entry) => !(entry.id === batch.id && entry.projectRoot === batch.projectRoot))
    const next = this.ours(batch) ? [batch, ...rest] : rest
    this.projectBatches = next.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return this.visible()
  }

  private handle(message: DaemonToPlugin): void {
    switch (message.type) {
      case 'state':
        this.projectBatches = message.batches.filter((batch) => this.ours(batch)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        this.update({ sessions: message.sessions, batches: this.visible() })
        return
      case 'sessions':
        this.update({ sessions: message.sessions })
        return
      case 'batch-accepted':
        this.settle(message.clientBatchId, null)
        this.update({ batches: this.upsert(message.batch), sending: this.inFlight.size > 0 })
        return
      case 'batch-updated':
        this.update({ batches: this.upsert(message.batch) })
        return
      case 'error':
        // An error for a send goes back to where it was made, which keeps its text; any other shows in the dock.
        if (message.clientBatchId) this.settle(message.clientBatchId, message.message)
        this.update({ lastError: message.clientBatchId ? null : message.message, sending: this.inFlight.size > 0 })
        return
      case 'pong':
        return
    }
  }

  // --- state ----------------------------------------------------------------------------

  private update(patch: Partial<PageState>, save = false): void {
    Object.assign(this.state, patch)
    if (save) this.save()
    this.broadcast(this.state)
  }

  /** The saved stack and choices. Fields missing from an older file start empty; an unreadable file is reported. */
  private load(): Saved {
    const empty: Saved = {
      pickedSessionId: null,
      variantChoices: {},
      tweakValues: {},
      dismissed: [],
      cleared: null,
    }
    if (!fs.existsSync(this.savedFile)) return empty
    try {
      const saved = JSON.parse(fs.readFileSync(this.savedFile, 'utf8')) as Partial<Saved>
      return { ...empty, ...saved }
    } catch (error) {
      console.warn(
        `[design-in-browser] Starting with an empty comment stack: could not read ${this.savedFile} (${error instanceof Error ? error.message : String(error)}).`
      )
      return empty
    }
  }

  private save(): void {
    ensureJournal(this.state.projectRoot)
    const { pickedSessionId, variantChoices, tweakValues, dismissed, cleared } = this.state
    const tmp = `${this.savedFile}.tmp`
    fs.writeFileSync(
      tmp,
      JSON.stringify({ pickedSessionId, variantChoices, tweakValues, dismissed, cleared } satisfies Saved, null, 2) + '\n'
    )
    fs.renameSync(tmp, this.savedFile)
  }
}
