// Page overlay (in the app's own page, served by the Vite plugin), modelled on Claude Design's canvas: hover outline, selected outline,
// a comment card beside a pin at the clicked point, pin threads with Claude's replies,
// and a bottom tool pill while picking.
// Everything renders inside one shadow root so page CSS can't reach it and it can't reach the page.
// Page text and comment text only ever go in through textContent, never innerHTML.
import type { Batch, BatchComment, CommentStatus, DraftComment, ElementRef, InReplyTo, PageRef } from '../shared/protocol.ts'
import { FALLBACK_AGENT, START_COMMAND } from '../shared/protocol.ts'
import { captureElement, capturePage, label, samePage } from './capture.ts'
import { fillIcons, icon } from './icons.ts'
import overlayCss from './overlay.css'
import { defaultSession, onStateChange, readState, sendOp, type PageState } from './store.ts'
import tokensCss from './tokens.css'
import { mountVariants, onGroupsChange, renderVariants, syncFromState, variantContextOf } from './variants-ui.ts'

const PIN = 32
const CARD_WIDTH = 300

const host = document.createElement('dib-overlay')
host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;'
const root = host.attachShadow({ mode: 'open' })
// A constructed sheet, not a <style> element, so a page CSP without 'unsafe-inline' can't block it.
const sheet = new CSSStyleSheet()
sheet.replaceSync(tokensCss + overlayCss)
root.adoptedStyleSheets = [sheet]
root.innerHTML = `
<div class="highlight" hidden>
  <span class="tag"><span class="tag-label"></span><span class="tag-size"></span></span>
</div>
<div class="pins"></div>
<div class="pin-wrap composing" hidden><span class="pin"><span class="disc"></span></span></div>
<form class="composer" hidden>
  <div class="modes" role="tablist" aria-label="What to ask for">
    <button type="button" class="mode" data-mode="comment" role="tab" aria-selected="true">Comment</button>
    <button type="button" class="mode" data-mode="alternatives" role="tab" aria-selected="false">Alternatives</button>
  </div>
  <p class="target"></p>
  <div class="field"><span class="chip"></span><textarea rows="1"></textarea></div>
  <div class="count-row" hidden>
    <span class="count-label">How many</span>
    <span class="choices" role="radiogroup" aria-label="How many alternatives">
      <button type="button" class="choice" data-count="1">1</button><button type="button" class="choice" data-count="2">2</button><button type="button" class="choice" data-count="3">3</button><button type="button" class="choice" data-count="4">4</button>
    </span>
  </div>
  <p class="composer-error" role="alert" hidden></p>
  <div class="composer-foot">
    <label class="check"><input type="checkbox" class="send-on-add" /> <span class="check-text"></span></label>
    <span class="hint"><kbd>Enter</kbd> to add</span>
  </div>
</form>
<div class="dock" hidden>
  <form class="askbar" hidden>
    <input type="text" placeholder="Describe a change to this page" aria-label="Note about this page" />
    <button type="submit" class="send" aria-label="Add note"><span data-icon="arrowUp" data-size="15"></span></button>
  </form>
  <div class="tools" role="toolbar" aria-label="Design in Browser">
    <button type="button" class="tool active pick-tool" title="Comment on an element" aria-label="Comment on an element"><span data-icon="comment" data-size="18"></span></button>
    <span class="tools-divider"></span>
    <span class="tools-count"></span>
    <button type="button" class="tool ask" aria-pressed="false"></button>
    <span class="tools-divider"></span>
    <button type="button" class="tool done-tool"><kbd>Esc</kbd>Done</button>
  </div>
</div>`
fillIcons(root)
document.documentElement.append(host)

/** Hosts of this tool's own UI (the overlay and the dock): never picked, and clicks on them reach them. */
const uiHosts = new Set<Element>([host])
export function registerUiHost(element: Element): void {
  uiHosts.add(element)
}

/** Width the dock takes on the right; cards and the tool pill keep out of it. */
let reservedRight = 0
export function setReservedRight(px: number): void {
  reservedRight = px
  host.style.setProperty('--reserved-right', `${px}px`)
  scheduleRender()
}
const usableWidth = () => innerWidth - reservedRight

const $ = <T extends Element>(selector: string) => root.querySelector(selector) as T
const highlight = $<HTMLDivElement>('.highlight')
const tagLabel = $<HTMLSpanElement>('.tag-label')
const tagSize = $<HTMLSpanElement>('.tag-size')
const pins = $<HTMLDivElement>('.pins')
const composingPin = $<HTMLDivElement>('.composing')
const composingDisc = $<HTMLSpanElement>('.composing .disc')
const composer = $<HTMLFormElement>('.composer')
const composerTarget = $<HTMLParagraphElement>('.target')
const chip = $<HTMLSpanElement>('.chip')
const checkText = $<HTMLSpanElement>('.check-text')
const textarea = $<HTMLTextAreaElement>('.composer textarea')
const composerError = $<HTMLParagraphElement>('.composer-error')
const countRow = $<HTMLDivElement>('.count-row')
const countLabel = $<HTMLSpanElement>('.count-label')

/** Comment in words, or ask for alternatives of the element; the count persists between cards. */
let composerMode: 'comment' | 'alternatives' = 'comment'
let alternativeCount = 2

function setComposerMode(next: 'comment' | 'alternatives'): void {
  composerMode = next
  for (const tab of root.querySelectorAll<HTMLButtonElement>('.mode')) tab.setAttribute('aria-selected', String(tab.dataset.mode === next))
  countRow.hidden = next !== 'alternatives'
  for (const choice of countRow.querySelectorAll<HTMLButtonElement>('.choice')) choice.setAttribute('aria-pressed', String(Number(choice.dataset.count) === alternativeCount))
  countLabel.textContent = alternativeCount === 1 ? 'How many · shown as before / after' : 'How many'
  textarea.placeholder = next === 'alternatives' ? 'What should they try? (optional)' : ''
  placeComposer()
}
const sendOnAdd = $<HTMLInputElement>('.send-on-add')
const hint = $<HTMLSpanElement>('.hint')
const dock = $<HTMLDivElement>('.dock')
const askbar = $<HTMLFormElement>('.askbar')
const askInput = $<HTMLInputElement>('.askbar input')
const askButton = $<HTMLButtonElement>('.tool.ask')
const toolsCount = $<HTMLSpanElement>('.tools-count')

/** What an answer carries over from the comment it answers. */
type Answering = { inReplyTo: InReplyTo; element: ElementRef | null; page: PageRef }
type Point = { x: number; y: number }

type Mode =
  | { kind: 'idle' }
  | { kind: 'picking' }
  | { kind: 'commenting'; element: Element; offset: Point; then: 'picking' | 'idle' }

let mode: Mode = { kind: 'idle' }
let hovered: Element | null = null
let state: PageState | null = null

/** The agent this page talks to, as the UI names it: "Claude", "OpenCode", or "Agent" when none is connected. */
function agentName(): string {
  return (state ? defaultSession(state)?.agent : undefined) ?? FALLBACK_AGENT
}

let namedAgent = ''

/** Puts the agent's name on the comment card and the tool pill, and fits the textarea's indent to the chip. */
function nameAgent(): void {
  const agent = agentName()
  if (agent !== namedAgent) {
    namedAgent = agent
    chip.textContent = `@${agent}`
    checkText.textContent = `Send to ${agent}`
    askButton.textContent = `Ask ${agent}`
    textarea.setAttribute('aria-label', `Comment for ${agent}`)
  }
  if (!composer.hidden) textarea.style.textIndent = `${chip.offsetWidth + 7}px`
}

// --- picking -------------------------------------------------------------------

function elementAt(x: number, y: number): Element | null {
  const element = document.elementFromPoint(x, y)
  return element && !uiHosts.has(element) && element !== document.documentElement ? element : null
}

function showHighlight(element: Element | null, selected = false): void {
  const box = element?.getBoundingClientRect()
  if (!element || !box) {
    highlight.hidden = true
    return
  }
  highlight.hidden = false
  highlight.classList.toggle('selected', selected)
  highlight.classList.toggle('below', box.top < 34)
  highlight.style.transform = `translate(${box.left}px, ${box.top}px)`
  highlight.style.width = `${box.width}px`
  highlight.style.height = `${box.height}px`
  tagLabel.textContent = label(element)
  tagSize.textContent = `${Math.round(box.width)} × ${Math.round(box.height)}`
}

function setMode(next: Mode): void {
  mode = next
  for (const listener of modeListeners) listener()
  dock.hidden = mode.kind === 'idle'
  document.documentElement.style.cursor = mode.kind === 'picking' ? 'crosshair' : ''
  if (mode.kind !== 'commenting') {
    composer.hidden = true
    composingPin.hidden = true
  }
  if (mode.kind === 'idle') {
    showHighlight(null)
    closeAskbar()
  }
}

const fromOverlay = (event: Event) => event.composedPath().some((node) => uiHosts.has(node as Element))

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
  if (!fromOverlay(event)) closeThreads()
  if (mode.kind === 'idle' || fromOverlay(event)) return
  swallow(event)
  // While commenting, a click elsewhere moves an empty card; typed text is never thrown away.
  if (mode.kind === 'commenting' && textarea.value.trim() !== '') return
  const element = elementAt(event.clientX, event.clientY)
  if (!element) return
  const box = element.getBoundingClientRect()
  openComposer({ element, offset: { x: event.clientX - box.left, y: event.clientY - box.top }, then: 'picking' })
}

for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick']) {
  window.addEventListener(type, swallow, true)
}
window.addEventListener('click', onClick, true)
window.addEventListener('mousemove', onPointerMove, true)

// --- comment card ------------------------------------------------------------------------

/** The page point a pin marks: the click offset inside the element, kept inside its box as it resizes. */
function pointOn(element: Element, offset: Point | undefined): Point | null {
  const box = element.getBoundingClientRect()
  if (box.width === 0 && box.height === 0) return null
  const x = offset ? Math.min(Math.max(offset.x, 0), box.width) : 0
  const y = offset ? Math.min(Math.max(offset.y, 0), box.height) : 0
  return { x: box.left + x, y: box.top + y }
}

function setTarget(element: Element): void {
  const text = document.createElement('span')
  text.className = 'target-text'
  const snippet = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
  text.textContent = snippet ? `${label(element)} · “${snippet}”` : label(element)
  composerTarget.replaceChildren(text)
}

function openComposer(next: { element: Element; offset: Point; then: 'picking' | 'idle' }): void {
  setMode({ kind: 'commenting', ...next })
  closeAskbar()
  closeThreads()
  showHighlight(next.element, true)
  setTarget(next.element)
  composerError.hidden = true
  setComposerMode('comment')
  textarea.value = ''
  sendOnAdd.checked = state?.sendOnAdd ?? false
  updateHint()
  composingDisc.textContent = String((state?.draft.length ?? 0) + 1)
  composer.hidden = false
  composingPin.hidden = false
  nameAgent()
  placeComposer()
  textarea.focus()
}

function updateHint(): void {
  hint.replaceChildren()
  const key = document.createElement('kbd')
  key.textContent = 'Enter'
  hint.append(key, sendOnAdd.checked ? ' to send' : ' to add')
}

function placeComposer(): void {
  if (mode.kind !== 'commenting') return
  const point = pointOn(mode.element, mode.offset)
  if (!point) return
  composingPin.style.transform = `translate(${point.x}px, ${point.y - PIN}px)`
  const height = composer.offsetHeight || 140
  const right = point.x + PIN + 8
  const left = right + CARD_WIDTH > usableWidth() - 8 ? Math.max(8, point.x - CARD_WIDTH - 8) : right
  const top = Math.min(Math.max(8, point.y - PIN), innerHeight - height - 8)
  composer.style.transform = `translate(${left}px, ${top}px)`
}

function leaveComposer(): void {
  if (mode.kind !== 'commenting') return
  if (mode.then === 'idle') {
    setMode({ kind: 'idle' })
    return
  }
  setMode({ kind: 'picking' })
  showHighlight(hovered)
}

function showComposerError(message: string): void {
  composerError.textContent = message
  composerError.hidden = false
  placeComposer()
}

function tabSession() {
  return state && state.connection === 'connected' ? defaultSession(state) : null
}

async function addComment(comment: DraftComment, send: boolean): Promise<void> {
  await sendOp({ type: 'add-comment', comment })
  const session = tabSession()
  if (send && session) await sendOp({ type: 'send', sessionId: session.id })
}

async function submitComment(): Promise<void> {
  if (mode.kind !== 'commenting') return
  const typed = textarea.value.trim()
  const asking = composerMode === 'alternatives'
  if (typed === '' && !asking) {
    textarea.focus()
    return
  }
  const text = typed || (alternativeCount === 1 ? 'An alternative for this' : `${alternativeCount} alternatives for this`)
  const send = sendOnAdd.checked
  if (send && !tabSession()) {
    showComposerError(`No agent session is connected to send to. Untick the box to keep it with your comments, or connect a session (in Claude Code: ${START_COMMAND}).`)
    return
  }
  const { element, offset, then } = mode
  const comment: DraftComment = {
    id: crypto.randomUUID(),
    text,
    page: capturePage(),
    element: { ...captureElement(element), clickOffset: { x: Math.round(offset.x), y: Math.round(offset.y) } },
    inReplyTo: null,
    ...(asking ? { intent: { kind: 'alternatives' as const, count: alternativeCount } } : {}),
    // Made on one version of a group: the agent gets which version, and its tweaks as the user left them.
    ...(variantContextOf(element) ? { variant: variantContextOf(element) } : {}),
    createdAt: new Date().toISOString(),
  }
  // Leave first: an Esc pressed while the save is in flight must find the mode already moved on.
  leaveComposer()
  try {
    await addComment(comment, send)
  } catch {
    // Most often the extension was reloaded and this tab still runs the old overlay. Keep the text.
    openComposer({ element, offset, then })
    setComposerMode(asking ? 'alternatives' : 'comment')
    textarea.value = typed
    showComposerError('Couldn’t save this comment. Copy your text, reload the tab, and add it again.')
  }
}

composer.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const tab = target.closest<HTMLButtonElement>('.mode')
  if (tab) {
    setComposerMode(tab.dataset.mode === 'alternatives' ? 'alternatives' : 'comment')
    textarea.focus()
    return
  }
  const choice = target.closest<HTMLButtonElement>('[data-count]')
  if (choice) {
    alternativeCount = Number(choice.dataset.count)
    setComposerMode('alternatives')
    textarea.focus()
  }
})

composer.addEventListener('submit', (event) => {
  event.preventDefault()
  void submitComment()
})
textarea.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void submitComment()
  }
})
textarea.addEventListener('input', placeComposer)
sendOnAdd.addEventListener('change', () => {
  updateHint()
  void sendOp({ type: 'set-send-on-add', value: sendOnAdd.checked })
})

// --- tool pill and "Ask Claude" -------------------------------------------------------------

function openAskbar(): void {
  if (mode.kind === 'idle') setMode({ kind: 'picking' })
  askbar.hidden = false
  askButton.setAttribute('aria-pressed', 'true')
  askInput.focus()
}

function closeAskbar(): void {
  askbar.hidden = true
  askInput.value = ''
  askButton.setAttribute('aria-pressed', 'false')
}

askButton.addEventListener('click', () => (askbar.hidden ? openAskbar() : closeAskbar()))
$<HTMLButtonElement>('.done-tool').addEventListener('click', () => setMode({ kind: 'idle' }))
$<HTMLButtonElement>('.pick-tool').addEventListener('click', closeAskbar)
askbar.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = askInput.value.trim()
  if (text === '') return
  const note: DraftComment = { id: crypto.randomUUID(), text, page: capturePage(), element: null, inReplyTo: null, createdAt: new Date().toISOString() }
  closeAskbar()
  try {
    await addComment(note, false)
  } catch {
    openAskbar()
    askInput.value = text
  }
})

// Keys typed into the overlay belong to it, not to the app's shortcuts.
for (const part of [composer, askbar, pins]) {
  for (const type of ['keydown', 'keyup', 'keypress']) part.addEventListener(type, (event) => event.stopPropagation())
}

// --- keyboard + messages --------------------------------------------------------

export function togglePicker(): void {
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
      closeThreads()
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    if (mode.kind === 'commenting') leaveComposer()
    else if (!askbar.hidden) closeAskbar()
    else setMode({ kind: 'idle' })
  },
  true,
)

export const isPicking = () => mode.kind !== 'idle'

/** Picker state changes, for the dock's Comment button. */
const modeListeners = new Set<() => void>()
export function onModeChange(listener: () => void): void {
  modeListeners.add(listener)
}

// --- pins --------------------------------------------------------------------------

type PinStatus = 'draft' | CommentStatus | 'answered'

type PinModel = {
  key: string
  /** Who replies: the batch's agent, or the page's agent for a draft. */
  agent: string
  ref: ElementRef
  status: PinStatus
  number: number | null
  text: string
  createdAt: string
  reply: string | null
  /** Set when the pin can take an answer from here. */
  answer: Answering | null
  draftId: string | null
}

const statusLabel: Record<PinStatus, string> = {
  draft: 'Not sent',
  pending: 'Waiting for a reply',
  done: 'Done',
  question: 'Needs your answer',
  skipped: 'Skipped',
  variants: 'Alternatives on the page',
  answered: 'Answered',
}

function answeredIds(current: PageState): Set<string> {
  const ids = new Set<string>()
  for (const comment of current.draft) if (comment.inReplyTo) ids.add(comment.inReplyTo.commentId)
  for (const batch of current.batches) for (const comment of batch.comments) if (comment.inReplyTo) ids.add(comment.inReplyTo.commentId)
  return ids
}

function sentPin(batch: Batch, comment: BatchComment & { element: ElementRef }, answered: Set<string>, ownProject: string | null): PinModel {
  const isOpenQuestion = comment.status === 'question' && !answered.has(comment.id)
  return {
    key: comment.id,
    agent: batch.agent,
    ref: comment.element,
    status: comment.status === 'question' && answered.has(comment.id) ? 'answered' : comment.status,
    number: null,
    text: comment.text,
    createdAt: comment.createdAt,
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

const hasElement = <T extends { element: ElementRef | null }>(comment: T): comment is T & { element: ElementRef } => comment.element !== null

function pinsForThisPage(current: PageState): PinModel[] {
  const answered = answeredIds(current)
  const ownProject = defaultSession(current)?.projectRoot ?? null
  const drafts = current.draft.flatMap((comment, index): PinModel[] =>
    hasElement(comment) && samePage(comment.page.url) && comment.intent?.kind !== 'choose-variant'
      ? [{ key: comment.id, agent: agentName(), ref: comment.element, status: 'draft', number: index + 1, text: comment.text, createdAt: comment.createdAt, reply: null, answer: null, draftId: comment.id }]
      : [],
  )
  // A pick needs no pin: the group's switcher already shows it.
  const sent = current.batches.flatMap((batch) =>
    batch.comments
      .filter(hasElement)
      .filter((comment) => samePage(comment.page.url) && comment.intent?.kind !== 'choose-variant')
      .map((comment) => sentPin(batch, comment, answered, ownProject)),
  )
  return [...drafts, ...sent]
}

const pinGlyph: Record<Exclude<PinStatus, 'draft'>, string> = {
  pending: icon('clock'),
  done: icon('check'),
  question: icon('question'),
  skipped: icon('minus'),
  variants: icon('layers'),
  answered: icon('clock'),
}

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function buildThread(pin: PinModel, thread: HTMLElement): void {
  const you = el('div', 'entry')
  const head = el('p', 'entry-head')
  head.append(el('span', '', 'You'), el('span', 'when', clock.format(new Date(pin.createdAt))), el('span', 'status', statusLabel[pin.status]))
  if (pin.draftId) {
    const remove = el('button', 'remove')
    remove.type = 'button'
    remove.dataset.action = 'remove'
    remove.dataset.key = pin.key
    remove.setAttribute('aria-label', 'Remove comment')
    remove.innerHTML = icon('trash', 15)
    head.append(remove)
  }
  you.append(head, el('p', 'entry-text', pin.text))
  const parts: HTMLElement[] = [you]

  if (pin.reply) {
    const agent = el('div', 'entry agent')
    const agentHead = el('p', 'entry-head')
    agentHead.append(el('span', '', pin.agent))
    agent.append(agentHead, el('p', 'entry-text', pin.reply))
    parts.push(agent)
  }
  if (pin.answer) {
    const form = el('form', 'reply-field')
    form.dataset.key = pin.key
    const field = el('textarea', '')
    field.rows = 1
    field.placeholder = `Answer ${pin.agent}`
    field.setAttribute('aria-label', `Answer ${pin.agent}`)
    const send = el('button', 'send')
    send.type = 'submit'
    send.setAttribute('aria-label', 'Add answer')
    send.innerHTML = icon('arrowUp', 15)
    form.append(field, send)
    parts.push(form)
  }
  thread.replaceChildren(...parts)
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

  // Pins on the same point line up to the right of the first one.
  const taken = new Map<string, number>()
  for (const pin of wanted) {
    let wrap = pins.querySelector<HTMLElement>(`:scope > [data-key="${CSS.escape(pin.key)}"]`)
    if (!wrap) {
      wrap = el('div', 'pin-wrap')
      wrap.dataset.key = pin.key
      wrap.innerHTML = '<button type="button" class="pin"><span class="disc"></span></button><div class="thread" role="group"></div>'
      pins.append(wrap)
    }
    // A thread being typed into is left alone until it is done.
    const typing = wrap.contains(root.activeElement) && root.activeElement instanceof HTMLTextAreaElement
    const signature = JSON.stringify([pin.status, pin.number, pin.text, pin.reply, pin.answer !== null, pin.agent])
    if (wrap.dataset.signature !== signature && !typing) {
      wrap.dataset.signature = signature
      wrap.dataset.status = pin.status
      const disc = wrap.querySelector<HTMLElement>('.disc')!
      if (pin.number === null) disc.innerHTML = pinGlyph[pin.status as Exclude<PinStatus, 'draft'>]
      else disc.textContent = String(pin.number)
      wrap.querySelector('.pin')!.setAttribute('aria-label', `${statusLabel[pin.status]}: ${pin.text}`)
      buildThread(pin, wrap.querySelector<HTMLElement>('.thread')!)
    }

    const element = find(pin.ref.selector)
    const point = element ? pointOn(element, pin.ref.clickOffset) : null
    if (!point) {
      wrap.hidden = true
      continue
    }
    const spot = `${Math.round(point.x)},${Math.round(point.y)}`
    const shift = taken.get(spot) ?? 0
    taken.set(spot, shift + 1)
    wrap.hidden = false
    const x = Math.min(Math.max(4, point.x + shift * (PIN + 4)), usableWidth() - PIN - 4)
    const y = Math.min(Math.max(4, point.y - PIN), innerHeight - PIN - 4)
    wrap.style.transform = `translate(${x}px, ${y}px)`
    wrap.classList.toggle('flip-x', x + PIN + 8 + CARD_WIDTH > usableWidth())
    placeThread(wrap.querySelector<HTMLElement>('.thread')!, y)
  }
}

/** Opens the card downward from the pin when it fits, else upward, and always keeps it 8px inside the window. */
function placeThread(thread: HTMLElement, pinTop: number): void {
  const height = thread.offsetHeight
  const below = pinTop
  const above = pinTop + PIN - height
  const preferred = below + height <= innerHeight - 8 ? below : above
  const top = Math.min(Math.max(8, preferred), innerHeight - 8 - height)
  thread.style.top = `${top - pinTop}px`
}

function closeThreads(except?: Element): void {
  for (const wrap of pins.querySelectorAll('.pin-wrap.open')) if (wrap !== except) wrap.classList.remove('open')
}

pins.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  const pinButton = target.closest('.pin')
  if (pinButton) {
    const wrap = pinButton.parentElement!
    closeThreads(wrap)
    wrap.classList.toggle('open')
    return
  }
  const action = target.closest<HTMLButtonElement>('[data-action="remove"]')
  const pin = action ? models.get(action.dataset.key ?? '') : undefined
  if (pin?.draftId) void sendOp({ type: 'remove-comment', id: pin.draftId })
})

async function submitAnswer(form: HTMLFormElement): Promise<void> {
  const pin = models.get(form.dataset.key ?? '')
  const field = form.querySelector('textarea')!
  const text = field.value.trim()
  if (!pin?.answer || text === '') return
  const element = find(pin.ref.selector)
  const comment: DraftComment = {
    id: crypto.randomUUID(),
    text,
    page: pin.answer.page,
    element: element ? { ...captureElement(element), clickOffset: pin.ref.clickOffset } : pin.answer.element,
    inReplyTo: pin.answer.inReplyTo,
    createdAt: new Date().toISOString(),
  }
  field.blur()
  form.closest('.pin-wrap')?.classList.remove('open')
  try {
    await sendOp({ type: 'add-comment', comment })
  } catch {
    field.value = text
  }
}

pins.addEventListener('submit', (event) => {
  event.preventDefault()
  void submitAnswer(event.target as HTMLFormElement)
})
pins.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement
  if (!(target instanceof HTMLTextAreaElement) || event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  const form = target.closest('form')
  if (form) void submitAnswer(form)
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
    renderVariants()
    nameAgent()
    toolsCount.textContent = draftCount()
    if (mode.kind === 'commenting') {
      showHighlight(mode.element, true)
      placeComposer()
    }
  })
}

function refresh(): void {
  state = readState()
  syncFromState(state)
  scheduleRender()
}

mountVariants({ root, state: () => state, agent: agentName, addComment, usableWidth })
onGroupsChange(scheduleRender)
onStateChange(refresh)
window.addEventListener('scroll', scheduleRender, { capture: true, passive: true })
window.addEventListener('resize', scheduleRender)
// Hot reloads and client-side routing move elements without a scroll or resize.
setInterval(scheduleRender, 800)
refresh()
