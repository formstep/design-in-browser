// Starting over: clears this app's thread and its pins, after a confirmation over the thread. What the agent is still working on stays until it answers, and the agent keeps everything it was sent.
// The button and the dialog are in the dock's markup; this module gives them their behavior.
import { isPicking, setMode } from '../overlay/mode.ts'
import { agentName, pluginOutdated, readState, sendOp, type PageState } from '../store.ts'
import { query } from '../ui/dom.ts'
import { plural } from '../ui/format.ts'

/** Wires the header's start-over button and its dialog; returns what keeps the button current. `fallback` takes
 * focus when the dialog closes and the button has gone (nothing left to clear). */
export function startOverControls(root: ShadowRoot, fallback: HTMLElement): (state: PageState) => void {
  const trigger = query<HTMLButtonElement>(root, '.start-over')
  const scrim = query<HTMLElement>(root, '.confirm-scrim')
  const text = query<HTMLElement>(root, '.confirm-text')
  const failure = query<HTMLElement>(root, '.confirm-error')
  const cancel = query<HTMLButtonElement>(root, '.confirm-cancel')
  const clear = query<HTMLButtonElement>(root, '.confirm-clear')

  function open(): void {
    const state = readState()
    // Picking would take Esc from the dialog, and pins would cover the page behind it.
    if (isPicking()) setMode({ kind: 'idle' })
    const agent = agentName(state)
    const working = state.batches.filter((batch) => batch.status !== 'done').flatMap((batch) => batch.comments).length
    const still = working === 0 ? '' : ` The ${plural(working, 'comment', 'comments')} ${agent} is still working on stay until it answers.`
    text.textContent = `This clears the chat and the pins on this app’s pages. ${agent} keeps what it was sent.${still}`
    failure.hidden = true
    clear.disabled = false
    scrim.hidden = false
    cancel.focus()
  }

  function close(): void {
    scrim.hidden = true
    ;(trigger.hidden ? fallback : trigger).focus()
  }

  async function confirm(): Promise<void> {
    clear.disabled = true
    try {
      await sendOp({ type: 'start-over' })
      close()
    } catch (error) {
      failure.textContent = `Couldn’t clear the chat: ${error instanceof Error ? error.message : String(error)}`
      failure.hidden = false
      clear.disabled = false
    }
  }

  trigger.addEventListener('click', open)
  cancel.addEventListener('click', close)
  clear.addEventListener('click', () => void confirm())
  scrim.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      close()
      return
    }
    // Tab stays between the two buttons while the dialog is open.
    if (event.key !== 'Tab') return
    event.preventDefault()
    ;(root.activeElement === cancel ? clear : cancel).focus()
  })

  return (state) => {
    trigger.hidden = pluginOutdated() || state.batches.length === 0
    trigger.disabled = state.sending
  }
}
