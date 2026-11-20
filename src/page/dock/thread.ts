// The dock's thread: each sent batch is your message, and the agent's numbered replies follow it, with a field
// under each question to answer it (or dismiss it) and a link from alternatives to their switcher on the page.
import type { Batch, BatchComment, DraftComment } from '../../shared/protocol.ts'
import { answering, newComment, pickOf } from '../comments.ts'
import { dismissButton } from '../dismiss.ts'
import type { IconName } from '../icons.ts'
import { sendComment, type PageState } from '../store.ts'
import { button, el, iconNode } from '../ui/dom.ts'
import { submitOnEnter } from '../ui/events.ts'
import { elementName, when } from '../ui/format.ts'
import { shownElements } from '../variants/placement.ts'

/** What the replies need besides their own batch: answers given, dismissals, and picks of alternatives. */
export type ThreadContext = { answered: Map<string, string>; state: Pick<PageState, 'batches' | 'dismissed'> }

const statusIcon: Record<BatchComment['status'], IconName> = {
  pending: 'clock',
  done: 'check',
  question: 'question',
  skipped: 'minus',
  variants: 'layers',
  note: 'comment',
}

const statusWord: Record<BatchComment['status'], string> = {
  pending: 'Waiting',
  done: 'Done',
  question: 'Question',
  skipped: 'Skipped',
  variants: 'Alternatives',
  note: 'Note',
}

/** Answers being typed under the agent's questions, by comment id. Kept outside the DOM so a rebuild keeps them. */
const answerDrafts = new Map<string, string>()

/** Where a comment points: the element by its text, or the page; the route only when it isn't this page. */
export function where(comment: DraftComment): string {
  const path = new URL(comment.page.url).pathname
  const marks = comment.marks?.length ?? 0
  const drawn = marks === 0 ? '' : marks === 1 ? 'A mark on ' : `${marks} marks on `
  const target = comment.element ? elementName(comment.element) : drawn ? 'the page' : 'The page'
  return `${drawn}${target}${path === location.pathname ? '' : ` · ${path}`}`
}

/** When each question was answered, by the question's comment id. */
export function answerPlaces(state: PageState): Map<string, string> {
  const found = new Map<string, string>()
  for (const batch of state.batches) {
    for (const comment of batch.comments)
      if (comment.inReplyTo) found.set(comment.inReplyTo.commentId, `You answered at ${when(batch.createdAt)}.`)
  }
  return found
}

/** Scrolls the page to a `<Variants>` group, where its switcher is. */
function showOnPage(group: string): HTMLElement {
  const link = button({ className: 'show-group', textContent: 'Show on page', attrs: { 'data-testid': 'show-group' } })
  link.addEventListener('click', () => {
    const wrapper = document.querySelector(`dib-variants[data-group="${CSS.escape(group)}"]`)
    const [first] = wrapper ? shownElements(wrapper) : []
    first?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
  return link
}

/** The field to answer a question, and the line that says why an answer didn't go. */
function answerForm(batch: Batch, comment: BatchComment): HTMLElement[] {
  const field = el('textarea', {
    attrs: {
      rows: '1',
      placeholder: `Answer ${batch.agent}`,
      'aria-label': `Answer to: ${comment.reply ?? comment.text}`,
      'data-answer': comment.id,
      'data-testid': 'answer-field',
    },
  })
  field.value = answerDrafts.get(comment.id) ?? ''
  field.addEventListener('input', () => answerDrafts.set(comment.id, field.value))
  const submitButton = el(
    'button',
    { className: 'send', title: `Send to ${batch.agent}`, attrs: { type: 'submit', 'aria-label': `Send answer to ${batch.agent}` } },
    [iconNode('arrowUp', 15)]
  )
  const failure = el('p', { className: 'answer-error', attrs: { role: 'alert' } })
  failure.hidden = true
  const form = el('form', { className: 'answer' }, [field, submitButton])
  // The answer goes to the agent at once. Its text stays in the field until the daemon has it, and comes back with
  // the reason if it can't be sent.
  const submit = async () => {
    const text = field.value.trim()
    // The disabled button marks an answer on its way: Enter doesn't send it twice.
    if (submitButton.disabled) return
    if (text === '') {
      field.focus()
      return
    }
    failure.hidden = true
    submitButton.disabled = true
    try {
      await sendComment(newComment({ text, page: comment.page, element: comment.element, inReplyTo: answering(batch, comment) }))
      answerDrafts.delete(comment.id)
    } catch (error) {
      failure.textContent = error instanceof Error ? error.message : String(error)
      failure.hidden = false
      submitButton.disabled = false
    }
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void submit()
  })
  submitOnEnter(field, () => void submit())
  return [form, failure]
}

/** Where an agent's note points, as the agent named it. */
const anchorText = (comment: BatchComment) =>
  comment.anchor ? ('source' in comment.anchor ? comment.anchor.source : comment.anchor.selector) : ''

function reply(batch: Batch, comment: BatchComment, index: number, { answered, state }: ThreadContext): HTMLElement {
  // The numbered disc ties a reply to its comment; only a question or a skip gets a visible label. A note says
  // where it is, since there is no comment of yours above it.
  const label =
    comment.status === 'done'
      ? el('span', { className: 'visually-hidden', textContent: `Done, comment ${index + 1}: ` })
      : el('p', {
          className: 'reply-label',
          textContent: batch.from === 'agent' ? `${statusWord[comment.status]} · ${anchorText(comment)}` : statusWord[comment.status],
        })
  const body = el('div', {}, [label, el('p', { className: 'reply-text', textContent: comment.reply ?? '' })])
  const followup = (text: string) => el('p', { className: 'followup', textContent: text })
  const dismissed = state.dismissed.includes(comment.id)
  if (comment.status === 'question') {
    const answer = answered.get(comment.id)
    if (answer) body.append(followup(answer))
    else if (dismissed) body.append(followup('Dismissed.'))
    else body.append(...answerForm(batch, comment), dismissButton(comment.id, `Dismiss question ${index + 1}`))
  }
  if (comment.status === 'note') body.append(dismissed ? followup('Dismissed.') : dismissButton(comment.id, `Dismiss note ${index + 1}`))
  if (comment.status === 'variants' && comment.group) {
    const pick = pickOf(comment.group, state.batches)
    body.append(pick ? followup(`You picked “${pick.label}”.`) : showOnPage(comment.group))
  }
  // Several comments in a batch (the agent's notes) are numbered to tie each reply to its comment; one alone gets
  // its status as a glyph, since the label above says it in words only for questions and skips.
  const disc =
    batch.comments.length > 1
      ? el('span', { className: 'num', textContent: String(index + 1) })
      : el('span', { className: 'num', attrs: { 'aria-hidden': 'true' } }, [iconNode(statusIcon[comment.status], 11)])
  return el('li', { className: 'reply', attrs: { 'data-status': comment.status } }, [disc, body])
}

function agentSide(batch: Batch, context: ThreadContext): HTMLElement {
  const side = el('div', { className: 'agent' })
  if (batch.status === 'queued') {
    side.append(el('p', { className: 'waiting', textContent: `Waiting for ${batch.agent}` }))
    return side
  }
  const replied = batch.comments.flatMap((comment, index) => (comment.status === 'pending' ? [] : [reply(batch, comment, index, context)]))
  if (replied.length > 0) side.append(el('ol', { className: 'replies' }, replied))
  if (batch.status === 'fetched')
    side.append(el('p', { className: 'working', textContent: replied.length > 0 ? 'Working on the rest' : 'Working on it' }))
  if (batch.summary) side.append(el('p', { className: 'summary', textContent: batch.summary }))
  return side
}

function yourSide(batch: Batch): HTMLElement {
  const comments = batch.comments.map((comment, index) =>
    el('li', {}, [
      el('p', { className: 'ref' }, [
        ...(batch.comments.length > 1 ? [el('span', { className: 'num', textContent: String(index + 1) })] : []),
        el('span', { className: 'ref-text', textContent: where(comment) }),
      ]),
      el('p', { className: 'comment-text', textContent: comment.text }),
    ])
  )
  return el('div', { className: 'you' }, [
    el('div', { className: 'bubble' }, [el('ol', { className: 'bubble-comments' }, comments)]),
    el('p', { className: 'meta', textContent: `Sent ${when(batch.createdAt)}` }),
  ])
}

/** Notes the agent left: no message of yours, just the agent's notes under a line saying when. */
function notesSide(batch: Batch, context: ThreadContext): HTMLElement {
  return el('div', { className: 'agent' }, [
    el('p', { className: 'meta notes-meta', textContent: `Notes from ${batch.agent} · ${when(batch.createdAt)}` }),
    el(
      'ol',
      { className: 'replies' },
      batch.comments.map((comment, index) => reply(batch, comment, index, context))
    ),
  ])
}

/** One article per batch, oldest first. */
export function turns(context: ThreadContext): HTMLElement[] {
  return [...context.state.batches]
    .reverse()
    .map((batch) =>
      el(
        'article',
        { className: 'turn', attrs: { 'data-batch': batch.id, 'data-from': batch.from } },
        batch.from === 'agent' ? [notesSide(batch, context)] : [yourSide(batch), agentSide(batch, context)]
      )
    )
}
