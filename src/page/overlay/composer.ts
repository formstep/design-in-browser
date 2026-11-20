// The comment card: opens beside a pin at the clicked point, takes a comment or a request for alternatives,
// and sends it to the agent on Enter.
import type { Mark } from '../../shared/protocol.ts'
import { captureElement, capturePage, visibleText } from '../capture.ts'
import { newComment } from '../comments.ts'
import { agentName, sendComment, sendTarget } from '../store.ts'
import { query } from '../ui/dom.ts'
import { elementName } from '../ui/format.ts'
import { keepKeys, submitOnEnter } from '../ui/events.ts'
import { clamp, pointOn } from '../ui/geometry.ts'
import { usableWidth } from '../ui/layout.ts'
import { shownVersionOf } from '../variants/switcher.ts'
import { boundsOf, cornerOf, toWindow } from './marks.ts'
import { getMode, onModeChange, setMode, type Mode } from './mode.ts'
import { onPick, showHighlight } from './picker.ts'
import { CARD_WIDTH, PIN, root } from './root.ts'
import { captureArea, renderArea, type Area } from './screenshot.ts'

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
const shotRow = query<HTMLLabelElement>(root, '.shot-check')
const attachShot = query<HTMLInputElement>(root, '.attach-shot')
const hint = query<HTMLSpanElement>(root, '.hint')

/** A comment in words, or a request for alternatives of the element. The count persists between cards. */
let request: Request = 'comment'
let alternativeCount = 2
let namedAgent = ''

function setRequest(next: Request): void {
  request = next
  for (const tab of root.querySelectorAll<HTMLButtonElement>('.mode')) tab.setAttribute('aria-selected', String(tab.dataset.mode === next))
  countRow.hidden = next !== 'alternatives'
  for (const choice of countRow.querySelectorAll<HTMLButtonElement>('.choice'))
    choice.setAttribute('aria-pressed', String(Number(choice.dataset.count) === alternativeCount))
  countLabel.textContent = alternativeCount === 1 ? 'How many · shown as before / after' : 'How many'
  textarea.placeholder = next === 'alternatives' ? 'What should they try? (optional)' : ''
  placeComposer()
}

function updateHint(): void {
  const key = document.createElement('kbd')
  key.textContent = 'Enter'
  hint.replaceChildren(key, ' to send')
}

function showTarget(element: Element): void {
  const text = document.createElement('span')
  text.className = 'target-text'
  text.textContent = elementName({
    tag: element.localName,
    id: element.id || null,
    classes: [...element.classList],
    text: visibleText(element).slice(0, 60),
  })
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
  attachShot.checked = false
  updateHint()
  // The new comment's pin, empty until it is sent and the agent's status shows in it.
  composingDisc.textContent = ''
  composer.hidden = false
  composingPin.hidden = false
  renderComposer()
  textarea.focus()
}

/** Closes the card: back to picking, or out when the card was opened from outside picking. */
export function leaveComposer(): void {
  const mode = getMode()
  if (mode.kind !== 'commenting') return
  setMode(mode.after)
}

/** Puts the pin on the clicked point and the card beside it, on the side with room. */
export function placeComposer(): void {
  const mode = getMode()
  if (mode.kind !== 'commenting') return
  // A drawing's card sits at the top-right of its marks; a comment's at the clicked point.
  const point = mode.marks.length > 0 ? cornerOf(mode.marks) : pointOn(mode.element, mode.offset)
  if (!point) return
  composingPin.style.transform = `translate(${point.x}px, ${point.y - PIN}px)`
  const height = composer.offsetHeight || 140
  const right = point.x + PIN + 8
  const left = right + CARD_WIDTH > usableWidth() - 8 ? Math.max(8, point.x - CARD_WIDTH - 8) : right
  const top = clamp(point.y - PIN, 8, innerHeight - height - 8)
  composer.style.transform = `translate(${left}px, ${top}px)`
}

/** The marks' bounds with a margin around them, clipped to the window: what a screenshot shows. */
function shotArea(marks: Mark[]): Area {
  const bounds = boundsOf(marks)
  const topLeft = toWindow({ x: bounds.left - 32, y: bounds.top - 32 })
  const bottomRight = toWindow({ x: bounds.right + 32, y: bounds.bottom + 32 })
  const left = clamp(topLeft.x, 0, innerWidth)
  const top = clamp(topLeft.y, 0, innerHeight)
  return { left, top, width: clamp(bottomRight.x, 0, innerWidth) - left, height: clamp(bottomRight.y, 0, innerHeight) - top }
}

/** A screenshot of the marked area: drawn from the page without asking, else through the browser's share prompt. */
async function screenshotOf(marks: Mark[]): Promise<string> {
  const area = shotArea(marks)
  try {
    return await renderArea(area, marks)
  } catch (error) {
    console.warn('[design-in-browser] Couldn’t draw the screenshot from the page, so asking to share the tab.', error)
    return await captureArea(area, [composer, composingPin, query<HTMLElement>(root, '.toolbar')])
  }
}

/** Why there's no screenshot, from the share prompt's error, and the way out. */
function noScreenshot(error: unknown): string {
  const declined = error instanceof DOMException && error.name === 'NotAllowedError'
  const why = declined ? 'The tab wasn’t shared, so there’s no screenshot.' : 'Couldn’t take a screenshot of this area.'
  return `${why} Untick "Attach a screenshot" to send the comment without one.`
}

/** Names the agent on the card, fits the textarea's indent to the "@<agent>" chip, and follows the element. */
export function renderComposer(): void {
  const mode = getMode()
  if (mode.kind === 'commenting' && mode.marks.length === 0) showHighlight(mode.element, true)
  const agent = agentName()
  shotRow.hidden = mode.kind !== 'commenting' || mode.marks.length === 0
  if (agent !== namedAgent) {
    namedAgent = agent
    chip.textContent = `@${agent}`
    textarea.setAttribute('aria-label', `Comment for ${agent}`)
  }
  if (!composer.hidden) textarea.style.textIndent = `${chip.offsetWidth + 7}px`
  placeComposer()
}

/** True while a screenshot is taken, so a second Enter doesn't add the comment twice. */
let capturing = false

async function submit(): Promise<void> {
  const mode = getMode()
  if (mode.kind !== 'commenting' || capturing) return
  const typed = textarea.value.trim()
  const asking = request === 'alternatives'
  if (typed === '' && !asking) {
    textarea.focus()
    return
  }
  const { element, offset, marks, after } = mode
  // Said before the screenshot: no share prompt for a comment that can't go anywhere.
  const target = sendTarget()
  if ('blocked' in target) {
    showError(target.blocked)
    return
  }
  let screenshot: string | undefined
  if (marks.length > 0 && attachShot.checked) {
    capturing = true
    composer.setAttribute('aria-busy', 'true')
    hint.textContent = 'Taking a screenshot…'
    try {
      screenshot = await screenshotOf(marks)
    } catch (error) {
      showError(noScreenshot(error))
      return
    } finally {
      capturing = false
      composer.removeAttribute('aria-busy')
      updateHint()
    }
    // Esc, or another mark, while the screenshot was taken: the card is left as the user has it now.
    if (getMode() !== mode) return
  }
  const comment = newComment({
    text: typed || (alternativeCount === 1 ? 'An alternative for this' : `${alternativeCount} alternatives for this`),
    page: capturePage(),
    element: { ...captureElement(element), clickOffset: { x: Math.round(offset.x), y: Math.round(offset.y) } },
    ...(asking ? { intent: { kind: 'alternatives', count: alternativeCount } } : {}),
    // Made on one version of a group: the agent gets which version, and its tweaks as the user left them.
    variant: shownVersionOf(element),
    ...(marks.length > 0 ? { marks } : {}),
    ...(screenshot ? { screenshot } : {}),
  })
  // Leave first: an Esc pressed while the send is in flight must find the mode already moved on.
  leaveComposer()
  try {
    await sendComment(comment)
  } catch (error) {
    // No session, an older dev server, or a lost connection: the card comes back with the text, and says why.
    openComposer({ element, offset, marks, after })
    setRequest(asking ? 'alternatives' : 'comment')
    textarea.value = typed
    showError(error instanceof Error ? error.message : String(error))
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
keepKeys(composer)

onPick(({ element, offset }) => {
  // While commenting, a click elsewhere moves an empty card; typed text is never thrown away.
  if (getMode().kind === 'commenting' && textarea.value.trim() !== '') return
  openComposer({ element, offset, marks: [], after: { kind: 'picking' } })
})

onModeChange((mode) => {
  if (mode.kind === 'commenting') return
  composer.hidden = true
  composingPin.hidden = true
})
