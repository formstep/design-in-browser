// The plugin's state: the comment stack and the user's choices (saved in the project's journal folder,
// so they survive reloads and dev-server restarts), plus sessions and batches from the daemon.
// It never starts the daemon: an agent session does that when it connects.
import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import type { Batch, DaemonToPlugin, PluginToDaemon } from '../shared/protocol.ts'
import { START_COMMAND } from '../shared/protocol.ts'
import { sameProject, sendable, versionKey, type PageOp, type PageState } from '../shared/page-protocol.ts'
import { config, tokenPath } from '../node/config.ts'
import { ensureJournal } from '../node/journal.ts'

const RETRY_MS = 2000
const KEEPALIVE_MS = 20_000

type Saved = Pick<PageState, 'draft' | 'pickedSessionId' | 'sendOnAdd' | 'variantChoices' | 'tweakValues'>

export class Hub {
  readonly state: PageState
  private socket: WebSocket | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private keepalive: ReturnType<typeof setInterval> | null = null
  private stopped = false
  /** clientBatchId -> ids of the draft comments in that send */
  private readonly inFlight = new Map<string, string[]>()
  private readonly savedFile: string
  private readonly broadcast: (state: PageState) => void

  /** `appRoot` is the dev server's root: two apps in one repo each keep their own stack. */
  constructor(projectRoot: string, appRoot: string, broadcast: (state: PageState) => void) {
    this.broadcast = broadcast
    const app = path.relative(projectRoot, appRoot).replace(/[^\w.-]+/g, '-') || 'root'
    this.savedFile = path.join(projectRoot, '.design-in-browser', `page-state.${app}.json`)
    const saved = this.load()
    this.state = {
      connection: 'offline',
      projectRoot,
      sessions: [],
      batches: [],
      draft: saved.draft,
      sending: false,
      lastError: null,
      pickedSessionId: saved.pickedSessionId,
      sendOnAdd: saved.sendOnAdd,
      variantChoices: saved.variantChoices,
      tweakValues: saved.tweakValues,
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

  /** Applies one operation; returns an error message for the page, or null. */
  apply(op: PageOp): string | null {
    switch (op.type) {
      case 'add-comment':
        this.update({ draft: [...this.state.draft, op.comment], lastError: null }, true)
        return null
      case 'update-comment':
        this.update({ draft: this.state.draft.map((comment) => (comment.id === op.id ? { ...comment, text: op.text } : comment)) }, true)
        return null
      case 'remove-comment':
        this.update({ draft: this.state.draft.filter((comment) => comment.id !== op.id) }, true)
        return null
      case 'pick-session':
        this.update({ pickedSessionId: op.sessionId }, true)
        return null
      case 'set-send-on-add':
        this.update({ sendOnAdd: op.value }, true)
        return null
      case 'show-variant':
        this.update({ variantChoices: { ...this.state.variantChoices, [op.group]: op.index } }, true)
        return null
      case 'set-tweak': {
        const key = versionKey(op.group, op.index)
        this.update({ tweakValues: { ...this.state.tweakValues, [key]: { ...this.state.tweakValues[key], [op.id]: op.value } } }, true)
        return null
      }
      case 'send':
        return this.send(op.sessionId)
    }
  }

  private send(sessionId: string): string | null {
    const comments = sendable(this.state.draft)
    if (comments.length === 0) return null
    if (this.socket?.readyState !== WebSocket.OPEN) {
      const message = `Not connected to a coding agent. Connect a session (in Claude Code: ${START_COMMAND}), then send again.`
      this.update({ lastError: message })
      return message
    }
    const clientBatchId = crypto.randomUUID()
    this.inFlight.set(clientBatchId, comments.map((comment) => comment.id))
    this.post({ type: 'send-batch', clientBatchId, sessionId, comments })
    this.update({ sending: true, lastError: null })
    return null
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
      this.inFlight.clear()
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

  private upsert(batch: Batch): Batch[] {
    const rest = this.state.batches.filter((entry) => !(entry.id === batch.id && entry.projectRoot === batch.projectRoot))
    const next = this.ours(batch) ? [batch, ...rest] : rest
    return next.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30)
  }

  private handle(message: DaemonToPlugin): void {
    switch (message.type) {
      case 'state':
        this.update({ sessions: message.sessions, batches: message.batches.filter((batch) => this.ours(batch)) })
        return
      case 'sessions':
        this.update({ sessions: message.sessions })
        return
      case 'batch-accepted': {
        const sent = new Set(this.inFlight.get(message.clientBatchId) ?? [])
        this.inFlight.delete(message.clientBatchId)
        this.update({ draft: this.state.draft.filter((comment) => !sent.has(comment.id)), batches: this.upsert(message.batch), sending: this.inFlight.size > 0 }, true)
        return
      }
      case 'batch-updated':
        this.update({ batches: this.upsert(message.batch) })
        return
      case 'error':
        if (message.clientBatchId) this.inFlight.delete(message.clientBatchId)
        this.update({ lastError: message.message, sending: this.inFlight.size > 0 })
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
    const empty: Saved = { draft: [], pickedSessionId: null, sendOnAdd: false, variantChoices: {}, tweakValues: {} }
    if (!fs.existsSync(this.savedFile)) return empty
    try {
      const saved = JSON.parse(fs.readFileSync(this.savedFile, 'utf8')) as Partial<Saved>
      return { ...empty, ...saved }
    } catch (error) {
      console.warn(`[design-in-browser] Starting with an empty comment stack: could not read ${this.savedFile} (${error instanceof Error ? error.message : String(error)}).`)
      return empty
    }
  }

  private save(): void {
    ensureJournal(this.state.projectRoot)
    const { draft, pickedSessionId, sendOnAdd, variantChoices, tweakValues } = this.state
    const tmp = `${this.savedFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ draft, pickedSessionId, sendOnAdd, variantChoices, tweakValues } satisfies Saved, null, 2) + '\n')
    fs.renameSync(tmp, this.savedFile)
  }
}
