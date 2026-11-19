// The page's view of the plugin's state, kept current over Vite's HMR socket.
// Operations go to the plugin and resolve on its ack. Vite drops a send while its socket is down without
// telling the caller, so every operation has its own timeout: a failed save must surface, not vanish.
import { PAGE_EVENT, type OpAck, type OpRequest, type PageOp, type PageState } from '../shared/page-protocol.ts'

export { defaultSession } from '../shared/page-protocol.ts'
export type { PageState } from '../shared/page-protocol.ts'

const OP_TIMEOUT_MS = 4000

function noHmr(): never {
  throw new Error('design-in-browser needs Vite’s dev server with HMR on.')
}
const hot = import.meta.hot ?? noHmr()

const initial: PageState = {
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
}

let current: PageState = initial
const listeners = new Set<() => void>()
const waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

hot.on(PAGE_EVENT.state, (state: PageState) => {
  current = state
  for (const listener of listeners) listener()
})

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
