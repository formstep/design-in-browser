// Side panel: connection state, the comment stack, Send, and Claude's replies with answers to its questions.
// Lists are rebuilt only when their data changes, so the periodic render never wipes text being typed.
import { START_COMMAND, type Batch, type BatchComment, type DraftComment, type SessionInfo } from '../shared/protocol.ts'
import { fillIcons, icon, type IconName } from './icons.ts'
import { defaultSession, onStateChange, pickKey, readState, sendToBackground, writeState, type ContentMessage, type ExtensionState } from './state.ts'

const $ = <T extends Element>(selector: string) => document.querySelector(selector) as T

const status = $<HTMLElement>('.status')
const statusTitle = $<HTMLElement>('.status-title')
const statusDetail = $<HTMLElement>('.status-detail')
const commandButton = $<HTMLButtonElement>('.command')
const copied = $<HTMLElement>('.copied')
const sessionLabel = $<HTMLLabelElement>('.session')
const sessionSelect = $<HTMLSelectElement>('.session select')
const pickButton = $<HTMLButtonElement>('.pick')
const noteButton = $<HTMLButtonElement>('.note')
const tabHint = $<HTMLElement>('.tab-hint')
const draftCount = $<HTMLElement>('.count')
const draftList = $<HTMLOListElement>('.draft')
const draftEmpty = $<HTMLElement>('.draft-empty')
const sendButton = $<HTMLButtonElement>('.send')
const sendLabel = $<HTMLElement>('.send-label')
const errorLine = $<HTMLElement>('.error')
const errorText = $<HTMLElement>('.error-text')
const sentSection = $<HTMLElement>('.sent-section')
const sentList = $<HTMLElement>('.sent')

const isMac = /mac/i.test(navigator.platform)
$<HTMLElement>('.shortcut').textContent = isMac ? '⌥⇧C' : 'Alt+Shift+C'
$<HTMLElement>('.command-text').textContent = START_COMMAND
fillIcons(document)

// Tests open this page as a normal tab and name the target tab with ?tabId=.
const pinnedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null

type TargetTab = { id: number; url: string | undefined }

async function targetTab(): Promise<TargetTab | null> {
  if (pinnedTabId !== null) {
    const tab = await chrome.tabs.get(pinnedTabId).catch(() => null)
    return tab?.id === undefined ? null : { id: tab.id, url: tab.url }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab?.id === undefined ? null : { id: tab.id, url: tab.url }
}

async function tellTab(message: ContentMessage): Promise<{ ok: boolean; picking?: boolean } | null> {
  const tab = await targetTab()
  if (!tab) return null
  try {
    return await chrome.tabs.sendMessage(tab.id, message)
  } catch {
    return null
  }
}

type Props = { className?: string; textContent?: string; title?: string; value?: string; type?: string; rows?: number; placeholder?: string }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, children: Array<Node | string> = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  Object.assign(node, props)
  node.append(...children)
  return node
}

function iconNode(name: IconName, size = 16): Element {
  const holder = document.createElement('span')
  holder.innerHTML = icon(name, size)
  return holder.firstElementChild!
}

const hostsOf = (session: SessionInfo) => session.origins.map((origin) => new URL(origin).host).join(', ')

// --- status --------------------------------------------------------------------

let renderedSessions = ''

function renderStatus(state: ExtensionState, session: SessionInfo | null): void {
  commandButton.hidden = state.connection === 'connected' && session !== null
  if (state.connection === 'offline') {
    status.dataset.state = 'offline'
    statusTitle.textContent = 'Not connected to Claude Code'
    statusDetail.textContent = 'Run this in a Claude Code session in your project:'
  } else if (!session) {
    status.dataset.state = 'offline'
    statusTitle.textContent = 'No Claude Code session'
    statusDetail.textContent = 'Run this in a Claude Code session in your project:'
  } else if (session.listening) {
    status.dataset.state = 'listening'
    statusTitle.textContent = 'Claude is listening'
    statusDetail.textContent = [session.label, hostsOf(session)].filter(Boolean).join(' · ')
  } else {
    status.dataset.state = 'queued'
    statusTitle.textContent = 'Claude isn’t listening right now'
    statusDetail.textContent = `${session.label} · what you send waits until it’s back`
  }
  statusDetail.title = session?.projectRoot ?? ''

  // The picker only shows when there is a choice to make.
  sessionLabel.hidden = state.sessions.length < 2
  const signature = JSON.stringify(state.sessions.map((entry) => [entry.id, entry.label, entry.origins]))
  if (signature !== renderedSessions) {
    renderedSessions = signature
    sessionSelect.replaceChildren(
      ...state.sessions.map((entry) => el('option', { value: entry.id, textContent: [entry.label, hostsOf(entry)].filter(Boolean).join(' · ') })),
    )
  }
  // A render that read state before the user's pick landed must not flip the select back under them.
  if (session && document.activeElement !== sessionSelect) sessionSelect.value = session.id
}

commandButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(START_COMMAND)
  copied.hidden = false
  setTimeout(() => (copied.hidden = true), 1600)
})

// --- drafts --------------------------------------------------------------------

function describe(comment: DraftComment): { code: string; text: string } {
  if (!comment.element) return { code: 'Page', text: 'note' }
  const { tag, id, classes, text } = comment.element
  return {
    code: `${tag}${id ? `#${id}` : ''}${classes.slice(0, 2).map((name) => `.${name}`).join('')}`,
    text: text ? `“${text}”` : '',
  }
}

let renderedDraft = ''

function renderDraft(state: ExtensionState, canSend: boolean): void {
  const ready = state.draft.filter((comment) => comment.text.trim() !== '').length
  sendButton.disabled = !canSend || ready === 0 || state.sending
  sendLabel.textContent = state.sending ? 'Sending…' : ready ? `Send ${ready} ${ready === 1 ? 'comment' : 'comments'}` : 'Send'
  sendButton.title = canSend || ready === 0 ? '' : 'Connect a Claude Code session to send'
  errorLine.hidden = !state.lastError
  errorText.textContent = state.lastError ?? ''

  const signature = JSON.stringify(state.draft.map((comment) => [comment.id, comment.text, comment.page.url]))
  if (signature === renderedDraft) return
  renderedDraft = signature
  draftCount.textContent = state.draft.length ? String(state.draft.length) : ''
  draftEmpty.hidden = state.draft.length > 0
  const focused = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.dataset.id : undefined

  draftList.replaceChildren(
    ...state.draft.map((comment, index) => {
      const { code, text } = describe(comment)
      const textarea = el('textarea', { rows: 1, value: comment.text, placeholder: comment.inReplyTo ? 'Your answer' : 'What should change?' })
      textarea.dataset.id = comment.id
      textarea.setAttribute('aria-label', `Comment ${index + 1}`)
      textarea.addEventListener('change', () => void sendToBackground({ type: 'update-comment', id: comment.id, text: textarea.value }))
      const remove = el('button', { type: 'button', className: 'icon-button', title: 'Remove comment' }, [iconNode('close', 15)])
      remove.setAttribute('aria-label', `Remove comment ${index + 1}`)
      remove.addEventListener('click', () => void sendToBackground({ type: 'remove-comment', id: comment.id }))
      const path = new URL(comment.page.url).pathname
      const item = el('li', { className: 'comment' }, [
        el('div', { className: 'comment-head' }, [
          el('span', { className: 'badge', textContent: String(index + 1) }),
          el('span', { className: 'where', title: comment.element?.selector ?? comment.page.url }, [
            el('code', { textContent: code }),
            el('span', { className: 'where-text', textContent: text }),
          ]),
          el('span', { className: 'path', textContent: path, title: comment.page.url }),
          remove,
        ]),
        ...(comment.inReplyTo ? [el('p', { className: 'context' }, [el('b', { textContent: 'Claude asked: ' }), comment.inReplyTo.question])] : []),
        textarea,
      ])
      item.dataset.testid = 'draft-item'
      return item
    }),
  )
  if (focused) draftList.querySelector<HTMLTextAreaElement>(`textarea[data-id="${CSS.escape(focused)}"]`)?.focus()
}

// --- sent -----------------------------------------------------------------------

const batchState: Record<Batch['status'], string> = {
  queued: 'Waiting for Claude',
  fetched: 'Claude is working',
  done: 'Done',
}

const commentState: Record<BatchComment['status'], string> = {
  pending: 'Waiting',
  done: 'Done',
  question: 'Question',
  skipped: 'Skipped',
}

const statusGlyph: Record<BatchComment['status'], IconName> = { pending: 'clock', done: 'check', question: 'question', skipped: 'minus' }

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayAndTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const when = (iso: string) => {
  const date = new Date(iso)
  return (date.toDateString() === new Date().toDateString() ? time : dayAndTime).format(date)
}

/** The answer being written in the Sent list. Kept outside the DOM so a rebuild doesn't lose it. */
let composer: { commentId: string; text: string } | null = null
let renderedSent = ''

/** Where each question's answer is: in the draft, or sent in a batch. */
function answers(state: ExtensionState): Map<string, string> {
  const where = new Map<string, string>()
  for (const batch of state.batches) {
    for (const comment of batch.comments) if (comment.inReplyTo) where.set(comment.inReplyTo.commentId, `Answered in batch ${batch.id}.`)
  }
  for (const comment of state.draft) if (comment.inReplyTo) where.set(comment.inReplyTo.commentId, 'Your answer is in Comments, ready to send.')
  return where
}

function sentComment(batch: Batch, comment: BatchComment, answered: Map<string, string>): HTMLElement {
  const body = el('div', {}, [
    el('span', { className: 'visually-hidden', textContent: `${commentState[comment.status]}: ` }),
    el('p', { className: 'sent-text', textContent: comment.text }),
  ])
  if (comment.reply) body.append(el('p', { className: 'reply' }, [el('b', { textContent: 'Claude: ' }), comment.reply]))
  const followup = answered.get(comment.id)
  if (comment.status === 'question' && followup) body.append(el('p', { className: 'followup', textContent: followup }))
  else if (comment.status === 'question') body.append(answerControls(batch, comment))

  const item = el('li', { className: 'sent-comment' }, [
    el('span', { className: 'status-icon', title: commentState[comment.status] }, [iconNode(statusGlyph[comment.status], 11)]),
    body,
  ])
  item.dataset.status = comment.status
  return item
}

function answerControls(batch: Batch, comment: BatchComment): HTMLElement {
  if (composer?.commentId !== comment.id) {
    const button = el('button', { type: 'button', className: 'button small answer-button' }, [iconNode('reply', 14), 'Answer'])
    button.dataset.testid = 'answer'
    button.addEventListener('click', () => {
      composer = { commentId: comment.id, text: '' }
      scheduleRender({ focusComposer: true })
    })
    return button
  }
  const textarea = el('textarea', { rows: 1, value: composer.text, placeholder: 'Your answer' })
  textarea.setAttribute('aria-label', `Answer to: ${comment.reply ?? comment.text}`)
  textarea.dataset.composer = 'true'
  textarea.addEventListener('input', () => {
    if (composer) composer.text = textarea.value
  })
  const cancel = el('button', { type: 'button', className: 'button small quiet', textContent: 'Cancel' })
  cancel.addEventListener('click', () => {
    composer = null
    scheduleRender()
  })
  const add = el('button', { type: 'submit', className: 'button small primary', textContent: 'Add answer' })
  const form = el('form', { className: 'composer' }, [textarea, el('div', { className: 'composer-actions' }, [cancel, add])])
  const submit = async () => {
    const text = textarea.value.trim()
    if (text === '') {
      textarea.focus()
      return
    }
    composer = null
    await sendToBackground({
      type: 'add-comment',
      comment: {
        id: crypto.randomUUID(),
        text,
        page: comment.page,
        element: comment.element,
        inReplyTo: { batchId: batch.id, commentId: comment.id, comment: comment.text, question: comment.reply ?? '' },
        createdAt: new Date().toISOString(),
      },
    })
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void submit()
  })
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void submit()
    }
    if (event.key === 'Escape') cancel.click()
  })
  return form
}

function renderSent(state: ExtensionState, batches: Batch[], focusComposer: boolean): void {
  const answered = answers(state)
  const signature = JSON.stringify([batches, [...answered], composer?.commentId ?? null])
  if (signature === renderedSent && !focusComposer) return
  const hadFocus = document.activeElement instanceof HTMLTextAreaElement && document.activeElement.dataset.composer === 'true'
  renderedSent = signature
  sentSection.hidden = batches.length === 0
  sentList.replaceChildren(
    ...batches.map((batch) => {
      const label = el('span', { className: 'batch-state', textContent: batchState[batch.status] })
      label.dataset.status = batch.status
      return el('article', { className: 'batch' }, [
        el('header', { className: 'batch-head' }, [
          el('span', { className: 'batch-title', textContent: `Batch ${batch.id}` }),
          el('span', { className: 'batch-meta' }, [label, ` · ${when(batch.createdAt)}`]),
        ]),
        ...(batch.summary ? [el('p', { className: 'batch-summary', textContent: batch.summary })] : []),
        el('ul', { className: 'sent-comments' }, batch.comments.map((comment) => sentComment(batch, comment, answered))),
      ])
    }),
  )
  if (focusComposer || hadFocus) sentList.querySelector<HTMLTextAreaElement>('textarea[data-composer]')?.focus()
}

// --- render loop -----------------------------------------------------------------

async function render(focusComposer: boolean): Promise<void> {
  const [state, tab] = await Promise.all([readState(), targetTab()])
  const session = defaultSession(state, tab?.url)
  renderStatus(state, session)

  const reply = await tellTab({ type: 'ping' })
  const pageReady = reply?.ok === true
  pickButton.disabled = !pageReady
  noteButton.disabled = !pageReady
  pickButton.setAttribute('aria-pressed', String(reply?.picking === true))
  tabHint.hidden = pageReady

  renderDraft(state, state.connection === 'connected' && session !== null)
  const project = session?.projectRoot
  renderSent(state, project ? state.batches.filter((batch) => batch.projectRoot === project) : state.batches, focusComposer)
}

let rendering: Promise<void> = Promise.resolve()
function scheduleRender(options: { focusComposer?: boolean } = {}): void {
  const run = () => render(options.focusComposer === true)
  rendering = rendering.then(run, run)
}

sessionSelect.addEventListener('change', async () => {
  const [state, tab] = await Promise.all([readState(), targetTab()])
  await writeState({ pickedSessions: { ...state.pickedSessions, [pickKey(tab?.url)]: sessionSelect.value } })
})
pickButton.addEventListener('click', async () => {
  await tellTab({ type: 'toggle-picker' })
  scheduleRender()
})
noteButton.addEventListener('click', () => void tellTab({ type: 'page-note' }))
sendButton.addEventListener('click', async () => {
  const [state, tab] = await Promise.all([readState(), targetTab()])
  const session = state.sessions.find((entry) => entry.id === sessionSelect.value) ?? defaultSession(state, tab?.url)
  if (session) await sendToBackground({ type: 'send', sessionId: session.id })
})

onStateChange(() => scheduleRender())
chrome.tabs.onActivated.addListener(() => scheduleRender())
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.status === 'complete' || change.url) scheduleRender()
})
// The picker can be toggled from the page with the shortcut; poll so the button state follows.
setInterval(() => scheduleRender(), 1500)
scheduleRender()
