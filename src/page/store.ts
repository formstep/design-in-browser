// The page's view of the plugin's state, kept current over Vite's HMR socket.
// Operations go to the plugin and resolve on its ack. Vite drops a send while its socket is down without
// telling the caller, so every operation has its own timeout: a failed save must surface, not vanish.
import { defaultSession, PAGE_BUILD, PAGE_EVENT, type OpAck, type OpRequest, type PageOp, type PageState } from '../shared/page-protocol.ts'
import { FALLBACK_AGENT, type DraftComment, type SessionInfo } from '../shared/protocol.ts'

export { defaultSession, sendable } from '../shared/page-protocol.ts'
export type { PageState } from '../shared/page-protocol.ts'

const OP_TIMEOUT_MS = 4000

function noHmr(): never {
  throw new Error('design-in-browser needs Vite’s dev server with HMR on.')
}
const hot = import.meta.hot ?? noHmr()

const initial: PageState = {
  build: PAGE_BUILD,
  connection: 'offline',
  projectRoot: '',
  sessions: [],
  batches: [],
  draft: [],
  sending: false,
  lastError: null,
  pickedSessionId: null,
  sendOnAdd: false,
  variantChoices: {},
  tweakValues: {},
  dismissed: [],
}

let current: PageState = initial
const listeners = new Set<() => void>()
const waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

/** What a plugin from an older build leaves out, so this page still renders while it asks for a restart. */
const olderPlugin: Pick<PageState, 'build' | 'dismissed'> = { build: 'older', dismissed: [] }

hot.on(PAGE_EVENT.state, (state: Partial<PageState>) => {
  current = { ...initial, ...olderPlugin, ...state }
  for (const listener of listeners) listener()
})

/** True when the dev server runs another build of the plugin than this page's: it needs a restart. */
export const pluginOutdated = () => current.build !== PAGE_BUILD

hot.on(PAGE_EVENT.ack, (ack: OpAck) => {
  const entry = waiting.get(ack.id)
  if (!entry) return
  waiting.delete(ack.id)
  clearTimeout(entry.timer)
  if (ack.ok) entry.resolve()
  else entry.reject(new Error(ack.error))
})

hot.send(PAGE_EVENT.hello, {})

export function readState(): PageState {
  return current
}

export function onStateChange(listener: () => void): void {
  listeners.add(listener)
}

/** Sends one operation to the plugin. Rejects on the plugin's error or when no ack comes back in time. */
export function sendOp(op: PageOp): Promise<void> {
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error('The dev server did not answer.'))
    }, OP_TIMEOUT_MS)
    waiting.set(id, { resolve, reject, timer })
    try {
      hot.send(PAGE_EVENT.op, { id, op } satisfies OpRequest)
    } catch (error) {
      clearTimeout(timer)
      waiting.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** The agent this page talks to, as the UI names it: "Claude", "OpenCode", or "Agent" when none is connected. */
export function agentName(state: PageState = current): string {
  return defaultSession(state)?.agent ?? FALLBACK_AGENT
}

/** The session a send would reach now: none while the plugin is offline. */
export function connectedSession(state: PageState = current): SessionInfo | null {
  return state.connection === 'connected' ? defaultSession(state) : null
}

/** Adds a comment to the stack and, with `send`, sends the stack when a session is connected. */
export async function addComment(comment: DraftComment, send: boolean): Promise<void> {
  await sendOp({ type: 'add-comment', comment })
  const session = connectedSession()
  if (send && session) await sendOp({ type: 'send', sessionId: session.id })
}
