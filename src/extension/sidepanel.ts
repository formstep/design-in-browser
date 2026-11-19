// Side panel as a chat with the coding agent (styled after Claude's): each sent batch is your message, the agent's replies follow it,
// and the composer at the bottom holds the stacked comments plus an optional note.
// Lists are rebuilt only when their data changes, so the periodic render never wipes text being typed.
import { FALLBACK_AGENT, START_COMMAND, type Batch, type BatchComment, type DraftComment, type PageRef, type SessionInfo } from '../shared/protocol.ts'
import { fillIcons, icon, type IconName } from './icons.ts'
import { defaultSession, onStateChange, pickKey, readState, sendToBackground, writeState, type ContentMessage, type ExtensionState } from './state.ts'

const $ = <T extends Element>(selector: string) => document.querySelector(selector) as T

const top = $<HTMLElement>('.top')
const project = $<HTMLElement>('.project')
const picker = $<HTMLLabelElement>('.picker')
const sessionSelect = $<HTMLSelectElement>('.picker select')
const pickerText = $<HTMLElement>('.picker-text')
const stateLabel = $<HTMLElement>('.state')
const thread = $<HTMLElement>('.thread')
const intro = $<HTMLElement>('.intro')
const introTitle = $<HTMLElement>('.intro-title')
const introText = $<HTMLElement>('.intro-text')
const commandButton = $<HTMLButtonElement>('.command')
const copied = $<HTMLElement>('.copied')
const turns = $<HTMLElement>('.turns')
const notice = $<HTMLElement>('.notice')
const errorLine = $<HTMLElement>('.error')
const errorText = $<HTMLElement>('.error-text')
const compose = $<HTMLFormElement>('.compose')
const draftList = $<HTMLOListElement>('.drafts')
const message = $<HTMLTextAreaElement>('.message')
const pickButton = $<HTMLButtonElement>('.pick')
const count = $<HTMLElement>('.count')
const sendButton = $<HTMLButtonElement>('.send')

const isMac = /mac/i.test(navigator.platform)
$<HTMLElement>('.shortcut').textContent = isMac ? '⌥⇧C' : 'Alt+Shift+C'
$<HTMLElement>('.command-text').textContent = START_COMMAND
fillIcons(document)

// Tests open this page as a normal tab and name the target tab with ?tabId=.
const pinnedTabId = Number(new URLSearchParams(location.search).get('tabId')) || null

type TargetTab = { id: number; url: string | undefined; title: string | undefined }

async function targetTab(): Promise<TargetTab | null> {
  const tab =
    pinnedTabId !== null
      ? await chrome.tabs.get(pinnedTabId).catch(() => null)
      : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]
  return tab?.id === undefined ? null : { id: tab.id, url: tab.url, title: tab.title }
}

type TabReply = { ok: boolean; picking?: boolean; page?: PageRef }

async function tellTab(content: ContentMessage): Promise<TabReply | null> {
  const tab = await targetTab()
  if (!tab) return null
  try {
    return await chrome.tabs.sendMessage(tab.id, content)
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

// --- header and intro ---------------------------------------------------------------

let renderedSessions = ''

function renderHeader(state: ExtensionState, session: SessionInfo | null): void {
  const connected = state.connection === 'connected'
  top.dataset.state = !connected || !session ? 'offline' : session.listening ? 'listening' : 'queued'
  stateLabel.textContent = !connected ? 'Offline' : !session ? 'No session' : session.listening ? `${session.agent} is listening` : 'Not listening'
  project.textContent = session ? session.label : 'Design in Browser'
  project.title = session ? [session.projectRoot, hostsOf(session)].filter(Boolean).join(' · ') : ''

  // A picker only when there is a choice to make.
  const choose = state.sessions.length > 1
  picker.hidden = !choose
  project.hidden = choose
  const signature = JSON.stringify(state.sessions.map((entry) => [entry.id, entry.label, entry.agent, entry.origins]))
  if (signature !== renderedSessions) {
    renderedSessions = signature
    sessionSelect.replaceChildren(
      ...state.sessions.map((entry) =>
        el('option', { value: entry.id, textContent: `${entry.label} · ${entry.agent}`, title: [entry.projectRoot, hostsOf(entry)].filter(Boolean).join(' · ') }),
      ),
    )
  }
  // A render that read state before the user's pick landed must not flip the select back under them.
  if (session && document.activeElement !== sessionSelect) sessionSelect.value = session.id
  const shown = state.sessions.find((entry) => entry.id === sessionSelect.value) ?? session
  pickerText.textContent = shown ? `${shown.label} · ${shown.agent}` : ''
}

function renderIntro(state: ExtensionState, session: SessionInfo | null, hasTurns: boolean): void {
  const needsStart = state.connection === 'offline' || !session
  intro.hidden = hasTurns && !needsStart
  commandButton.hidden = !needsStart
  if (state.connection === 'offline' || !session) {
    introTitle.textContent = state.connection === 'offline' ? 'Not connected to a coding agent' : 'No agent session'
    introText.textContent = 'Connect a session from your project. In Claude Code, run:'
  } else {
    introTitle.textContent = 'Comment on your app'
    introText.textContent = `Click Comment or press ${isMac ? '⌥⇧C' : 'Alt+Shift+C'}, then click anything on the page. ${session.agent} answers here.`
  }
}

commandButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(START_COMMAND)
  copied.hidden = false
  setTimeout(() => (copied.hidden = true), 1600)
})

// --- composer -----------------------------------------------------------------------

function where(comment: DraftComment | BatchComment): string {
  const path = new URL(comment.page.url).pathname
  if (!comment.element) return `Page · ${path}`
  const { tag, id, classes, text } = comment.element
  const name = `${tag}${id ? `#${id}` : ''}${classes.slice(0, 1).map((entry) => `.${entry}`).join('')}`
  return [name, text ? `“${text}”` : '', path].filter(Boolean).join(' · ')
}

let renderedDraft = ''

function renderComposer(state: ExtensionState, session: SessionInfo | null, canSend: boolean): void {
  const ready = state.draft.filter((comment) => comment.text.trim() !== '').length
  const typed = message.value.trim() !== ''
  sendButton.disabled = !canSend || state.sending || (ready === 0 && !typed)
  sendButton.title = canSend ? '' : 'Connect an agent session to send'
  sendButton.setAttribute('aria-label', `Send to ${session?.agent ?? FALLBACK_AGENT}`)
  count.textContent = ready ? `${ready} ${ready === 1 ? 'comment' : 'comments'}` : ''
  errorLine.hidden = !state.lastError
  errorText.textContent = state.lastError ?? ''

  const signature = JSON.stringify(state.draft.map((comment) => [comment.id, comment.text, comment.page.url]))
  if (signature === renderedDraft) return
  renderedDraft = signature
  const focused = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.dataset.id : undefined

  draftList.replaceChildren(
    ...state.draft.map((comment, index) => {
      const field = el('textarea', { rows: 1, value: comment.text, placeholder: comment.inReplyTo ? 'Your answer' : 'What should change?' })
      field.dataset.id = comment.id
      field.setAttribute('aria-label', `Comment ${index + 1}`)
      field.addEventListener('change', () => void sendToBackground({ type: 'update-comment', id: comment.id, text: field.value }))
      const remove = el('button', { type: 'button', className: 'icon-button', title: 'Remove comment' }, [iconNode('close', 14)])
      remove.setAttribute('aria-label', `Remove comment ${index + 1}`)
      remove.addEventListener('click', () => void sendToBackground({ type: 'remove-comment', id: comment.id }))
      const item = el('li', { className: 'draft' }, [
        el('div', { className: 'draft-head' }, [
          el('span', { className: 'num', textContent: String(index + 1) }),
          el('span', { className: 'draft-where', textContent: where(comment), title: comment.element?.selector ?? comment.page.url }),
          remove,
        ]),
        ...(comment.inReplyTo ? [el('p', { className: 'draft-context' }, [el('b', { textContent: `${askedBy(state, session, comment.inReplyTo.batchId)} asked: ` }), comment.inReplyTo.question])] : []),
        field,
      ])
      item.dataset.testid = 'draft-item'
      return item
    }),
  )
  if (focused) draftList.querySelector<HTMLTextAreaElement>(`textarea[data-id="${CSS.escape(focused)}"]`)?.focus()
}

/** The agent that asked a question: the one that owns its batch. Batch ids repeat per project, so match the project too. */
function askedBy(state: ExtensionState, session: SessionInfo | null, batchId: string): string {
  return state.batches.find((batch) => batch.id === batchId && batch.projectRoot === session?.projectRoot)?.agent ?? session?.agent ?? FALLBACK_AGENT
}

async function pageFor(tab: TargetTab | null): Promise<PageRef> {
  const reply = await tellTab({ type: 'page-info' })
  return reply?.page ?? { url: tab?.url ?? '', title: tab?.title ?? '', viewport: { width: 0, height: 0 } }
}

async function send(): Promise<void> {
  const [state, tab] = await Promise.all([readState(), targetTab()])
  const session = state.sessions.find((entry) => entry.id === sessionSelect.value) ?? defaultSession(state, tab?.url)
  const text = message.value.trim()
  const ready = state.draft.some((comment) => comment.text.trim() !== '')
  if (!session || state.connection !== 'connected' || state.sending || (!ready && text === '')) return
  if (text !== '') {
    const note: DraftComment = { id: crypto.randomUUID(), text, page: await pageFor(tab), element: null, inReplyTo: null, createdAt: new Date().toISOString() }
    await sendToBackground({ type: 'add-comment', comment: note })
    message.value = ''
  }
  await sendToBackground({ type: 'send', sessionId: session.id })
  scrollToEnd = true
}

compose.addEventListener('submit', (event) => {
  event.preventDefault()
  void send()
})
message.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void send()
  }
})
message.addEventListener('input', () => scheduleRender())

// --- thread ---------------------------------------------------------------------------

const statusWord: Record<BatchComment['status'], string> = {
  pending: 'Waiting',
  done: 'Done',
  question: 'Question',
  skipped: 'Skipped',
}

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const dayAndTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const when = (iso: string) => {
  const date = new Date(iso)
  return (date.toDateString() === new Date().toDateString() ? time : dayAndTime).format(date)
}

/** Answers being typed under Claude's questions, by comment id. Kept outside the DOM so a rebuild doesn't lose them. */
const answerDrafts = new Map<string, string>()
let renderedTurns = ''
let scrollToEnd = true

/** Where each question's answer is: in the composer, or sent in a batch. */
function answers(state: ExtensionState): Map<string, string> {
  const found = new Map<string, string>()
  for (const batch of state.batches) {
    for (const comment of batch.comments) if (comment.inReplyTo) found.set(comment.inReplyTo.commentId, `Answered in batch ${batch.id}.`)
  }
  for (const comment of state.draft) if (comment.inReplyTo) found.set(comment.inReplyTo.commentId, 'Your answer is in the composer, ready to send.')
  return found
}

function answerForm(batch: Batch, comment: BatchComment): HTMLFormElement {
  const field = el('textarea', { rows: 1, value: answerDrafts.get(comment.id) ?? '', placeholder: `Answer ${batch.agent}` })
  field.dataset.answer = comment.id
  field.dataset.testid = 'answer-field'
  field.setAttribute('aria-label', `Answer to: ${comment.reply ?? comment.text}`)
  field.addEventListener('input', () => answerDrafts.set(comment.id, field.value))
  const submitButton = el('button', { type: 'submit', className: 'send', title: 'Add answer' }, [iconNode('arrowUp', 15)])
  submitButton.setAttribute('aria-label', 'Add answer')
  const form = el('form', { className: 'answer' }, [field, submitButton])
  const submit = async () => {
    const text = field.value.trim()
    if (text === '') {
      field.focus()
      return
    }
    answerDrafts.delete(comment.id)
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
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void submit()
    }
  })
  return form
}

function claudeSide(batch: Batch, answered: Map<string, string>): HTMLElement {
  const side = el('div', { className: 'agent' })
  if (batch.status === 'queued') {
    side.append(el('p', { className: 'waiting', textContent: `Waiting for ${batch.agent}` }))
    return side
  }
  const replied = batch.comments.map((comment, index) => ({ comment, index })).filter(({ comment }) => comment.status !== 'pending')
  if (replied.length > 0) {
    side.append(
      el(
        'ol',
        { className: 'replies' },
        replied.map(({ comment, index }) => {
          // The numbered disc ties a reply to its comment; only a question or a skip gets a visible label.
          const label =
            comment.status === 'done'
              ? el('span', { className: 'visually-hidden', textContent: `Done, comment ${index + 1}: ` })
              : el('p', { className: 'reply-label', textContent: statusWord[comment.status] })
          const body = el('div', {}, [label, el('p', { className: 'reply-text', textContent: comment.reply ?? '' })])
          const followup = answered.get(comment.id)
          if (comment.status === 'question') body.append(followup ? el('p', { className: 'followup', textContent: followup }) : answerForm(batch, comment))
          const item = el('li', { className: 'reply' }, [el('span', { className: 'num', textContent: String(index + 1) }), body])
          item.dataset.status = comment.status
          return item
        }),
      ),
    )
  }
  if (batch.status === 'fetched') side.append(el('p', { className: 'working', textContent: replied.length > 0 ? 'Working on the rest' : 'Working on it' }))
  if (batch.summary) side.append(el('p', { className: 'summary', textContent: batch.summary }))
  return side
}

function renderTurns(state: ExtensionState, batches: Batch[]): void {
  const answered = answers(state)
  const signature = JSON.stringify([batches, [...answered]])
  if (signature === renderedTurns) return
  renderedTurns = signature
  const focused = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement.dataset.answer : undefined

  turns.replaceChildren(
    ...[...batches].reverse().map((batch) => {
      const you = el('div', { className: 'you' }, [
        el('div', { className: 'bubble' }, [
          el(
            'ol',
            { className: 'bubble-comments' },
            batch.comments.map((comment, index) =>
              el('li', {}, [
                el('p', { className: 'ref' }, [el('span', { className: 'num', textContent: String(index + 1) }), el('span', { className: 'ref-text', textContent: where(comment) })]),
                el('p', { className: 'comment-text', textContent: comment.text }),
              ]),
            ),
          ),
        ]),
        el('p', { className: 'meta', textContent: `Batch ${batch.id} · ${when(batch.createdAt)}` }),
      ])
      const turn = el('article', { className: 'turn' }, [you, claudeSide(batch, answered)])
      turn.dataset.batch = batch.id
      return turn
    }),
  )
  if (focused) turns.querySelector<HTMLTextAreaElement>(`textarea[data-answer="${CSS.escape(focused)}"]`)?.focus()
  if (scrollToEnd) atEnd = true
  scrollToEnd = false
  keepEnd()
}

/** True while the reader is at the end of the thread; then growth anywhere (new replies, a taller composer) keeps the end in view. */
let atEnd = true
thread.addEventListener('scroll', () => {
  atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40
})
function keepEnd(): void {
  if (atEnd) thread.scrollTop = thread.scrollHeight
}
new ResizeObserver(keepEnd).observe(document.querySelector('.bottom')!)
new ResizeObserver(keepEnd).observe(turns)

// --- render loop -----------------------------------------------------------------

async function render(): Promise<void> {
  const [state, tab] = await Promise.all([readState(), targetTab()])
  const session = defaultSession(state, tab?.url)
  renderHeader(state, session)

  const reply = await tellTab({ type: 'ping' })
  const pageReady = reply?.ok === true
  pickButton.disabled = !pageReady
  pickButton.setAttribute('aria-pressed', String(reply?.picking === true))

  const connected = state.connection === 'connected' && session !== null
  notice.hidden = pageReady && (!connected || session.listening)
  notice.textContent = !pageReady
    ? 'Open your app on a local dev server (localhost, *.localhost or *.test). If the extension was just installed, reload the tab.'
    : `${session?.agent ?? FALLBACK_AGENT} isn’t listening right now. What you send waits until it’s back.`

  renderComposer(state, session, connected)
  const batches = session ? state.batches.filter((batch) => batch.projectRoot === session.projectRoot) : state.batches
  renderIntro(state, session, batches.length > 0)
  renderTurns(state, batches)
}

let rendering: Promise<void> = Promise.resolve()
function scheduleRender(): void {
  rendering = rendering.then(render, render)
}

sessionSelect.addEventListener('change', async () => {
  const [state, tab] = await Promise.all([readState(), targetTab()])
  await writeState({ pickedSessions: { ...state.pickedSessions, [pickKey(tab?.url)]: sessionSelect.value } })
})
pickButton.addEventListener('click', async () => {
  await tellTab({ type: 'toggle-picker' })
  scheduleRender()
})

onStateChange(() => scheduleRender())
chrome.tabs.onActivated.addListener(() => scheduleRender())
chrome.tabs.onUpdated.addListener((_id, change) => {
  if (change.status === 'complete' || change.url) scheduleRender()
})
// The picker can be toggled from the page with the shortcut; poll so the button state follows.
setInterval(() => scheduleRender(), 1500)
scheduleRender()
