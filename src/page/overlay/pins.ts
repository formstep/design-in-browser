// Pins: one per thread on this page, at the point its first comment was made (or the element an agent's note is
// on). A question's answer joins the thread of the comment that asked, so one pin carries the whole exchange. The
// disc shows where the thread stands (waiting, question, alternatives, note), and opening it shows the thread, with a
// field to answer the agent's question from right there. A settled thread leaves the page; the dock keeps it.
import { SOURCE_ATTRIBUTE } from '../../shared/page-protocol.ts'
import type { BatchComment, CommentStatus, DraftComment, ElementRef, InReplyTo, NoteAnchor, PageRef } from '../../shared/protocol.ts'
import { captureElement, samePage } from '../capture.ts'
import { answeredIds, answering, isPick, newComment, settled, threads } from '../comments.ts'
import { dismissButton } from '../dismiss.ts'
import { icon } from '../icons.ts'
import { defaultSession, readState, sendComment, type PageState } from '../store.ts'
import { el, findBySelector, query } from '../ui/dom.ts'
import { keepKeys } from '../ui/events.ts'
import { when } from '../ui/format.ts'
import { clamp, pointOn, type Point } from '../ui/geometry.ts'
import { cameFromUi, usableWidth } from '../ui/layout.ts'
import { markersHidden } from '../ui/markers.ts'
import { getMode, onModeChange } from './mode.ts'
import { CARD_WIDTH, PIN, root } from './root.ts'

/** What an answer typed into a pin carries over from the comment it answers. */
type Answering = { inReplyTo: InReplyTo; element: ElementRef | null; page: PageRef }

/** One turn of a thread: what the user wrote (none for an agent's note) and the agent's reply, if any yet. */
type Entry = { you: string | null; agent: string | null; at: string }

type PinModel = {
  /** The thread's first comment. */
  key: string
  agent: string
  /** Finds the element the pin sits on, as the page is now. */
  find: () => Element | null
  /** Where on the element: the clicked point, or its top-left corner for a note. */
  offset: Point | undefined
  /** Where the thread stands: its newest comment's status. */
  status: CommentStatus
  entries: Entry[]
  /** Set when the newest comment is a question this page can answer. */
  answer: Answering | null
  /** The newest comment, when it can be dismissed instead of answered: an open question, or a note. */
  dismiss: { id: string; name: string } | null
}

const statusLabel: Record<CommentStatus, string> = {
  pending: 'Waiting for a reply',
  done: 'Done',
  question: 'Needs your answer',
  skipped: 'Skipped',
  variants: 'Alternatives on the page',
  note: 'Note',
}

const statusGlyph: Record<CommentStatus, string> = {
  pending: icon('clock'),
  done: icon('check'),
  question: icon('question'),
  skipped: icon('minus'),
  variants: icon('layers'),
  note: icon('comment'),
}

const pins = query<HTMLDivElement>(root, '.pins')
let models = new Map<string, PinModel>()

function findAnchor(anchor: NoteAnchor): Element | null {
  const bySource = 'source' in anchor ? findBySelector(`[${SOURCE_ATTRIBUTE}="${CSS.escape(anchor.source)}"]`) : null
  return bySource ?? (anchor.selector ? findBySelector(anchor.selector) : null)
}

/** Where a comment's pin goes: the element the user clicked, or the element an agent's note points at. */
function placeOf(comment: DraftComment & { anchor?: NoteAnchor }): Pick<PinModel, 'find' | 'offset'> | null {
  const { element, anchor } = comment
  if (element) return { find: () => findBySelector(element.selector), offset: element.clickOffset }
  if (anchor) return { find: () => findAnchor(anchor), offset: undefined }
  return null
}

/** Alternatives the agent put on this page: their switcher stands in for the pin, which would sit on top of them. */
const switcherShows = (comment: BatchComment) =>
  comment.status === 'variants' &&
  comment.group !== undefined &&
  document.querySelector(`dib-variants[data-group="${CSS.escape(comment.group)}"]`) !== null

/**
 * A comment made on another page still has its pin here when its element is here too: a shared part such as a
 * sidebar or a header. Its selector has to find an element that carries the comment's source location, and no other
 * element on this page may carry it, so a list item or a repeated card never borrows another's pin.
 */
function sharedHere(comment: DraftComment): boolean {
  const own = comment.element?.sources?.[0]
  const found = comment.element ? findBySelector(comment.element.selector) : null
  if (!own || !found || found.closest(`[${SOURCE_ATTRIBUTE}]`)?.getAttribute(SOURCE_ATTRIBUTE) !== own) return false
  return document.querySelectorAll(`[${SOURCE_ATTRIBUTE}="${CSS.escape(own)}"]`).length === 1
}

/** Pins for threads on this page, or on a part of it other pages share; a pick needs none (its switcher shows it). */
function pinsForThisPage(state: PageState): PinModel[] {
  const answered = answeredIds(state.batches)
  const ownProject = defaultSession(state)?.projectRoot ?? null
  return threads(state.batches).flatMap((thread): PinModel[] => {
    const first = thread[0]
    const last = thread.at(-1)
    if (!first || !last || isPick(first.comment) || !(samePage(first.comment.page.url) || sharedHere(first.comment))) return []
    const place = placeOf(first.comment)
    // A settled thread (done, skipped, dismissed, picked) leaves the page; its replies stay in the dock.
    if (!place || settled(last.comment, state) || switcherShows(last.comment)) return []
    const open = last.comment.status === 'question' && !answered.has(last.comment.id)
    return [
      {
        key: first.comment.id,
        agent: last.batch.agent,
        ...place,
        status: last.comment.status,
        entries: thread.map(({ batch, comment }) => ({
          you: batch.from === 'agent' ? null : comment.text,
          agent: comment.reply,
          at: comment.createdAt,
        })),
        // Only the project that asked can take the answer: it goes to that project's session.
        answer:
          open && last.batch.projectRoot === ownProject
            ? { inReplyTo: answering(last.batch, last.comment), element: last.comment.element, page: last.comment.page }
            : null,
        dismiss: open || last.comment.status === 'note' ? { id: last.comment.id, name: open ? 'Dismiss question' : 'Dismiss note' } : null,
      },
    ]
  })
}

/** The thread, oldest first: each of the user's comments, then the agent's reply to it. The first line says where the
 * thread stands. */
function buildThread(pin: PinModel, thread: HTMLElement): void {
  const head = (who: string, at: string, first: boolean) =>
    el('p', { className: 'entry-head' }, [
      el('span', { textContent: who }),
      el('span', { className: 'when', textContent: when(at) }),
      ...(first ? [el('span', { className: 'status', textContent: statusLabel[pin.status] })] : []),
    ])
  const parts = pin.entries.flatMap((entry, index) => [
    ...(entry.you === null
      ? []
      : [
          el('div', { className: 'entry' }, [
            head('You', entry.at, index === 0),
            el('p', { className: 'entry-text', textContent: entry.you }),
          ]),
        ]),
    ...(entry.agent === null
      ? []
      : [
          el('div', { className: 'entry agent' }, [
            entry.you === null
              ? head(pin.agent, entry.at, index === 0)
              : el('p', { className: 'entry-head' }, [el('span', { textContent: pin.agent })]),
            el('p', { className: 'entry-text', textContent: entry.agent }),
          ]),
        ]),
  ])
  thread.replaceChildren(...parts, ...answerField(pin), ...dismissIfOpen(pin))
}

/** Closes an open question or a note without answering it. */
const dismissIfOpen = (pin: PinModel): HTMLElement[] => (pin.dismiss ? [dismissButton(pin.dismiss.id, pin.dismiss.name)] : [])

/** The field under an open question, when this page can take the answer. */
function answerField(pin: PinModel): HTMLElement[] {
  if (!pin.answer) return []
  const field = el('textarea', { attrs: { rows: '1', placeholder: `Answer ${pin.agent}`, 'aria-label': `Answer ${pin.agent}` } })
  const send = el('button', {
    className: 'send',
    html: icon('arrowUp', 15),
    attrs: { type: 'submit', 'aria-label': `Send answer to ${pin.agent}` },
  })
  return [el('form', { className: 'reply-field', attrs: { 'data-key': pin.key } }, [field, send])]
}

export function renderPins(): void {
  pins.hidden = markersHidden()
  pins.classList.toggle('busy', getMode().kind !== 'idle')
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
    const signature = JSON.stringify([pin.status, pin.entries, pin.answer !== null, pin.agent, pin.dismiss])
    if (wrap.dataset.signature !== signature && !typing) {
      wrap.dataset.signature = signature
      wrap.dataset.status = pin.status
      query<HTMLElement>(wrap, '.disc').innerHTML = statusGlyph[pin.status]
      const [opening] = pin.entries
      query(wrap, '.pin').setAttribute('aria-label', `${statusLabel[pin.status]}: ${opening?.you ?? opening?.agent ?? ''}`)
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
  // A focused pin or field keeps its card shown (:focus-within), over the page: let go of it too.
  const focused = root.activeElement
  if (focused instanceof HTMLElement && pins.contains(focused) && !except?.contains(focused)) focused.blur()
}

/** Answers on their way, by form, so a second Enter doesn't send one twice. */
const answersInFlight = new WeakSet<HTMLFormElement>()

async function submitAnswer(form: HTMLFormElement): Promise<void> {
  const pin = models.get(form.dataset.key ?? '')
  const field = query<HTMLTextAreaElement>(form, 'textarea')
  const text = field.value.trim()
  if (!pin?.answer || text === '' || answersInFlight.has(form)) return
  const element = pin.find()
  const comment = newComment({
    text,
    page: pin.answer.page,
    element: element ? { ...captureElement(element), clickOffset: pin.offset } : pin.answer.element,
    inReplyTo: pin.answer.inReplyTo,
  })
  // The answer goes to the agent at once; the card closes once the daemon has it, or keeps the text and says why.
  if (form.nextElementSibling?.classList.contains('reply-error')) form.nextElementSibling.remove()
  answersInFlight.add(form)
  try {
    await sendComment(comment)
    field.value = ''
    field.blur()
    form.closest('.pin-wrap')?.classList.remove('open')
  } catch (error) {
    form.after(
      el('p', { className: 'reply-error', textContent: error instanceof Error ? error.message : String(error), attrs: { role: 'alert' } })
    )
  } finally {
    answersInFlight.delete(form)
  }
}

pins.addEventListener('click', (event) => {
  const clicked = event.target as HTMLElement
  const pinButton = clicked.closest('.pin')
  if (pinButton?.parentElement) {
    closeThreads(pinButton.parentElement)
    pinButton.parentElement.classList.toggle('open')
  }
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
// Starting to comment or draw closes open cards: they would cover what the user is about to pick.
onModeChange((mode) => {
  if (mode.kind !== 'idle') closeThreads()
})
