// The dock: a chat with the coding agent inside the app's page, opened from a launcher in the bottom-right
// corner (Alt+Shift+D). The header names the session, the thread shows sent batches and the agent's replies,
// and the composer at the bottom holds the stacked comments plus an optional note.
// Lists are rebuilt only when their data changes, so the periodic render never wipes text being typed.
import { FALLBACK_AGENT, START_COMMAND, type SessionInfo } from '../../shared/protocol.ts'
import { capturePage } from '../capture.ts'
import { newComment } from '../comments.ts'
import { fillIcons } from '../icons.ts'
import { isPicking, onModeChange, togglePicker } from '../overlay/mode.ts'
import { defaultSession, onStateChange, readState, sendOp, type PageState } from '../store.ts'
import { el, iconNode, query } from '../ui/dom.ts'
import { frameScheduler, keepKeys, submitOnEnter } from '../ui/events.ts'
import { plural } from '../ui/format.ts'
import { registerUiHost, setReservedRight } from '../ui/layout.ts'
import { createShadowHost } from '../ui/shadow-host.ts'
import dockCss from './dock.css'
import { answerPlaces, turns, where } from './thread.ts'

const DOCK_WIDTH = 380
const OPEN_KEY = 'design-in-browser:dock-open'
const PICK_SHORTCUT = /mac/i.test(navigator.platform) ? '⌥⇧C' : 'Alt+Shift+C'

const { host, root } = createShadowHost('dib-dock', dockCss)
registerUiHost(host)
root.innerHTML = `
<button type="button" class="launcher" data-testid="launcher" aria-label="Open Design in Browser" title="Comments (⌥⇧D)">
  <span data-icon="comment" data-size="18"></span><span class="launcher-count"></span>
</button>
<aside class="dock" aria-label="Design in Browser" hidden>
  <header class="top">
    <span class="dot" aria-hidden="true"></span>
    <div class="title">
      <span class="project"></span>
      <label class="picker" hidden>
        <span class="picker-text"></span>
        <span data-icon="chevronDown" data-size="14"></span>
        <select data-testid="session" aria-label="Agent session"></select>
      </label>
    </div>
    <span class="state" data-testid="status" aria-live="polite"></span>
    <button type="button" class="icon-button close" aria-label="Close" title="Close (⌥⇧D)"><span data-icon="close" data-size="15"></span></button>
  </header>
  <main class="thread" data-testid="sent">
    <div class="intro">
      <p class="intro-title"></p>
      <p class="intro-text"></p>
      <button type="button" class="command" data-testid="copy-command" hidden>
        <code class="command-text"></code>
        <span data-icon="copy" data-size="14"></span>
        <span class="copied" hidden>Copied</span>
      </button>
    </div>
    <div class="turns"></div>
  </main>
  <footer class="bottom">
    <p class="notice" hidden></p>
    <p class="error" data-testid="error" role="alert" hidden><span data-icon="alert" data-size="15"></span><span class="error-text"></span></p>
    <form class="compose">
      <ol class="drafts" data-testid="draft"></ol>
      <textarea class="message" data-testid="message" rows="1" placeholder="Describe a change" aria-label="Message about this page"></textarea>
      <div class="compose-bar">
        <button type="button" class="tool pick" data-testid="pick" aria-pressed="false" title="Comment on an element">
          <span data-icon="comment" data-size="16"></span><span>Comment</span><kbd class="shortcut"></kbd>
        </button>
        <span class="count"></span>
        <button type="submit" class="send" data-testid="send" aria-label="Send" disabled><span data-icon="arrowUp" data-size="16"></span></button>
      </div>
    </form>
  </footer>
</aside>`
fillIcons(root)

const $ = <T extends Element>(selector: string) => query<T>(root, selector)
const launcher = $<HTMLButtonElement>('.launcher')
const launcherCount = $<HTMLElement>('.launcher-count')
const dock = $<HTMLElement>('.dock')
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
const turnList = $<HTMLElement>('.turns')
const notice = $<HTMLElement>('.notice')
const errorLine = $<HTMLElement>('.error')
const errorText = $<HTMLElement>('.error-text')
const compose = $<HTMLFormElement>('.compose')
const draftList = $<HTMLOListElement>('.drafts')
const message = $<HTMLTextAreaElement>('.message')
const pickButton = $<HTMLButtonElement>('.pick')
const count = $<HTMLElement>('.count')
const sendButton = $<HTMLButtonElement>('.send')

$<HTMLElement>('.shortcut').textContent = PICK_SHORTCUT
$<HTMLElement>('.command-text').textContent = START_COMMAND
keepKeys(dock)

const scheduleRender = frameScheduler(render)

// --- open and close ------------------------------------------------------------------

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function setOpen(open: boolean): void {
  dock.hidden = !open
  launcher.hidden = open
  setReservedRight(open ? DOCK_WIDTH : 0)
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    // A page that blocks storage just opens closed next time.
  }
  if (open) scheduleRender()
}

launcher.addEventListener('click', () => setOpen(true))
$<HTMLButtonElement>('.close').addEventListener('click', () => setOpen(false))
window.addEventListener(
  'keydown',
  (event) => {
    if (!(event.altKey && event.shiftKey && event.code === 'KeyD')) return
    event.preventDefault()
    event.stopImmediatePropagation()
    // `hidden` can also be "until-found"; the attribute alone says whether the dock is closed.
    setOpen(dock.hasAttribute('hidden'))
  },
  true,
)

const hostsOf = (session: SessionInfo) => session.origins.map((origin) => new URL(origin).host).join(', ')
const describeSession = (session: SessionInfo) => [session.projectRoot, hostsOf(session)].filter(Boolean).join(' · ')

// --- header and intro ---------------------------------------------------------------

let renderedSessions = ''

function renderHeader(state: PageState, session: SessionInfo | null): void {
  const connected = state.connection === 'connected'
  top.dataset.state = !connected || !session ? 'offline' : session.listening ? 'listening' : 'queued'
  stateLabel.textContent = !connected ? 'Offline' : !session ? 'No session' : session.listening ? `${session.agent} is listening` : 'Not listening'
  project.textContent = session ? session.label : 'Design in Browser'
  project.title = session ? describeSession(session) : ''

  // A picker when there is a choice to make, or when no session works on this project: then the user
  // picks one, and nothing is sent by guesswork.
  const choose = state.sessions.length > 1 || (state.sessions.length > 0 && !session)
  picker.hidden = !choose
  project.hidden = choose
  const signature = JSON.stringify([session === null, state.sessions.map((entry) => [entry.id, entry.label, entry.agent, entry.origins])])
  if (signature !== renderedSessions) {
    renderedSessions = signature
    const option = (value: string, text: string, title = '') => {
      const node = el('option', { textContent: text, title })
      node.value = value
      return node
    }
    sessionSelect.replaceChildren(...(session ? [] : [option('', 'Choose a session')]), ...state.sessions.map((entry) => option(entry.id, `${entry.label} · ${entry.agent}`, describeSession(entry))))
  }
  // A render that read state before the user's pick landed must not flip the select back under them.
  if (root.activeElement !== sessionSelect) sessionSelect.value = session?.id ?? ''
  pickerText.textContent = session ? `${session.label} · ${session.agent}` : 'Choose a session'
}

function renderIntro(state: PageState, session: SessionInfo | null): void {
  const needsStart = state.connection === 'offline' || !session
  intro.hidden = state.batches.length > 0 && !needsStart
  commandButton.hidden = !needsStart
  if (needsStart) {
    introTitle.textContent = state.connection === 'offline' ? 'Not connected to a coding agent' : 'No agent session'
    introText.textContent = 'Connect a session from your project. In Claude Code, run:'
  } else {
    introTitle.textContent = 'Comment on your app'
    introText.textContent = `Click Comment or press ${PICK_SHORTCUT}, then click anything on the page. ${session.agent} answers here.`
  }
}

commandButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(START_COMMAND)
  copied.hidden = false
  setTimeout(() => (copied.hidden = true), 1600)
})

// --- composer -----------------------------------------------------------------------

let renderedDraft = ''

/** The agent that asked a question: the one that owns its batch. Batch ids repeat per project, so match the project too. */
function askedBy(state: PageState, session: SessionInfo | null, batchId: string): string {
  return state.batches.find((batch) => batch.id === batchId && batch.projectRoot === session?.projectRoot)?.agent ?? session?.agent ?? FALLBACK_AGENT
}

function renderComposer(state: PageState, session: SessionInfo | null, canSend: boolean): void {
  const ready = state.draft.filter((comment) => comment.text.trim() !== '').length
  const typed = message.value.trim() !== ''
  sendButton.disabled = !canSend || state.sending || (ready === 0 && !typed)
  sendButton.title = canSend ? '' : 'Connect an agent session to send'
  sendButton.setAttribute('aria-label', `Send to ${session?.agent ?? FALLBACK_AGENT}`)
  count.textContent = ready ? plural(ready, 'comment', 'comments') : ''
  errorLine.hidden = !state.lastError
  errorText.textContent = state.lastError ?? ''

  const signature = JSON.stringify(state.draft.map((comment) => [comment.id, comment.text, comment.page.url]))
  if (signature === renderedDraft) return
  renderedDraft = signature
  const focused = root.activeElement instanceof HTMLTextAreaElement ? root.activeElement.dataset.id : undefined

  draftList.replaceChildren(
    ...state.draft.map((comment, index) => {
      const field = el('textarea', { attrs: { rows: '1', placeholder: comment.inReplyTo ? 'Your answer' : 'What should change?', 'aria-label': `Comment ${index + 1}`, 'data-id': comment.id } })
      field.value = comment.text
      field.addEventListener('change', () => void sendOp({ type: 'update-comment', id: comment.id, text: field.value }))
      const remove = el('button', { className: 'icon-button', title: 'Remove comment', attrs: { type: 'button', 'aria-label': `Remove comment ${index + 1}` } }, [iconNode('close', 14)])
      remove.addEventListener('click', () => void sendOp({ type: 'remove-comment', id: comment.id }))
      const context = comment.inReplyTo ? [el('p', { className: 'draft-context' }, [el('b', { textContent: `${askedBy(state, session, comment.inReplyTo.batchId)} asked: ` }), comment.inReplyTo.question])] : []
      return el('li', { className: 'draft', attrs: { 'data-testid': 'draft-item' } }, [
        el('div', { className: 'draft-head' }, [el('span', { className: 'num', textContent: String(index + 1) }), el('span', { className: 'draft-where', textContent: where(comment), title: comment.element?.selector ?? comment.page.url }), remove]),
        ...context,
        field,
      ])
    }),
  )
  if (focused) draftList.querySelector<HTMLTextAreaElement>(`textarea[data-id="${CSS.escape(focused)}"]`)?.focus()
}

async function send(): Promise<void> {
  const state = readState()
  const session = defaultSession(state)
  const text = message.value.trim()
  const ready = state.draft.some((comment) => comment.text.trim() !== '')
  if (!session || state.connection !== 'connected' || state.sending || (!ready && text === '')) return
  if (text !== '') {
    await sendOp({ type: 'add-comment', comment: newComment({ text, page: capturePage(), element: null }) })
    message.value = ''
  }
  await sendOp({ type: 'send', sessionId: session.id })
  scrollToEnd = true
}

compose.addEventListener('submit', (event) => {
  event.preventDefault()
  void send()
})
submitOnEnter(message, () => void send())
message.addEventListener('input', scheduleRender)

// --- thread ---------------------------------------------------------------------------

let renderedTurns = ''
let scrollToEnd = true
/** True while the reader is at the end of the thread; then growth anywhere (new replies, a taller composer) keeps the end in view. */
let atEnd = true

function renderTurns(state: PageState): void {
  const answered = answerPlaces(state)
  const signature = JSON.stringify([state.batches, [...answered]])
  if (signature === renderedTurns) return
  renderedTurns = signature
  const focused = root.activeElement instanceof HTMLTextAreaElement ? root.activeElement.dataset.answer : undefined
  turnList.replaceChildren(...turns(state.batches, answered))
  if (focused) turnList.querySelector<HTMLTextAreaElement>(`textarea[data-answer="${CSS.escape(focused)}"]`)?.focus()
  if (scrollToEnd) atEnd = true
  scrollToEnd = false
  keepEnd()
}

thread.addEventListener('scroll', () => {
  atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40
})
function keepEnd(): void {
  if (atEnd) thread.scrollTop = thread.scrollHeight
}
new ResizeObserver(keepEnd).observe($('.bottom'))
new ResizeObserver(keepEnd).observe(turnList)

// --- render ----------------------------------------------------------------------------

function render(): void {
  const state = readState()
  const session = defaultSession(state)
  const ready = state.draft.filter((comment) => comment.text.trim() !== '').length
  launcherCount.textContent = ready ? String(ready) : ''
  pickButton.setAttribute('aria-pressed', String(isPicking()))
  if (dock.hidden) return
  renderHeader(state, session)

  const connected = state.connection === 'connected' && session !== null
  const unmatched = state.connection === 'connected' && state.sessions.length > 0 && session === null
  notice.hidden = !unmatched && (!connected || session.listening)
  notice.textContent = unmatched
    ? 'No agent session is working on this project. Choose one above to send to it.'
    : `${session?.agent ?? FALLBACK_AGENT} isn’t listening right now. What you send waits until it’s back.`

  renderComposer(state, session, connected)
  renderIntro(state, session)
  renderTurns(state)
}

sessionSelect.addEventListener('change', () => {
  if (sessionSelect.value) void sendOp({ type: 'pick-session', sessionId: sessionSelect.value })
})
pickButton.addEventListener('click', togglePicker)

onStateChange(scheduleRender)
onModeChange(scheduleRender)
setOpen(readOpen())
scheduleRender()
