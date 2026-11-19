// Extension state lives in chrome.storage.local. Only the service worker writes
// `draft`, `batches`, `sessions`, `connection` and `lastError`; pages read and listen.
import type { Batch, DraftComment, SessionInfo } from '../shared/protocol.ts'
import { DEFAULT_PORT } from '../shared/protocol.ts'

export type Connection = 'connected' | 'offline'

export type ExtensionState = {
  port: number
  connection: Connection
  sessions: SessionInfo[]
  draft: DraftComment[]
  batches: Batch[]
  sending: boolean
  lastError: string | null
  /** The session the user picked in the side panel, per page origin (see pickKey). */
  pickedSessions: Record<string, string>
}

export const initialState: ExtensionState = {
  port: DEFAULT_PORT,
  connection: 'offline',
  sessions: [],
  draft: [],
  batches: [],
  sending: false,
  lastError: null,
  pickedSessions: {},
}

export async function readState(): Promise<ExtensionState> {
  // Passing the defaults returns them for keys that were never written.
  return chrome.storage.local.get<ExtensionState>(initialState)
}

export function writeState(patch: Partial<ExtensionState>): Promise<void> {
  return chrome.storage.local.set(patch)
}

export function onStateChange(listener: () => void): void {
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'local') listener()
  })
}

/** Messages to the service worker. */
export type BackgroundMessage =
  | { type: 'add-comment'; comment: DraftComment }
  | { type: 'update-comment'; id: string; text: string }
  | { type: 'remove-comment'; id: string }
  | { type: 'send'; sessionId: string }
  | { type: 'reconnect' }

/** Messages to a content script. */
export type ContentMessage = { type: 'toggle-picker' } | { type: 'page-note' } | { type: 'ping' }

/** Rejects when the worker reports a failure, or when this page's extension context is gone (the extension was reloaded). */
export async function sendToBackground(message: BackgroundMessage): Promise<void> {
  const reply = (await chrome.runtime.sendMessage(message)) as { ok: boolean; error?: string } | undefined
  if (reply?.ok === false) throw new Error(reply.error ?? 'The extension could not save that.')
}

function originOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).origin : null
  } catch {
    return null
  }
}

/** Picks are stored per origin; tabs whose URL the extension can't read share one key. */
export const pickKey = (tabUrl: string | undefined) => originOf(tabUrl) ?? '*'

/** The session for a tab: the one the user picked for its origin, else one that claims the origin, else the first. */
export function defaultSession(state: ExtensionState, tabUrl: string | undefined): SessionInfo | null {
  const origin = originOf(tabUrl)
  const picked = state.pickedSessions[pickKey(tabUrl)]
  return (
    state.sessions.find((session) => session.id === picked) ??
    state.sessions.find((session) => origin !== null && session.origins.includes(origin)) ??
    state.sessions[0] ??
    null
  )
}
