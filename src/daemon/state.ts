// The daemon's state: connected agent sessions and each project's batches. Batches live in the project's journal
// folder; memory only caches them. Sockets are daemon.ts's business: this module tells it what changed.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { WebSocket } from 'ws'
import {
  PRODUCT_NAME,
  START_COMMAND,
  type Batch,
  type ConnectParams,
  type ConnectResult,
  type DraftComment,
  type GetBatchParams,
  type NoteParams,
  type ReplyParams,
  type SessionInfo,
  type StatusResult,
} from '../shared/protocol.ts'
import { config } from '../node/config.ts'
import { appendEvent, ensureJournal, nextBatchId, readBatches, writeBatch } from '../node/journal.ts'

export type Session = {
  id: string
  projectRoot: string
  agent: string
  origins: string[]
  connectedAt: string
  /** The MCP server's socket; the session ends when it closes. */
  shim: WebSocket
  /** The secret in the session's Monitor URL. */
  listenKey: string
  /** The agent's Monitor, while one is armed. */
  listener: WebSocket | null
}

type Changes = { batchSaved: (batch: Batch) => void; sessionsChanged: () => void }

const sessions = new Map<string, Session>()
/** projectRoot -> batchId -> batch */
const projects = new Map<string, Map<string, Batch>>()
let changes: Changes = { batchSaved: () => {}, sessionsChanged: () => {} }

/** daemon.ts passes these in to tell connected dev servers. */
export function onChanges(next: Changes): void {
  changes = next
}

// --- batches -------------------------------------------------------------------

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
  changes.batchSaved(batch)
}

/** The 30 newest batches of every connected project, plus `projectRoot`'s when it is a real folder. */
export function recentBatches(projectRoot?: string): Batch[] {
  const roots = new Set([...sessions.values()].map((session) => session.projectRoot))
  if (projectRoot && path.isAbsolute(projectRoot) && fs.existsSync(projectRoot)) roots.add(projectRoot)
  return [...roots]
    .flatMap((root) => [...projectBatches(root).values()])
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 30)
}

export function unfetchedFor(session: Session): Batch[] {
  return [...projectBatches(session.projectRoot).values()].filter((batch) => batch.sessionId === session.id && batch.status === 'queued')
}

/** Wakes the agent: one text frame on its Monitor. */
export function ringDoorbell(session: Session, batch: Batch): void {
  if (session.listener?.readyState !== WebSocket.OPEN) return
  const count = batch.comments.length
  session.listener.send(`${PRODUCT_NAME}: batch ${batch.id} ready, ${count} ${count === 1 ? 'comment' : 'comments'}. Call live_get_batch.`)
}

/** Turns comments sent from a page into a queued batch for the session, and wakes its agent. */
export function queueBatch(sessionId: string, comments: DraftComment[]): Batch {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`That agent session has ended. Connect a session again (in Claude Code: ${START_COMMAND}), then send.`)
  // An answer must reach the project whose batch asked the question.
  const known = projectBatches(session.projectRoot)
  const misrouted = comments.some(
    ({ inReplyTo }) => inReplyTo && !known.get(inReplyTo.batchId)?.comments.some((original) => original.id === inReplyTo.commentId)
  )
  if (misrouted) {
    throw new Error(
      `An answer goes to the project that asked the question, not ${path.basename(session.projectRoot)}. Pick that project's session and send again.`
    )
  }
  ensureJournal(session.projectRoot)
  const batch: Batch = {
    id: nextBatchId(session.projectRoot),
    from: 'user',
    projectRoot: session.projectRoot,
    agent: session.agent,
    sessionId: session.id,
    createdAt: new Date().toISOString(),
    status: 'queued',
    summary: null,
    comments: comments.map((comment) => ({ ...comment, status: 'pending', reply: null })),
  }
  saveBatch(batch, { type: 'created', session: session.id, comments: batch.comments.length })
  ringDoorbell(session, batch)
  return batch
}

// --- sessions --------------------------------------------------------------------

export const getSession = (sessionId: string) => sessions.get(sessionId)
export const sessionCount = () => sessions.size
export const allSessions = () => [...sessions.values()]

export function sessionInfo(session: Session): SessionInfo {
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

function requireSession(sessionId: string): Session {
  const session = sessions.get(sessionId)
  if (!session) throw new Error(`No connected session ${sessionId}. Call live_connect first.`)
  return session
}

export function connect(params: ConnectParams, shim: WebSocket): { session: Session; result: ConnectResult } {
  if (!path.isAbsolute(params.projectRoot)) throw new Error(`projectRoot must be absolute: ${params.projectRoot}`)
  if (!fs.statSync(params.projectRoot, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`projectRoot is not a directory: ${params.projectRoot}`)
  const journalDir = ensureJournal(params.projectRoot)
  // A repeated connect updates the session in place: listener close handlers hold on to this object.
  const session: Session = sessions.get(params.sessionId) ?? {
    id: params.sessionId,
    projectRoot: params.projectRoot,
    agent: params.agent,
    origins: params.origins,
    connectedAt: new Date().toISOString(),
    shim,
    listenKey: crypto.randomBytes(16).toString('hex'),
    listener: null,
  }
  Object.assign(session, { projectRoot: params.projectRoot, agent: params.agent, origins: params.origins, shim })
  sessions.set(session.id, session)

  // Open batches whose session is gone move to this one, so nothing sent is lost.
  for (const batch of projectBatches(session.projectRoot).values()) {
    if (batch.status === 'done' || batch.sessionId === session.id || sessions.has(batch.sessionId)) continue
    saveBatch({ ...batch, sessionId: session.id, agent: session.agent }, { type: 'adopted', session: session.id })
  }
  changes.sessionsChanged()
  return {
    session,
    result: {
      listenUrl: `ws://127.0.0.1:${config.port}/listen/${session.id}?key=${session.listenKey}`,
      journalDir,
      unfetched: unfetchedFor(session).map((batch) => batch.id),
    },
  }
}

/** Ends every session whose MCP server used this socket. */
export function endSessionsOf(shim: WebSocket): Session[] {
  const ended = [...sessions.values()].filter((session) => session.shim === shim)
  for (const session of ended) {
    sessions.delete(session.id)
    session.listener?.close(1001, 'session ended')
  }
  changes.sessionsChanged()
  return ended
}

export function getBatch(params: GetBatchParams): Batch | null {
  const session = requireSession(params.sessionId)
  const batch = params.batchId === undefined ? unfetchedFor(session)[0] : projectBatches(session.projectRoot).get(params.batchId)
  if (!batch) {
    if (params.batchId !== undefined) throw new Error(`No batch ${params.batchId} in ${session.projectRoot}`)
    return null
  }
  if (batch.status !== 'queued') return batch
  const fetched: Batch = { ...batch, status: 'fetched', sessionId: session.id, agent: session.agent }
  saveBatch(fetched, { type: 'fetched', session: session.id })
  return fetched
}

export function reply(params: ReplyParams): Batch {
  const session = requireSession(params.sessionId)
  const batch = projectBatches(session.projectRoot).get(params.batchId)
  if (!batch) throw new Error(`No batch ${params.batchId} in ${session.projectRoot}`)
  const byId = new Map(params.replies.map((entry) => [entry.commentId, entry]))
  const unknown = [...byId.keys()].filter((id) => !batch.comments.some((comment) => comment.id === id))
  if (unknown.length > 0) throw new Error(`Unknown comment ids in batch ${batch.id}: ${unknown.join(', ')}`)
  const comments = batch.comments.map((comment) => {
    const entry = byId.get(comment.id)
    if (!entry) return comment
    const answered = { ...comment, status: entry.status, reply: entry.message }
    return entry.group ? { ...answered, group: entry.group } : answered
  })
  const updated: Batch = {
    ...batch,
    comments,
    summary: params.summary ?? batch.summary,
    status: comments.every((comment) => comment.status !== 'pending') ? 'done' : 'fetched',
  }
  saveBatch(updated, { type: 'replied', session: session.id, comments: [...byId.keys()] })
  return updated
}

/**
 * Notes the agent leaves on a page, as a batch of its own: each note is a comment with no text whose reply is the
 * note. A note that wants an answer is a question, which the user answers like any other.
 */
export function note(params: NoteParams): Batch {
  const session = requireSession(params.sessionId)
  ensureJournal(session.projectRoot)
  const createdAt = new Date().toISOString()
  const batch: Batch = {
    id: nextBatchId(session.projectRoot),
    from: 'agent',
    projectRoot: session.projectRoot,
    agent: session.agent,
    sessionId: session.id,
    createdAt,
    status: 'done',
    summary: null,
    comments: params.notes.map(({ anchor, note: text, question }) => ({
      id: crypto.randomUUID(),
      text: '',
      // The agent's note has no capture behind it: only the page it is on, and an anchor instead of an element.
      page: { url: params.url, title: '', viewport: { width: 0, height: 0 } },
      element: null,
      anchor,
      inReplyTo: null,
      createdAt,
      status: question ? 'question' : 'note',
      reply: text,
    })),
  }
  saveBatch(batch, { type: 'noted', session: session.id, notes: batch.comments.length })
  return batch
}

export function status(sessionId: string, devServersConnected: number): StatusResult {
  const session = requireSession(sessionId)
  const open = [...projectBatches(session.projectRoot).values()].filter(
    (batch) => batch.sessionId === session.id && batch.status !== 'done'
  )
  return {
    sessionId,
    listening: session.listener !== null,
    devServersConnected,
    unfetched: unfetchedFor(session).map((batch) => batch.id),
    open: open.map((batch) => ({
      id: batch.id,
      status: batch.status,
      pending: batch.comments.filter((comment) => comment.status === 'pending').length,
    })),
  }
}
