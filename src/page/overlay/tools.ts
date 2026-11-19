// The tool pill at the bottom while picking (comment tool, comment count, "Ask <agent>", Done) and the Ask bar,
// which adds a note about the whole page.
import { capturePage } from '../capture.ts'
import { newComment } from '../comments.ts'
import { addComment, agentName, readState } from '../store.ts'
import { query } from '../ui/dom.ts'
import { keepKeys } from '../ui/events.ts'
import { plural } from '../ui/format.ts'
import { getMode, onModeChange, setMode } from './mode.ts'
import { root } from './root.ts'

const toolbar = query<HTMLDivElement>(root, '.toolbar')
const askbar = query<HTMLFormElement>(root, '.askbar')
const askInput = query<HTMLInputElement>(root, '.askbar input')
const askButton = query<HTMLButtonElement>(root, '.tool.ask')
const count = query<HTMLSpanElement>(root, '.tools-count')

export const isAskbarOpen = () => !askbar.hidden

function openAskbar(): void {
  if (getMode().kind === 'idle') setMode({ kind: 'picking' })
  askbar.hidden = false
  askButton.setAttribute('aria-pressed', 'true')
  askInput.focus()
}

export function closeAskbar(): void {
  askbar.hidden = true
  askInput.value = ''
  askButton.setAttribute('aria-pressed', 'false')
}

export function renderTools(): void {
  const draft = readState().draft.length
  const counted = draft === 0 ? '' : plural(draft, 'comment', 'comments')
  if (count.textContent !== counted) count.textContent = counted
  const ask = `Ask ${agentName()}`
  if (askButton.textContent !== ask) askButton.textContent = ask
}

askButton.addEventListener('click', () => (askbar.hidden ? openAskbar() : closeAskbar()))
query<HTMLButtonElement>(root, '.done-tool').addEventListener('click', () => setMode({ kind: 'idle' }))
query<HTMLButtonElement>(root, '.pick-tool').addEventListener('click', closeAskbar)
askbar.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = askInput.value.trim()
  if (text === '') return
  closeAskbar()
  try {
    await addComment(newComment({ text, page: capturePage(), element: null }), false)
  } catch {
    openAskbar()
    askInput.value = text
  }
})
keepKeys(askbar)

onModeChange((mode) => {
  toolbar.hidden = mode.kind === 'idle'
  if (mode.kind !== 'picking') closeAskbar()
})
