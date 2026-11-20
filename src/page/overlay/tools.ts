// The tool pill at the bottom while picking (comment tool, comment count, "Ask <agent>", Done) and the Ask bar,
// which adds a note about the whole page.
import { capturePage } from '../capture.ts'
import { newComment } from '../comments.ts'
import { agentName, sendComment } from '../store.ts'
import { query } from '../ui/dom.ts'
import { keepKeys } from '../ui/events.ts'
import { startDrawing } from './drawing.ts'
import { getMode, onModeChange, setMode, type DrawTool } from './mode.ts'
import { root } from './root.ts'

const toolbar = query<HTMLDivElement>(root, '.toolbar')
const askbar = query<HTMLFormElement>(root, '.askbar')
const askInput = query<HTMLInputElement>(root, '.askbar input')
const askButton = query<HTMLButtonElement>(root, '.tool.ask')
const askError = query<HTMLParagraphElement>(root, '.ask-error')

export const isAskbarOpen = () => !askbar.hidden

function openAskbar(): void {
  if (getMode().kind === 'idle') setMode({ kind: 'picking' })
  askbar.hidden = false
  askButton.setAttribute('aria-pressed', 'true')
  askInput.focus()
}

export function closeAskbar(): void {
  askbar.hidden = true
  askError.hidden = true
  askInput.value = ''
  askButton.setAttribute('aria-pressed', 'false')
}

/** The tool in use: the comment tool while picking or commenting on an element, a drawing tool while drawing. */
function activeTool(): 'pick' | DrawTool | null {
  const mode = getMode()
  if (mode.kind === 'picking') return 'pick'
  if (mode.kind === 'drawing') return mode.tool
  if (mode.kind === 'commenting') return mode.after.kind === 'drawing' ? mode.after.tool : 'pick'
  return null
}

export function renderTools(): void {
  const active = activeTool()
  query(root, '.pick-tool').classList.toggle('active', active === 'pick')
  for (const button of root.querySelectorAll<HTMLButtonElement>('.draw-tool')) {
    button.classList.toggle('active', button.dataset.tool === active)
    button.setAttribute('aria-pressed', String(button.dataset.tool === active))
  }
  const ask = `Ask ${agentName()}`
  if (askButton.textContent !== ask) askButton.textContent = ask
}

askButton.addEventListener('click', () => (askbar.hidden ? openAskbar() : closeAskbar()))
query<HTMLButtonElement>(root, '.done-tool').addEventListener('click', () => setMode({ kind: 'idle' }))
query<HTMLButtonElement>(root, '.pick-tool').addEventListener('click', () => {
  closeAskbar()
  setMode({ kind: 'picking' })
})
for (const button of root.querySelectorAll<HTMLButtonElement>('.draw-tool')) {
  button.addEventListener('click', () => {
    closeAskbar()
    startDrawing(button.dataset.tool === 'arrow' ? 'arrow' : button.dataset.tool === 'pen' ? 'pen' : 'box')
  })
}
/** True while a note is on its way, so a second Enter doesn't send it twice. */
let asking = false

askbar.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = askInput.value.trim()
  if (text === '' || asking) return
  asking = true
  closeAskbar()
  try {
    await sendComment(newComment({ text, page: capturePage(), element: null }))
  } catch (error) {
    // The bar comes back with the text, and says why it wasn't sent; Enter tries again.
    openAskbar()
    askInput.value = text
    askError.textContent = error instanceof Error ? error.message : String(error)
    askError.hidden = false
  } finally {
    asking = false
  }
})
keepKeys(askbar)

onModeChange((mode) => {
  toolbar.hidden = mode.kind === 'idle'
  if (mode.kind !== 'picking') closeAskbar()
})
