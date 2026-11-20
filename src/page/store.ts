// The page's view of the plugin's state, kept current over Vite's HMR socket.
// Operations go to the plugin and resolve on its ack. Vite drops a send while its socket is down without
// telling the caller, so every operation has its own timeout: a failed save must surface, not vanish.
import { defaultSession, PAGE_BUILD, PAGE_EVENT, type OpAck, type OpRequest, type PageOp, type PageState } from '../shared/page-protocol.ts'
import { FALLBACK_AGENT, START_COMMAND, type DraftComment, type SessionInfo } from '../shared/protocol.ts'

export { defaultSession } from '../shared/page-protocol.ts'
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
  sending: false,
  lastError: null,
  pickedSessionId: null,
  variantChoices: {},
  tweakValues: {},
  dismissed: [],
  cleared: null,
}

let current: PageState = initial
const listeners = new Set<() => void>()
const waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

/** What a plugin from an older build leaves out, so this page still renders while it asks for a restart. */
const olderPlugin: Pick<PageState, 'build' | 'dismissed' | 'cleared'> = { build: 'older', dismissed: [], cleared: null }

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

const DEV_SERVER_DOWN = 'The dev server isn’t running. Start it again, then send.'

/**
 * False while Vite's socket to the dev server is down: a send then fails at once instead of waiting it out, and so
 * does every operation already waiting for an answer that can no longer come.
 */
let devServerUp = true
hot.on('vite:ws:disconnect', () => {
  devServerUp = false
  for (const [id, entry] of waiting) {
    clearTimeout(entry.timer)
    waiting.delete(id)
    entry.reject(new Error(DEV_SERVER_DOWN))
  }
})
hot.on('vite:ws:connect', () => (devServerUp = true))

export function readState(): PageState {
  return current
}

export function onStateChange(listener: () => void): void {
  listeners.add(listener)
}

/** Sends one operation to the plugin. Rejects on the plugin's error or when no ack comes back in time. */
export function sendOp(op: PageOp, timeoutMs = OP_TIMEOUT_MS): Promise<void> {
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error('The dev server did not answer.'))
    }, timeoutMs)
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

/** A send waits for the daemon to take the comment, and a screenshot can make it large: longer than other ops. */
const SEND_TIMEOUT_MS = 15_000

/**
 * Sends one comment to the agent session now, as its own batch. Resolves once the daemon has it; rejects with what
 * to do otherwise (no session, an older dev server, a lost connection), so the caller keeps the text and says why.
 */
/** The session a comment goes to now, or why none can take it. */
export function sendTarget(): { session: SessionInfo } | { blocked: string } {
  if (!devServerUp) return { blocked: DEV_SERVER_DOWN }
  if (pluginOutdated()) return { blocked: 'This dev server still runs an older design-in-browser. Restart it, then send again.' }
  const session = connectedSession()
  if (!session)
    return { blocked: `No agent session is connected to send to. Connect one (in Claude Code: ${START_COMMAND}), then send again.` }
  return { session }
}

export async function sendComment(comment: DraftComment): Promise<void> {
  const target = sendTarget()
  if ('blocked' in target) throw new Error(target.blocked)
  await sendOp({ type: 'send-comment', sessionId: target.session.id, comment }, SEND_TIMEOUT_MS)
}
