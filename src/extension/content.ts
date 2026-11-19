// Page overlay: element picker, comment popover and pins.
// Everything renders inside one shadow root so page CSS can't reach it and it can't reach the page.
// Page text and comment text only ever go in through textContent, never innerHTML.
import type { Batch, BatchComment, CommentStatus, DraftComment, ElementRef, InReplyTo, PageRef } from '../shared/protocol.ts'
import { captureElement, capturePage, label, samePage } from './capture.ts'
import { fillIcons, icon } from './icons.ts'
import overlayCss from './overlay.css'
import { defaultSession, onStateChange, readState, sendToBackground, type ContentMessage, type ExtensionState } from './state.ts'
import tokensCss from './tokens.css'

const host = document.createElement('dib-overlay')
host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;'
const root = host.attachShadow({ mode: 'open' })
// A constructed sheet, not a <style> element, so a page CSP without 'unsafe-inline' can't block it.
const sheet = new CSSStyleSheet()
sheet.replaceSync(tokensCss + overlayCss)
root.adoptedStyleSheets = [sheet]
root.innerHTML = `
<div class="highlight" hidden><span class="tag"><span class="tag-label"></span><span class="tag-size"></span></span></div>
<div class="pins"></div>
<form class="popover" hidden>
  <p class="target"></p>
  <div class="asked" hidden><p class="asked-label">Claude asked</p><p class="asked-text"></p></div>
  <textarea rows="2" placeholder="What should change?" aria-label="Comment"></textarea>
  <p class="popover-error" role="alert" hidden></p>
  <div class="row">
    <span class="hint"><kbd>Enter</kbd> to add</span>
    <button type="button" class="button cancel">Cancel</button>
    <button type="submit" class="button primary add">Add</button>
  </div>
</form>
<div class="banner" role="status" hidden>
  <span class="banner-dot"></span>
  <span>Click an element to comment</span>
  <span class="banner-count"></span>
  <button type="button" class="banner-stop"><kbd>Esc</kbd>Stop</button>
</div>`
fillIcons(root)
document.documentElement.append(host)

const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T
const highlight = $<HTMLDivElement>('.highlight')
const tagLabel = $<HTMLSpanElement>('.tag-label')
const tagSize = $<HTMLSpanElement>('.tag-size')
const pins = $<HTMLDivElement>('.pins')
const popover = $<HTMLFormElement>('.popover')
const popoverTarget = $<HTMLParagraphElement>('.target')
const asked = $<HTMLDivElement>('.asked')
const askedText = $<HTMLParagraphElement>('.asked-text')
const textarea = $<HTMLTextAreaElement>('textarea')
const addButton = $<HTMLButtonElement>('.add')
const popoverError = $<HTMLParagraphElement>('.popover-error')
const banner = $<HTMLDivElement>('.banner')
const bannerCount = $<HTMLSpanElement>('.banner-count')

/** What an answer carries over from the comment it answers. */
type Answering = { inReplyTo: InReplyTo; element: ElementRef | null; page: PageRef }

type Mode =
  | { kind: 'idle' }
  | { kind: 'picking' }
  | { kind: 'commenting'; element: Element | null; answering: Answering | null; then: 'picking' | 'idle' }

let mode: Mode = { kind: 'idle' }
let hovered: Element | null = null
let state: ExtensionState | null = null

// --- picking -------------------------------------------------------------------

function elementAt(x: number, y: number): Element | null {
  const element = document.elementFromPoint(x, y)
  return element && element !== host && element !== document.documentElement ? element : null
}

function showHighlight(element: Element | null): void {
  const box = element?.getBoundingClientRect()
  if (!element || !box) {
    highlight.hidden = true
    return
  }
  highlight.hidden = false
  highlight.classList.toggle('below', box.top < 26)
  highlight.style.transform = `translate(${box.left}px, ${box.top}px)`
  highlight.style.width = `${box.width}px`
  highlight.style.height = `${box.height}px`
  tagLabel.textContent = label(element)
  tagSize.textContent = `${Math.round(box.width)} × ${Math.round(box.height)}`
}

function setMode(next: Mode): void {
  mode = next
  banner.hidden = mode.kind !== 'picking'
  document.documentElement.style.cursor = mode.kind === 'picking' ? 'crosshair' : ''
  if (mode.kind !== 'commenting') popover.hidden = true
  if (mode.kind === 'idle') showHighlight(null)
}

const fromOverlay = (event: Event) => event.composedPath().includes(host)

function onPointerMove(event: MouseEvent): void {
  if (mode.kind !== 'picking') return
  hovered = elementAt(event.clientX, event.clientY)
  showHighlight(hovered)
}

/** While picking or commenting, the page must not see clicks: no navigation, no buttons firing. */
function swallow(event: Event): void {
  if (mode.kind === 'idle' || fromOverlay(event)) return
  event.preventDefault()
  event.stopImmediatePropagation()
}

function onClick(event: MouseEvent): void {
  if (!fromOverlay(event)) closeCards()
  if (mode.kind === 'idle' || fromOverlay(event)) return
  swallow(event)
  // While commenting, a click elsewhere moves an empty popover; typed text is never thrown away.
  if (mode.kind === 'commenting' && (textarea.value.trim() !== '' || mode.answering)) return
  const element = elementAt(event.clientX, event.clientY)
  if (element) openPopover({ element, answering: null, then: 'picking' })
}

for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick']) {
  window.addEventListener(type, swallow, true)
}
window.addEventListener('click', onClick, true)
window.addEventListener('mousemove', onPointerMove, true)

// --- popover ---------------------------------------------------------------------

function setTarget(element: Element | null, ref: ElementRef | null): void {
  const code = document.createElement('code')
  const text = document.createElement('span')
  text.className = 'target-text'
  if (element || ref) {
    code.textContent = element ? label(element) : ref!.tag
    const snippet = (element?.textContent ?? ref?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    text.textContent = snippet ? `“${snippet}”` : ''
  } else {
    code.textContent = 'Page'
    text.textContent = location.pathname
  }
  popoverTarget.replaceChildren(code, text)
}

function openPopover(next: { element: Element | null; answering: Answering | null; then: 'picking' | 'idle' }): void {
  setMode({ kind: 'commenting', ...next })
  banner.hidden = true
  closeCards()
  showHighlight(next.element)
  setTarget(next.element, next.answering?.element ?? null)
  asked.hidden = next.answering === null
  askedText.textContent = next.answering?.inReplyTo.question ?? ''
  textarea.placeholder = next.answering ? 'Your answer' : next.element ? 'What should change?' : 'What should change on this page?'
  textarea.setAttribute('aria-label', next.answering ? 'Answer' : 'Comment')
  addButton.textContent = next.answering ? 'Add answer' : 'Add'
  popoverError.hidden = true
  textarea.value = ''
  popover.hidden = false
  placePopover(next.element)
  textarea.focus()
}

function placePopover(element: Element | null): void {
  const width = popover.offsetWidth || 320
  const height = popover.offsetHeight || 150
  if (!element) {
    popover.style.transform = `translate(${Math.max(8, innerWidth / 2 - width / 2)}px, 64px)`
    return
  }
  const box = element.getBoundingClientRect()
  const below = box.bottom + 10
  const top = below + height < innerHeight - 8 ? below : Math.max(8, box.top - height - 10)
  const left = Math.min(Math.max(8, box.left), innerWidth - width - 8)
  popover.style.transform = `translate(${left}px, ${top}px)`
}

function leavePopover(): void {
  if (mode.kind !== 'commenting') return
  if (mode.then === 'idle') {
    setMode({ kind: 'idle' })
    return
  }
  setMode({ kind: 'picking' })
  showHighlight(hovered)
}

async function submitComment(): Promise<void> {
  if (mode.kind !== 'commenting') return
  const text = textarea.value.trim()
  if (text === '') {
    textarea.focus()
    return
  }
  const { element, answering, then } = mode
  const comment: DraftComment = {
    id: crypto.randomUUID(),
    text,
    page: answering?.page ?? capturePage(),
    element: element ? captureElement(element) : (answering?.element ?? null),
    inReplyTo: answering?.inReplyTo ?? null,
    createdAt: new Date().toISOString(),
  }
  // Leave first: an Esc pressed while the save is in flight must find the mode already moved on.
  leavePopover()
  try {
    await sendToBackground({ type: 'add-comment', comment })
  } catch {
    // Most often the extension was reloaded and this tab still runs the old overlay. Keep the text.
    openPopover({ element, answering, then })
    textarea.value = text
    popoverError.textContent = 'Couldn’t save this comment. Copy your text, reload the tab, and add it again.'
    popoverError.hidden = false
    placePopover(element)
  }
}

popover.addEventListener('submit', (event) => {
  event.preventDefault()
  void submitComment()
})
$<HTMLButtonElement>('.cancel').addEventListener('click', leavePopover)
textarea.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void submitComment()
  }
})
textarea.addEventListener('input', () => placePopover(mode.kind === 'commenting' ? mode.element : null))
// Keys typed into the popover belong to it, not to the app's shortcuts.
for (const type of ['keydown', 'keyup', 'keypress']) popover.addEventListener(type, (event) => event.stopPropagation())
$<HTMLButtonElement>('.banner-stop').addEventListener('click', () => setMode({ kind: 'idle' }))

// --- keyboard + messages --------------------------------------------------------

function togglePicker(): void {
  setMode(mode.kind === 'idle' ? { kind: 'picking' } : { kind: 'idle' })
}

window.addEventListener(
  'keydown',
  (event) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyC') {
      event.preventDefault()
      event.stopImmediatePropagation()
      togglePicker()
      return
    }
    if (event.key !== 'Escape') return
    if (mode.kind === 'idle') {
      closeCards()
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    if (mode.kind === 'commenting') leavePopover()
    else setMode({ kind: 'idle' })
  },
  true,
)

chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
  switch (message.type) {
    case 'toggle-picker':
      togglePicker()
      break
    case 'page-note':
      openPopover({ element: null, answering: null, then: 'idle' })
      break
    case 'ping':
      break
  }
  sendResponse({ ok: true, picking: mode.kind !== 'idle' })
})

// --- pins --------------------------------------------------------------------------

type PinStatus = 'draft' | CommentStatus | 'answered'

type PinModel = {
  key: string
  selector: string
  status: PinStatus
  number: number | null
  text: string
  reply: string | null
  /** Set when the pin can take an answer from here. */
  answer: Answering | null
  draftId: string | null
}

const statusLabel: Record<PinStatus, string> = {
  draft: 'Not sent yet',
  pending: 'Waiting for Claude',
  done: 'Done',
  question: 'Needs your answer',
  skipped: 'Skipped',
  answered: 'Answered, waiting for Claude',
}

function answeredIds(current: ExtensionState): Set<string> {
  const ids = new Set<string>()
  for (const comment of current.draft) if (comment.inReplyTo) ids.add(comment.inReplyTo.commentId)
  for (const batch of current.batches) for (const comment of batch.comments) if (comment.inReplyTo) ids.add(comment.inReplyTo.commentId)
  return ids
}

function sentPin(batch: Batch, comment: BatchComment, answered: Set<string>, ownProject: string | null): PinModel {
  const isOpenQuestion = comment.status === 'question' && !answered.has(comment.id)
  return {
    key: comment.id,
    selector: comment.element!.selector,
    status: comment.status === 'question' && answered.has(comment.id) ? 'answered' : comment.status,
    number: null,
    text: comment.text,
    reply: comment.reply,
    answer:
      isOpenQuestion && batch.projectRoot === ownProject
        ? {
            inReplyTo: { batchId: batch.id, commentId: comment.id, comment: comment.text, question: comment.reply ?? '' },
            element: comment.element,
            page: comment.page,
          }
        : null,
    draftId: null,
  }
}

function pinsForThisPage(current: ExtensionState): PinModel[] {
  const answered = answeredIds(current)
  const ownProject = defaultSession(current, location.href)?.projectRoot ?? null
  const drafts = current.draft.flatMap((comment, index): PinModel[] =>
    comment.element && samePage(comment.page.url)
      ? [
          {
            key: comment.id,
            selector: comment.element.selector,
            status: 'draft',
            number: index + 1,
            text: comment.text,
            reply: null,
            answer: null,
            draftId: comment.id,
          },
        ]
      : [],
  )
  const sent = current.batches.flatMap((batch) =>
    batch.comments.filter((comment) => comment.element && samePage(comment.page.url)).map((comment) => sentPin(batch, comment, answered, ownProject)),
  )
  return [...drafts, ...sent]
}

const pinGlyph: Record<Exclude<PinStatus, 'draft'>, string> = {
  pending: icon('clock'),
  done: icon('check'),
  question: icon('question'),
  skipped: icon('minus'),
  answered: icon('clock'),
}

function buildCard(pin: PinModel, card: HTMLElement): void {
  const status = document.createElement('p')
  status.className = 'card-status'
  status.textContent = pin.number === null ? statusLabel[pin.status] : `${pin.number} · ${statusLabel[pin.status]}`
  const text = document.createElement('p')
  text.className = 'card-text'
  text.textContent = pin.text
  const parts: HTMLElement[] = [status, text]
  if (pin.reply) {
    const reply = document.createElement('p')
    reply.className = 'card-reply'
    const who = document.createElement('b')
    who.textContent = 'Claude: '
    reply.append(who, pin.reply)
    parts.push(reply)
  }
  const actions = document.createElement('div')
  actions.className = 'card-actions'
  if (pin.draftId) actions.append(cardButton('Remove', 'remove', pin.key, false))
  if (pin.answer) actions.append(cardButton('Answer', 'answer', pin.key, true))
  parts.push(actions)
  card.replaceChildren(...parts)
}

function cardButton(text: string, action: string, key: string, primary: boolean): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = primary ? 'button primary' : 'button'
  button.textContent = text
  button.dataset.action = action
  button.dataset.key = key
  return button
}

function find(selector: string): Element | null {
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}

let models = new Map<string, PinModel>()

function renderPins(): void {
  if (!state) return
  const wanted = pinsForThisPage(state)
  models = new Map(wanted.map((pin) => [pin.key, pin]))
  for (const node of [...pins.children] as HTMLElement[]) if (!models.has(node.dataset.key ?? '')) node.remove()

  // Pins on the same element line up to the left of the first one.
  const perElement = new Map<Element, number>()
  for (const pin of wanted) {
    let wrap = pins.querySelector<HTMLElement>(`[data-key="${CSS.escape(pin.key)}"]`)
    if (!wrap) {
      wrap = document.createElement('div')
      wrap.className = 'pin-wrap'
      wrap.dataset.key = pin.key
      wrap.innerHTML = '<button type="button" class="pin"></button><div class="card" role="group"></div>'
      pins.append(wrap)
    }
    const signature = JSON.stringify([pin.status, pin.number, pin.text, pin.reply, pin.answer !== null])
    if (wrap.dataset.signature !== signature) {
      wrap.dataset.signature = signature
      wrap.dataset.status = pin.status
      const button = wrap.querySelector<HTMLButtonElement>('.pin')!
      if (pin.number === null) button.innerHTML = pinGlyph[pin.status as Exclude<PinStatus, 'draft'>]
      else button.textContent = String(pin.number)
      button.setAttribute('aria-label', `${statusLabel[pin.status]}: ${pin.text}`)
      buildCard(pin, wrap.querySelector<HTMLElement>('.card')!)
    }

    const element = find(pin.selector)
    const box = element?.getBoundingClientRect()
    if (!element || !box || (box.width === 0 && box.height === 0)) {
      wrap.hidden = true
      continue
    }
    const offset = perElement.get(element) ?? 0
    perElement.set(element, offset + 1)
    wrap.hidden = false
    const x = Math.min(Math.max(4, box.left - 24 - offset * 28), innerWidth - 28)
    const y = Math.min(Math.max(4, box.top - 24), innerHeight - 28)
    wrap.style.transform = `translate(${x}px, ${y}px)`
    wrap.classList.toggle('flip-x', x + 290 > innerWidth)
    wrap.classList.toggle('flip-y', y + 200 > innerHeight)
  }
}

function closeCards(except?: Element): void {
  for (const wrap of pins.querySelectorAll('.pin-wrap.open')) if (wrap !== except) wrap.classList.remove('open')
}

pins.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const pinButton = target.closest('.pin')
  if (pinButton) {
    const wrap = pinButton.parentElement!
    closeCards(wrap)
    wrap.classList.toggle('open')
    return
  }
  const action = target.closest<HTMLButtonElement>('[data-action]')
  const pin = action ? models.get(action.dataset.key ?? '') : undefined
  if (!action || !pin) return
  if (action.dataset.action === 'remove' && pin.draftId) {
    void sendToBackground({ type: 'remove-comment', id: pin.draftId })
    return
  }
  if (action.dataset.action === 'answer' && pin.answer) {
    openPopover({ element: find(pin.selector), answering: pin.answer, then: 'idle' })
  }
})

function draftCount(): string {
  const count = state?.draft.length ?? 0
  return count === 0 ? '' : `${count} ${count === 1 ? 'comment' : 'comments'}`
}

let frame = 0
function scheduleRender(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    renderPins()
    bannerCount.textContent = draftCount()
    if (mode.kind === 'commenting') {
      showHighlight(mode.element)
      placePopover(mode.element)
    }
  })
}

async function refresh(): Promise<void> {
  state = await readState()
  scheduleRender()
}

onStateChange(() => void refresh())
window.addEventListener('scroll', scheduleRender, { capture: true, passive: true })
window.addEventListener('resize', scheduleRender)
// Hot reloads and client-side routing move elements without a scroll or resize.
setInterval(scheduleRender, 800)
void refresh()
