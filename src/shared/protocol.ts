// Messages and records shared by the daemon, the MCP shim and the extension.
// The extension is bundled from TypeScript too, so these types are the one source of truth.

export const PRODUCT_NAME = 'design-in-browser'
export const DEFAULT_PORT = 47821
/** What the user runs in Claude Code to connect a session. */
export const START_COMMAND = `/${PRODUCT_NAME}:live`

// The extension's id is pinned by the `key` in extension/manifest.json.
// The daemon only accepts extension sockets whose Origin is one of these.
export const PINNED_EXTENSION_ID = 'acgljpfcidgogojgnhpagcglfkmkpipo'

/** Close code the daemon uses when a newer listener replaces an older one. */
export const LISTENER_REPLACED_CLOSE_CODE = 4001

export type Rect = { x: number; y: number; width: number; height: number }

export type ElementRef = {
  /** CSS selector that found exactly this element when the comment was made. */
  selector: string
  tag: string
  id: string | null
  classes: string[]
  /** First 120 characters of the element's text, whitespace collapsed. */
  text: string
  /** outerHTML, cut to a few thousand characters. */
  html: string
  /** Position in page coordinates (scroll included). */
  rect: Rect
  styles: Record<string, string>
  /** Short labels of the closest ancestors, nearest first, e.g. `section.hero`. */
  ancestors: string[]
  /** `data-dib-src` of the element or its nearest ancestor, stamped by a dev build plugin (not shipped yet). */
  sourceHint: string | null
}

export type PageRef = {
  url: string
  title: string
  viewport: { width: number; height: number }
}

/** Links an answer to the comment Claude asked a question about, with both texts so the batch reads on its own. */
export type InReplyTo = {
  batchId: string
  commentId: string
  /** The original comment. */
  comment: string
  /** Claude's question. */
  question: string
}

/** A comment as the extension drafts it. `element` is null for a note about the whole page. */
export type DraftComment = {
  id: string
  text: string
  page: PageRef
  element: ElementRef | null
  /** Set when this comment answers a question Claude asked; same page and element as the original. */
  inReplyTo: InReplyTo | null
  createdAt: string
}

export type CommentStatus = 'pending' | 'done' | 'question' | 'skipped'
export type ReplyStatus = Exclude<CommentStatus, 'pending'>

export type BatchComment = DraftComment & {
  status: CommentStatus
  reply: string | null
}

/**
 * queued: written to the journal, Claude has not fetched it.
 * fetched: Claude called live_get_batch.
 * done: every comment has a reply.
 */
export type BatchStatus = 'queued' | 'fetched' | 'done'

export type Batch = {
  id: string
  projectRoot: string
  /** Session that owns the batch now. A batch moves to a new session on the same project when its owner is gone. */
  sessionId: string
  createdAt: string
  status: BatchStatus
  summary: string | null
  comments: BatchComment[]
}

export type SessionInfo = {
  id: string
  label: string
  projectRoot: string
  origins: string[]
  /** True while a Monitor socket is open, so a send wakes Claude now. */
  listening: boolean
  connectedAt: string
}

// Extension <-> daemon, over ws://127.0.0.1:<port>/ext

export type ExtensionToDaemon =
  | { type: 'hello'; extensionVersion: string }
  | { type: 'ping' }
  | { type: 'send-batch'; clientBatchId: string; sessionId: string; comments: DraftComment[] }

export type DaemonToExtension =
  | { type: 'state'; sessions: SessionInfo[]; batches: Batch[] }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'batch-accepted'; clientBatchId: string; batch: Batch }
  | { type: 'batch-updated'; batch: Batch }
  | { type: 'error'; message: string; clientBatchId?: string }
  | { type: 'pong' }

// MCP shim <-> daemon, over ws://127.0.0.1:<port>/shim?token=...

export type ConnectParams = { sessionId: string; projectRoot: string; origins: string[] }
export type ConnectResult = { listenUrl: string; journalDir: string; unfetched: string[] }
export type GetBatchParams = { sessionId: string; batchId?: string }
export type ReplyParams = {
  sessionId: string
  batchId: string
  replies: Array<{ commentId: string; status: ReplyStatus; message: string }>
  summary?: string
}
export type StatusResult = {
  sessionId: string
  listening: boolean
  extensionsConnected: number
  unfetched: string[]
  open: Array<{ id: string; status: BatchStatus; pending: number }>
}

export type ShimMethods = {
  connect: { params: ConnectParams; result: ConnectResult }
  getBatch: { params: GetBatchParams; result: Batch | null }
  reply: { params: ReplyParams; result: Batch }
  status: { params: { sessionId: string }; result: StatusResult }
}

export type ShimRequest = {
  [M in keyof ShimMethods]: { id: number; method: M; params: ShimMethods[M]['params'] }
}[keyof ShimMethods]

export type ShimResponse = { id: number; result: unknown } | { id: number; error: string }

export type Health = { name: typeof PRODUCT_NAME; buildId: string; pid: number }
