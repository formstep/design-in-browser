// "Dismiss" on the agent's question or note: closes it without an answer. Its pin leaves the page and its reply
// stays in the dock, marked as dismissed. The agent isn't told.
import { sendOp } from './store.ts'
import { button } from './ui/dom.ts'

/** The button, named for screen readers by `name` (which question or note it closes). */
export function dismissButton(commentId: string, name: string): HTMLButtonElement {
  const dismiss = button({ className: 'dismiss', textContent: 'Dismiss', attrs: { 'aria-label': name, 'data-testid': 'dismiss' } })
  dismiss.addEventListener('click', () => void sendOp({ type: 'dismiss', commentId }))
  return dismiss
}
