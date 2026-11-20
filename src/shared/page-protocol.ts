// The contract between the in-page client and the Vite plugin, over Vite's own HMR socket.
// The plugin holds the state (so it survives reloads and dev-server restarts, and every tab shares it);
// pages send operations and get the whole state back after each change.
import type { Batch, DraftComment, SessionInfo, TweakValue } from './protocol.ts'

export const PAGE_EVENT = {
  /** page -> plugin: send me the state */
  hello: 'design-in-browser:hello',
  /** page -> plugin: an operation, answered by an ack */
  op: 'design-in-browser:op',
  /** plugin -> page: result of one operation */
  ack: 'design-in-browser:ack',
  /** plugin -> pages: the whole state, after every change */
  state: 'design-in-browser:state',
} as const

/** The attribute the plugin puts on each element React renders from the project's JSX: `path:line:column`. */
export const SOURCE_ATTRIBUTE = 'data-dib-src'

/** The client module's id, as pages import it. The plugin resolves it to a virtual module. */
export const CLIENT_MODULE = 'design-in-browser:client'

declare const __PAGE_BUILD__: string

/**
 * The build of the page client and the Vite plugin, which ship together. A dev server that kept an older plugin in
 * memory (the package was updated, or relinked, while it ran) serves the newer client from disk: the two then differ,
 * and the page asks for a restart. Run from source, as the tests do, there is no build to tell apart.
 */
export const PAGE_BUILD = typeof __PAGE_BUILD__ === 'string' ? __PAGE_BUILD__ : 'dev'

export type PageState = {
  /** The plugin's PAGE_BUILD. A plugin from before 0.7 sends none. */
  build: string
  /** Whether the plugin reaches the daemon. */
  connection: 'connected' | 'offline'
  /** The project this dev server belongs to; sessions and batches are matched against it. */
  projectRoot: string
  sessions: SessionInfo[]
  batches: Batch[]
  draft: DraftComment[]
  sending: boolean
  lastError: string | null
  /** The session the user picked in the dock, kept until that session ends. */
  pickedSessionId: string | null
  /** "Send to <agent>" in the comment card: send the whole stack as soon as a comment is added. */
  sendOnAdd: boolean
  /** Which version each `<Variants>` group shows, by group id; kept so reloads and other tabs show the same one. */
  variantChoices: Record<string, number>
  /** Tweak values the user set, by `versionKey(group, index)` then tweak id. */
  tweakValues: Record<string, Record<string, TweakValue>>
  /** The agent's questions and notes the user dismissed without answering, by comment id: they lose their pin. */
  dismissed: string[]
}

/** The key of one version of a `<Variants>` group, for its tweak values. */
export const versionKey = (group: string, index: number) => `${group}#${index}`

export type PageOp =
  | { type: 'add-comment'; comment: DraftComment }
  | { type: 'update-comment'; id: string; text: string }
  | { type: 'remove-comment'; id: string }
  | { type: 'send'; sessionId: string }
  | { type: 'pick-session'; sessionId: string }
  | { type: 'set-send-on-add'; value: boolean }
  | { type: 'show-variant'; group: string; index: number }
  | { type: 'set-tweak'; group: string; index: number; id: string; value: TweakValue }
  | { type: 'dismiss'; commentId: string }

export type OpRequest = { id: string; op: PageOp }
export type OpAck = { id: string; ok: true } | { id: string; ok: false; error: string }

/** The comments a send takes: the stack, less any left empty. */
export const sendable = (draft: DraftComment[]) => draft.filter((comment) => comment.text.trim() !== '')

/** True when one project root contains the other, or they are the same folder. */
export function sameProject(a: string, b: string): boolean {
  const trim = (value: string) => value.replace(/[\\/]+$/, '')
  const [left, right] = [trim(a), trim(b)]
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)
}

/**
 * The session comments from this page go to: the one the user picked while it is alive, else the newest
 * session working on this project. Null when no session matches: the dock then asks the user to pick,
 * and nothing is routed by guesswork.
 */
export function defaultSession(state: PageState): SessionInfo | null {
  const picked = state.sessions.find((session) => session.id === state.pickedSessionId)
  if (picked) return picked
  return (
    state.sessions
      .filter((session) => sameProject(session.projectRoot, state.projectRoot))
      .sort((a, b) => b.connectedAt.localeCompare(a.connectedAt))[0] ?? null
  )
}
