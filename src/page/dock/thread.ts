// The dock's thread: each sent batch is your message, and the agent's numbered replies follow it, with a field
// under each question to answer it and a link from alternatives to their switcher on the page.
import type { Batch, BatchComment, DraftComment } from '../../shared/protocol.ts'
import { answering, newComment } from '../comments.ts'
import { sendOp, type PageState } from '../store.ts'
import { button, el, iconNode } from '../ui/dom.ts'
import { submitOnEnter } from '../ui/events.ts'
import { when } from '../ui/format.ts'

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

/** Where a comment points: the element and its text, or the page, plus the route. */
export function where(comment: DraftComment): string {
  const path = new URL(comment.page.url).pathname
  const marks = comment.marks?.length ?? 0
  const drawn = marks === 0 ? '' : marks === 1 ? 'A mark on ' : `${marks} marks on `
  if (!comment.element) return `${drawn}Page · ${path}`
  const { tag, id, classes, text } = comment.element
  const name = `${tag}${id ? `#${id}` : ''}${classes
    .slice(0, 1)
    .map((entry) => `.${entry}`)
    .join('')}`
  return drawn + [name, text ? `“${text}”` : '', path].filter(Boolean).join(' · ')
}

/** Where each question's answer is: in the composer, or sent in a batch. */
export function answerPlaces(state: PageState): Map<string, string> {
  const found = new Map<string, string>()
  for (const batch of state.batches) {
    for (const comment of batch.comments) if (comment.inReplyTo) found.set(comment.inReplyTo.commentId, `Answered in batch ${batch.id}.`)
  }
  for (const comment of state.draft)
    if (comment.inReplyTo) found.set(comment.inReplyTo.commentId, 'Your answer is in the composer, ready to send.')
  return found
}

/** Scrolls the page to a `<Variants>` group, where its switcher is. */
function showOnPage(group: string): HTMLElement {
  const link = button({ className: 'show-group', textContent: 'Show on page', attrs: { 'data-testid': 'show-group' } })
  link.addEventListener('click', () => {
    const wrapper = document.querySelector(`dib-variants[data-group="${CSS.escape(group)}"]`)
    wrapper?.firstElementChild?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
  return link
}

function answerForm(batch: Batch, comment: BatchComment): HTMLFormElement {
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
  const submitButton = el('button', { className: 'send', title: 'Add answer', attrs: { type: 'submit', 'aria-label': 'Add answer' } }, [
    iconNode('arrowUp', 15),
  ])
  const form = el('form', { className: 'answer' }, [field, submitButton])
  const submit = async () => {
    const text = field.value.trim()
    if (text === '') {
      field.focus()
      return
    }
    answerDrafts.delete(comment.id)
    await sendOp({
      type: 'add-comment',
      comment: newComment({ text, page: comment.page, element: comment.element, inReplyTo: answering(batch, comment) }),
    })
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void submit()
  })
  submitOnEnter(field, () => void submit())
  return form
}

/** Where an agent's note points, as the agent named it. */
const anchorText = (comment: BatchComment) =>
  comment.anchor ? ('selector' in comment.anchor ? comment.anchor.selector : comment.anchor.source) : ''

function reply(batch: Batch, comment: BatchComment, index: number, answered: Map<string, string>): HTMLElement {
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
  if (comment.status === 'question') {
    const followup = answered.get(comment.id)
    body.append(followup ? el('p', { className: 'followup', textContent: followup }) : answerForm(batch, comment))
  }
  if (comment.status === 'variants' && comment.group) body.append(showOnPage(comment.group))
  return el('li', { className: 'reply', attrs: { 'data-status': comment.status } }, [
    el('span', { className: 'num', textContent: String(index + 1) }),
    body,
  ])
}

function agentSide(batch: Batch, answered: Map<string, string>): HTMLElement {
  const side = el('div', { className: 'agent' })
  if (batch.status === 'queued') {
    side.append(el('p', { className: 'waiting', textContent: `Waiting for ${batch.agent}` }))
    return side
  }
  const replied = batch.comments.flatMap((comment, index) => (comment.status === 'pending' ? [] : [reply(batch, comment, index, answered)]))
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
        el('span', { className: 'num', textContent: String(index + 1) }),
        el('span', { className: 'ref-text', textContent: where(comment) }),
      ]),
      el('p', { className: 'comment-text', textContent: comment.text }),
    ])
  )
  return el('div', { className: 'you' }, [
    el('div', { className: 'bubble' }, [el('ol', { className: 'bubble-comments' }, comments)]),
    el('p', { className: 'meta', textContent: `Batch ${batch.id} · ${when(batch.createdAt)}` }),
  ])
}

/** Notes the agent left: no message of yours, just the agent's notes under a line saying when. */
function notesSide(batch: Batch, answered: Map<string, string>): HTMLElement {
  return el('div', { className: 'agent' }, [
    el('p', { className: 'meta notes-meta', textContent: `Notes from ${batch.agent} · ${when(batch.createdAt)}` }),
    el(
      'ol',
      { className: 'replies' },
      batch.comments.map((comment, index) => reply(batch, comment, index, answered))
    ),
  ])
}

/** One article per batch, oldest first. */
export function turns(batches: Batch[], answered: Map<string, string>): HTMLElement[] {
  return [...batches]
    .reverse()
    .map((batch) =>
      el(
        'article',
        { className: 'turn', attrs: { 'data-batch': batch.id, 'data-from': batch.from } },
        batch.from === 'agent' ? [notesSide(batch, answered)] : [yourSide(batch), agentSide(batch, answered)]
      )
    )
}
