// Pins: one per comment on this page, at the point that was clicked, and one per note the agent left on an
// element. A pin's disc shows the draft number or the agent's answer (done, question, skipped, alternatives,
// note), and opening it shows the thread, with a field to answer the agent's question from right there.
import { SOURCE_ATTRIBUTE } from '../../shared/page-protocol.ts'
import type { Batch, BatchComment, CommentStatus, DraftComment, ElementRef, InReplyTo, NoteAnchor, PageRef } from '../../shared/protocol.ts'
import { captureElement, samePage } from '../capture.ts'
import { answeredIds, answering, isPick, newComment } from '../comments.ts'
import { icon } from '../icons.ts'
import { agentName, defaultSession, readState, sendOp, type PageState } from '../store.ts'
import { el, query } from '../ui/dom.ts'
import { keepKeys } from '../ui/events.ts'
import { when } from '../ui/format.ts'
import { clamp, pointOn, type Point } from '../ui/geometry.ts'
import { cameFromUi, usableWidth } from '../ui/layout.ts'
import { markersHidden } from '../ui/markers.ts'
import { onModeChange } from './mode.ts'
import { CARD_WIDTH, PIN, root } from './root.ts'

type PinStatus = 'draft' | CommentStatus | 'answered'

/** What an answer typed into a pin carries over from the comment it answers. */
type Answering = { inReplyTo: InReplyTo; element: ElementRef | null; page: PageRef }

type PinModel = {
  key: string
  /** Who replies: the batch's agent, or the page's agent for a draft. */
  agent: string
  /** Finds the element the pin sits on, as the page is now. */
  find: () => Element | null
  /** Where on the element: the clicked point, or its top-left corner for a note. */
  offset: Point | undefined
  /** An agent's note has the agent's words alone, with no "You" entry. */
  fromAgent: boolean
  status: PinStatus
  /** The draft's place in the stack; null once sent, when the disc shows the status instead. */
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
  note: 'Note',
  answered: 'Answered',
}

const statusGlyph: Record<Exclude<PinStatus, 'draft'>, string> = {
  pending: icon('clock'),
  done: icon('check'),
  question: icon('question'),
  skipped: icon('minus'),
  variants: icon('layers'),
  note: icon('comment'),
  answered: icon('clock'),
}

const pins = query<HTMLDivElement>(root, '.pins')
let models = new Map<string, PinModel>()

/** The element a selector names now, if any; a selector that no longer parses finds nothing. */
function find(selector: string): Element | null {
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}

function findAnchor(anchor: NoteAnchor): Element | null {
  const bySource = 'source' in anchor ? find(`[${SOURCE_ATTRIBUTE}="${CSS.escape(anchor.source)}"]`) : null
  return bySource ?? (anchor.selector ? find(anchor.selector) : null)
}

/** Where a comment's pin goes: the element the user clicked, or the element an agent's note points at. */
function placeOf(comment: DraftComment & { anchor?: NoteAnchor }): Pick<PinModel, 'find' | 'offset'> | null {
  const { element, anchor } = comment
  if (element) return { find: () => find(element.selector), offset: element.clickOffset }
  if (anchor) return { find: () => findAnchor(anchor), offset: undefined }
  return null
}

function sentPin(
  batch: Batch,
  comment: BatchComment,
  place: Pick<PinModel, 'find' | 'offset'>,
  answered: Set<string>,
  ownProject: string | null
): PinModel {
  const isOpenQuestion = comment.status === 'question' && !answered.has(comment.id)
  return {
    key: comment.id,
    agent: batch.agent,
    ...place,
    fromAgent: batch.from === 'agent',
    status: comment.status === 'question' && answered.has(comment.id) ? 'answered' : comment.status,
    number: null,
    text: comment.text,
    createdAt: comment.createdAt,
    reply: comment.reply,
    // Only the project that asked can take the answer: it goes to that project's session.
    answer:
      isOpenQuestion && batch.projectRoot === ownProject
        ? { inReplyTo: answering(batch, comment), element: comment.element, page: comment.page }
        : null,
    draftId: null,
  }
}

/** A comment the agent finished (done or skipped) needs nothing more from the user: its reply stays in the dock. */
const finished = (comment: BatchComment) => comment.status === 'done' || comment.status === 'skipped'

/** Alternatives the agent put on this page: their switcher stands in for the pin, which would sit on top of them. */
const switcherShows = (comment: BatchComment) =>
  comment.status === 'variants' &&
  comment.group !== undefined &&
  document.querySelector(`dib-variants[data-group="${CSS.escape(comment.group)}"]`) !== null

/** Pins for comments on this page; a pick needs none, since the group's switcher already shows it. */
function pinsForThisPage(state: PageState): PinModel[] {
  const answered = answeredIds(state.draft, state.batches)
  const ownProject = defaultSession(state)?.projectRoot ?? null
  const onThisPage = (comment: DraftComment) => samePage(comment.page.url) && !isPick(comment)
  const drafts = state.draft.flatMap((comment, index): PinModel[] => {
    const place = placeOf(comment)
    return place && onThisPage(comment)
      ? [
          {
            key: comment.id,
            agent: agentName(state),
            ...place,
            fromAgent: false,
            status: 'draft',
            number: index + 1,
            text: comment.text,
            createdAt: comment.createdAt,
            reply: null,
            answer: null,
            draftId: comment.id,
          },
        ]
      : []
  })
  const sent = state.batches.flatMap((batch) =>
    batch.comments.flatMap((comment) => {
      const place = placeOf(comment)
      return place && onThisPage(comment) && !finished(comment) && !switcherShows(comment)
        ? [sentPin(batch, comment, place, answered, ownProject)]
        : []
    })
  )
  return [...drafts, ...sent]
}

function buildThread(pin: PinModel, thread: HTMLElement): void {
  if (pin.fromAgent) {
    // The agent's note: its words, under its name and the note's time and status.
    const head = el('p', { className: 'entry-head' }, [
      el('span', { textContent: pin.agent }),
      el('span', { className: 'when', textContent: when(pin.createdAt) }),
      el('span', { className: 'status', textContent: statusLabel[pin.status] }),
    ])
    thread.replaceChildren(
      el('div', { className: 'entry agent' }, [head, el('p', { className: 'entry-text', textContent: pin.reply ?? '' })]),
      ...answerField(pin)
    )
    return
  }
  const head = el('p', { className: 'entry-head' }, [
    el('span', { textContent: 'You' }),
    el('span', { className: 'when', textContent: when(pin.createdAt) }),
    el('span', { className: 'status', textContent: statusLabel[pin.status] }),
  ])
  if (pin.draftId) {
    const remove = el('button', {
      className: 'remove',
      html: icon('trash', 15),
      attrs: { type: 'button', 'aria-label': 'Remove comment', 'data-action': 'remove', 'data-key': pin.key },
    })
    head.append(remove)
  }
  const parts: HTMLElement[] = [el('div', { className: 'entry' }, [head, el('p', { className: 'entry-text', textContent: pin.text })])]
  if (pin.reply) {
    parts.push(
      el('div', { className: 'entry agent' }, [
        el('p', { className: 'entry-head' }, [el('span', { textContent: pin.agent })]),
        el('p', { className: 'entry-text', textContent: pin.reply }),
      ])
    )
  }
  thread.replaceChildren(...parts, ...answerField(pin))
}

/** The field under an open question, when this page can take the answer. */
function answerField(pin: PinModel): HTMLElement[] {
  if (!pin.answer) return []
  const field = el('textarea', { attrs: { rows: '1', placeholder: `Answer ${pin.agent}`, 'aria-label': `Answer ${pin.agent}` } })
  const send = el('button', { className: 'send', html: icon('arrowUp', 15), attrs: { type: 'submit', 'aria-label': 'Add answer' } })
  return [el('form', { className: 'reply-field', attrs: { 'data-key': pin.key } }, [field, send])]
}

export function renderPins(): void {
  pins.hidden = markersHidden()
  const wanted = pinsForThisPage(readState())
  models = new Map(wanted.map((pin) => [pin.key, pin]))
  for (const node of [...pins.children] as HTMLElement[]) if (!models.has(node.dataset.key ?? '')) node.remove()

  // Pins on the same point line up to the right of the first one.
  const taken = new Map<string, number>()
  for (const pin of wanted) {
    let wrap = pins.querySelector<HTMLElement>(`:scope > [data-key="${CSS.escape(pin.key)}"]`)
    if (!wrap) {
      wrap = el('div', {
        className: 'pin-wrap',
        attrs: { 'data-key': pin.key },
        html: '<button type="button" class="pin"><span class="disc"></span></button><div class="thread" role="group"></div>',
      })
      pins.append(wrap)
    }
    const thread = query<HTMLElement>(wrap, '.thread')
    // A thread being typed into is left alone until it is done.
    const typing = wrap.contains(root.activeElement) && root.activeElement instanceof HTMLTextAreaElement
    const signature = JSON.stringify([pin.status, pin.number, pin.text, pin.reply, pin.answer !== null, pin.agent])
    if (wrap.dataset.signature !== signature && !typing) {
      wrap.dataset.signature = signature
      wrap.dataset.status = pin.status
      const disc = query<HTMLElement>(wrap, '.disc')
      if (pin.status === 'draft') disc.textContent = String(pin.number)
      else disc.innerHTML = statusGlyph[pin.status]
      query(wrap, '.pin').setAttribute('aria-label', `${statusLabel[pin.status]}: ${pin.text}`)
      buildThread(pin, thread)
    }

    const element = pin.find()
    const point = element ? pointOn(element, pin.offset) : null
    if (!point) {
      wrap.hidden = true
      continue
    }
    const spot = `${Math.round(point.x)},${Math.round(point.y)}`
    const shift = taken.get(spot) ?? 0
    taken.set(spot, shift + 1)
    wrap.hidden = false
    const x = clamp(point.x + shift * (PIN + 4), 4, usableWidth() - PIN - 4)
    const y = clamp(point.y - PIN, 4, innerHeight - PIN - 4)
    wrap.style.transform = `translate(${x}px, ${y}px)`
    wrap.classList.toggle('flip-x', x + PIN + 8 + CARD_WIDTH > usableWidth())
    placeThread(thread, y)
  }
}

/** Opens the card downward from the pin when it fits, else upward, and always keeps it 8px inside the window. */
function placeThread(thread: HTMLElement, pinTop: number): void {
  const height = thread.offsetHeight
  const below = pinTop
  const above = pinTop + PIN - height
  const preferred = below + height <= innerHeight - 8 ? below : above
  thread.style.top = `${clamp(preferred, 8, innerHeight - 8 - height) - pinTop}px`
}

export function closeThreads(except?: Element): void {
  for (const wrap of pins.querySelectorAll('.pin-wrap.open')) if (wrap !== except) wrap.classList.remove('open')
}

async function submitAnswer(form: HTMLFormElement): Promise<void> {
  const pin = models.get(form.dataset.key ?? '')
  const field = query<HTMLTextAreaElement>(form, 'textarea')
  const text = field.value.trim()
  if (!pin?.answer || text === '') return
  const element = pin.find()
  const comment = newComment({
    text,
    page: pin.answer.page,
    element: element ? { ...captureElement(element), clickOffset: pin.offset } : pin.answer.element,
    inReplyTo: pin.answer.inReplyTo,
  })
  field.blur()
  form.closest('.pin-wrap')?.classList.remove('open')
  try {
    await sendOp({ type: 'add-comment', comment })
  } catch {
    field.value = text
  }
}

pins.addEventListener('click', (event) => {
  const clicked = event.target as HTMLElement
  const pinButton = clicked.closest('.pin')
  if (pinButton?.parentElement) {
    closeThreads(pinButton.parentElement)
    pinButton.parentElement.classList.toggle('open')
    return
  }
  const remove = clicked.closest<HTMLButtonElement>('[data-action="remove"]')
  const pin = remove ? models.get(remove.dataset.key ?? '') : undefined
  if (pin?.draftId) void sendOp({ type: 'remove-comment', id: pin.draftId })
})
pins.addEventListener('submit', (event) => {
  event.preventDefault()
  void submitAnswer(event.target as HTMLFormElement)
})
pins.addEventListener('keydown', (event) => {
  const field = event.target
  if (!(field instanceof HTMLTextAreaElement) || event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  const form = field.closest('form')
  if (form) void submitAnswer(form)
})
keepKeys(pins)

// A click anywhere outside this package's UI closes open threads, and so does opening a comment card.
window.addEventListener(
  'click',
  (event) => {
    if (!cameFromUi(event)) closeThreads()
  },
  true
)
onModeChange((mode) => {
  if (mode.kind === 'commenting') closeThreads()
})
