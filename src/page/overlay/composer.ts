// The comment card: opens beside a pin at the clicked point, takes a comment or a request for alternatives,
// and adds it to the stack (or sends it, with "Send to <agent>" ticked).
import { START_COMMAND } from '../../shared/protocol.ts'
import { captureElement, capturePage, label } from '../capture.ts'
import { newComment } from '../comments.ts'
import { addComment, agentName, connectedSession, readState, sendOp } from '../store.ts'
import { query } from '../ui/dom.ts'
import { keepKeys, submitOnEnter } from '../ui/events.ts'
import { clamp, pointOn } from '../ui/geometry.ts'
import { usableWidth } from '../ui/layout.ts'
import { shownVersionOf } from '../variants/switcher.ts'
import { getMode, onModeChange, setMode, type Mode } from './mode.ts'
import { onPick, showHighlight } from './picker.ts'
import { CARD_WIDTH, PIN, root } from './root.ts'

type Commenting = Extract<Mode, { kind: 'commenting' }>
type Request = 'comment' | 'alternatives'

const composer = query<HTMLFormElement>(root, '.composer')
const composingPin = query<HTMLDivElement>(root, '.composing')
const composingDisc = query<HTMLSpanElement>(root, '.composing .disc')
const target = query<HTMLParagraphElement>(root, '.target')
const chip = query<HTMLSpanElement>(root, '.chip')
const textarea = query<HTMLTextAreaElement>(root, '.composer textarea')
const countRow = query<HTMLDivElement>(root, '.count-row')
const countLabel = query<HTMLSpanElement>(root, '.count-label')
const errorLine = query<HTMLParagraphElement>(root, '.composer-error')
const sendOnAdd = query<HTMLInputElement>(root, '.send-on-add')
const checkText = query<HTMLSpanElement>(root, '.check-text')
const hint = query<HTMLSpanElement>(root, '.hint')

/** A comment in words, or a request for alternatives of the element. The count persists between cards. */
let request: Request = 'comment'
let alternativeCount = 2
let namedAgent = ''

function setRequest(next: Request): void {
  request = next
  for (const tab of root.querySelectorAll<HTMLButtonElement>('.mode')) tab.setAttribute('aria-selected', String(tab.dataset.mode === next))
  countRow.hidden = next !== 'alternatives'
  for (const choice of countRow.querySelectorAll<HTMLButtonElement>('.choice')) choice.setAttribute('aria-pressed', String(Number(choice.dataset.count) === alternativeCount))
  countLabel.textContent = alternativeCount === 1 ? 'How many · shown as before / after' : 'How many'
  textarea.placeholder = next === 'alternatives' ? 'What should they try? (optional)' : ''
  placeComposer()
}

function updateHint(): void {
  const key = document.createElement('kbd')
  key.textContent = 'Enter'
  hint.replaceChildren(key, sendOnAdd.checked ? ' to send' : ' to add')
}

function showTarget(element: Element): void {
  const text = document.createElement('span')
  text.className = 'target-text'
  const snippet = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  text.textContent = snippet ? `${label(element)} · “${snippet}”` : label(element)
  target.replaceChildren(text)
}

function showError(message: string): void {
  errorLine.textContent = message
  errorLine.hidden = false
  placeComposer()
}

export function openComposer(next: Omit<Commenting, 'kind'>): void {
  setMode({ kind: 'commenting', ...next })
  showTarget(next.element)
  errorLine.hidden = true
  setRequest('comment')
  textarea.value = ''
  sendOnAdd.checked = readState().sendOnAdd
  updateHint()
  composingDisc.textContent = String(readState().draft.length + 1)
  composer.hidden = false
  composingPin.hidden = false
  renderComposer()
  textarea.focus()
}

/** Closes the card: back to picking, or out when the card was opened from outside picking. */
export function leaveComposer(): void {
  const mode = getMode()
  if (mode.kind !== 'commenting') return
  setMode(mode.after === 'idle' ? { kind: 'idle' } : { kind: 'picking' })
}

/** Puts the pin on the clicked point and the card beside it, on the side with room. */
export function placeComposer(): void {
  const mode = getMode()
  if (mode.kind !== 'commenting') return
  const point = pointOn(mode.element, mode.offset)
  if (!point) return
  composingPin.style.transform = `translate(${point.x}px, ${point.y - PIN}px)`
  const height = composer.offsetHeight || 140
  const right = point.x + PIN + 8
  const left = right + CARD_WIDTH > usableWidth() - 8 ? Math.max(8, point.x - CARD_WIDTH - 8) : right
  const top = clamp(point.y - PIN, 8, innerHeight - height - 8)
  composer.style.transform = `translate(${left}px, ${top}px)`
}

/** Names the agent on the card, fits the textarea's indent to the "@<agent>" chip, and follows the element. */
export function renderComposer(): void {
  const mode = getMode()
  if (mode.kind === 'commenting') showHighlight(mode.element, true)
  const agent = agentName()
  if (agent !== namedAgent) {
    namedAgent = agent
    chip.textContent = `@${agent}`
    checkText.textContent = `Send to ${agent}`
    textarea.setAttribute('aria-label', `Comment for ${agent}`)
  }
  if (!composer.hidden) textarea.style.textIndent = `${chip.offsetWidth + 7}px`
  placeComposer()
}

async function submit(): Promise<void> {
  const mode = getMode()
  if (mode.kind !== 'commenting') return
  const typed = textarea.value.trim()
  const asking = request === 'alternatives'
  if (typed === '' && !asking) {
    textarea.focus()
    return
  }
  const send = sendOnAdd.checked
  if (send && !connectedSession()) {
    showError(`No agent session is connected to send to. Untick the box to keep it with your comments, or connect a session (in Claude Code: ${START_COMMAND}).`)
    return
  }
  const { element, offset, after } = mode
  const comment = newComment({
    text: typed || (alternativeCount === 1 ? 'An alternative for this' : `${alternativeCount} alternatives for this`),
    page: capturePage(),
    element: { ...captureElement(element), clickOffset: { x: Math.round(offset.x), y: Math.round(offset.y) } },
    ...(asking ? { intent: { kind: 'alternatives', count: alternativeCount } } : {}),
    // Made on one version of a group: the agent gets which version, and its tweaks as the user left them.
    variant: shownVersionOf(element),
  })
  // Leave first: an Esc pressed while the save is in flight must find the mode already moved on.
  leaveComposer()
  try {
    await addComment(comment, send)
  } catch {
    // Most often the dev server stopped or restarted. Keep the text.
    openComposer({ element, offset, after })
    setRequest(asking ? 'alternatives' : 'comment')
    textarea.value = typed
    showError('Couldn’t save this comment. Copy your text, reload the tab, and add it again.')
  }
}

composer.addEventListener('click', (event) => {
  const clicked = event.target as HTMLElement
  const tab = clicked.closest<HTMLButtonElement>('.mode')
  if (tab) {
    setRequest(tab.dataset.mode === 'alternatives' ? 'alternatives' : 'comment')
    textarea.focus()
    return
  }
  const choice = clicked.closest<HTMLButtonElement>('[data-count]')
  if (choice) {
    alternativeCount = Number(choice.dataset.count)
    setRequest('alternatives')
    textarea.focus()
  }
})
composer.addEventListener('submit', (event) => {
  event.preventDefault()
  void submit()
})
submitOnEnter(textarea, () => void submit())
textarea.addEventListener('input', placeComposer)
sendOnAdd.addEventListener('change', () => {
  updateHint()
  void sendOp({ type: 'set-send-on-add', value: sendOnAdd.checked })
})
keepKeys(composer)

onPick(({ element, offset }) => {
  // While commenting, a click elsewhere moves an empty card; typed text is never thrown away.
  if (getMode().kind === 'commenting' && textarea.value.trim() !== '') return
  openComposer({ element, offset, after: 'picking' })
})

onModeChange((mode) => {
  if (mode.kind === 'commenting') return
  composer.hidden = true
  composingPin.hidden = true
})
