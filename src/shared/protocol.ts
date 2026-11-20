// Messages and records shared by the daemon, the MCP shim, the Vite plugin and the page client.

export const PRODUCT_NAME = 'design-in-browser'
export const DEFAULT_PORT = 47821
/** What the user runs in Claude Code to connect a session. Other agents get their own way in later. */
export const START_COMMAND = `/${PRODUCT_NAME}:live`

/** Shown when no agent session is known. */
export const FALLBACK_AGENT = 'Agent'

/** MCP client names of agents we know, to the name the UI shows. Anything else shows as FALLBACK_AGENT. */
const KNOWN_AGENTS: Record<string, string> = {
  'claude-code': 'Claude',
  opencode: 'OpenCode',
}

/** The UI name for the agent behind an MCP client, from the client name it sent when it connected. */
export function agentLabel(clientName: string | undefined): string {
  const key = (clientName ?? '').toLowerCase()
  return KNOWN_AGENTS[key] ?? FALLBACK_AGENT
}

/** Close code the daemon uses when a newer listener replaces an older one. */
export const LISTENER_REPLACED_CLOSE_CODE = 4001
/** Close code a listener gets when its session ends: its MCP server went away, so the URL is dead. */
export const SESSION_ENDED_CLOSE_CODE = 4002

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
  /**
   * Where the element's JSX is written, as `path:line:column` from the project root (absolute outside it), then the JSX around it in
   * other files (the component's caller), nearest first, at most three. Empty when the page has no source
   * locations: not React, or the plugin's `sourceLocations` turned off.
   */
  sources: string[]
  /** Where in the element the user clicked, in px from its top-left corner. The pin sits there. Absent on older comments. */
  clickOffset?: { x: number; y: number }
}

export type PageRef = {
  url: string
  title: string
  viewport: { width: number; height: number }
}

/** Links an answer to the comment the agent asked a question about, with both texts so the batch reads on its own. */
export type InReplyTo = {
  batchId: string
  commentId: string
  /** The original comment. */
  comment: string
  /** The agent's question. */
  question: string
}

/** A knob the agent gives one alternative, for the user to adjust live: a feature on or off, a size, or a choice. */
export type TweakSpec =
  | { kind: 'toggle'; label: string; default: boolean }
  | { kind: 'range'; label: string; min: number; max: number; step: number; default: number; unit?: string }
  | { kind: 'choice'; label: string; options: readonly string[]; default: string }

export type TweakValue = boolean | number | string

/** A tweak as the user left it when picking a version, with its label so the batch reads on its own. */
export type ChosenTweak = { id: string; label: string; value: TweakValue }

/** One version of a `<Variants>` group as the user saw it: which one, and its tweak values then. Index 0 is "Before". */
export type ShownVersion = { group: string; index: number; label: string; tweaks: ChosenTweak[] }

/**
 * What a comment asks for. Absent means a plain comment in words.
 * - alternatives: build `count` versions of the element in source, behind a `<Variants>` wrapper, each with a few
 *   tweaks, for the user to cycle through and adjust.
 * - choose-variant: the user picked this version with these tweak values; keep that one with the values written
 *   in, and remove the wrapper and the other versions.
 */
export type Intent = { kind: 'alternatives'; count: number } | ({ kind: 'choose-variant' } & ShownVersion)

/** A point in page coordinates: CSS pixels from the top-left of the document, scroll included. */
export type PagePoint = { x: number; y: number }

/** Something the user drew on the page, in page coordinates. */
export type Mark =
  | { kind: 'box'; x: number; y: number; width: number; height: number }
  | { kind: 'arrow'; from: PagePoint; to: PagePoint }
  | { kind: 'pen'; points: PagePoint[] }

/** A comment as the page drafts it. `element` is null for a note about the whole page. */
export type DraftComment = {
  id: string
  text: string
  page: PageRef
  element: ElementRef | null
  /** Set when this comment answers a question the agent asked; same page and element as the original. */
  inReplyTo: InReplyTo | null
  /** What kind of change this is; absent for a comment in words. */
  intent?: Intent
  /** Set when the comment was made inside a `<Variants>` group: the version it was made on. */
  variant?: ShownVersion
  /** Boxes, arrows and pen strokes the user drew for this comment. `element` is then the one under them. */
  marks?: Mark[]
  /** A JPEG data URL of the marked area as the user saw it, when they attached one. */
  screenshot?: string
  createdAt: string
}

/** How the agent answered a comment. `variants`: alternatives are in the page behind a `<Variants>` wrapper. */
export type ReplyStatus = 'done' | 'question' | 'skipped' | 'variants'
/** `note`: a note the agent left on the page, wanting no answer (a note that wants one is a `question`). */
export type CommentStatus = 'pending' | ReplyStatus | 'note'

/**
 * Where an agent's note points: an element by the source location the plugin stamped on it, by CSS selector, or by
 * both, the source tried first.
 */
export type NoteAnchor = { source: string; selector?: string } | { selector: string }

/** Once sent, a comment's screenshot is a file in the journal instead of a data URL. */
export type BatchComment = Omit<DraftComment, 'screenshot'> & {
  /** The screenshot's path in the journal folder, such as `screenshots/<comment id>.jpg`. */
  screenshotFile?: string
  status: CommentStatus
  reply: string | null
  /** The `<Variants>` group the agent put in the page for this comment, with a `variants` reply. */
  group?: string
  /** On an agent's note, which has no captured element: the element it points at. */
  anchor?: NoteAnchor
}

/**
 * queued: written to the journal, the agent has not fetched it.
 * fetched: the agent called live_get_batch.
 * done: every comment has a reply.
 */
export type BatchStatus = 'queued' | 'fetched' | 'done'

export type Batch = {
  id: string
  /**
   * user: comments the user sent. agent: notes the agent left on the page with live_note, whose text is empty and
   * whose reply is the note. An agent batch never rings or waits to be fetched.
   */
  from: 'user' | 'agent'
  projectRoot: string
  /** Name of the agent that owns the batch, for the UI ("Claude", "OpenCode"). */
  agent: string
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
  /** Name of the coding agent behind the session, for the UI ("Claude", "OpenCode"). */
  agent: string
  projectRoot: string
  origins: string[]
  /** True while a Monitor socket is open, so a send wakes the agent now. */
  listening: boolean
  connectedAt: string
}

// Vite plugin <-> daemon, over ws://127.0.0.1:<port>/page?token=...

export type PluginToDaemon =
  /** Asks for the sessions and batches; `projectRoot` adds that project's batches even with no session connected. */
  | { type: 'hello'; projectRoot?: string }
  | { type: 'ping' }
  | { type: 'send-batch'; clientBatchId: string; sessionId: string; comments: DraftComment[] }

export type DaemonToPlugin =
  | { type: 'state'; sessions: SessionInfo[]; batches: Batch[] }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'batch-accepted'; clientBatchId: string; batch: Batch }
  | { type: 'batch-updated'; batch: Batch }
  | { type: 'error'; message: string; clientBatchId?: string }
  | { type: 'pong' }

// MCP shim <-> daemon, over ws://127.0.0.1:<port>/shim?token=...

export type ConnectParams = {
  sessionId: string
  projectRoot: string
  origins: string[]
  agent: string
  /**
   * The secret in the session's listen URL, chosen by the MCP server so the URL survives a daemon restart: once the
   * MCP server has registered again, a Monitor re-arms on the same URL. A daemon picks one when it is absent.
   */
  listenKey?: string
}
export type ConnectResult = { listenUrl: string; journalDir: string; unfetched: string[] }
export type GetBatchParams = { sessionId: string; batchId?: string }
export type ReplyParams = {
  sessionId: string
  batchId: string
  replies: Array<{ commentId: string; status: ReplyStatus; message: string; group?: string }>
  summary?: string
}
export type NoteParams = {
  sessionId: string
  /** The page the notes are on, a full URL as in a comment's page.url. */
  url: string
  notes: Array<{ anchor: NoteAnchor; note: string; question: boolean }>
}
export type StatusResult = {
  sessionId: string
  listening: boolean
  /** Vite dev servers running the plugin and connected to the daemon. */
  devServersConnected: number
  unfetched: string[]
  open: Array<{ id: string; status: BatchStatus; pending: number }>
}

export type ShimMethods = {
  connect: { params: ConnectParams; result: ConnectResult }
  getBatch: { params: GetBatchParams; result: Batch | null }
  reply: { params: ReplyParams; result: Batch }
  note: { params: NoteParams; result: Batch }
  status: { params: { sessionId: string }; result: StatusResult }
}

export type ShimRequest = {
  [M in keyof ShimMethods]: { id: number; method: M; params: ShimMethods[M]['params'] }
}[keyof ShimMethods]

export type ShimResponse = { id: number; result: unknown } | { id: number; error: string }

export type Health = { name: typeof PRODUCT_NAME; buildId: string; pid: number }
