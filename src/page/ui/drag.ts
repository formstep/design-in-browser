// Moving this package's floating cards and bars by hand, so they never have to stay over what the user looks at.
// A press only becomes a drag past a few pixels, so clicks on the same surface still reach their buttons.

const THRESHOLD = 4
/** Controls keep their own pointer: a slider, a field or a button is used, never dragged. */
const CONTROLS = 'button, input, textarea, select, label, a, [contenteditable], [data-action]'

type Drag = {
  /** The press may be on a control: for a button that is itself the thing moved, such as the dock's launcher. */
  fromControl?: boolean
  /** Called once the pointer has moved past the threshold. */
  start?: () => void
  /** The pointer's distance from where it was pressed, in window pixels. */
  move: (dx: number, dy: number) => void
  end?: () => void
}

/**
 * Starts a drag from a press on `event.target`, unless it was on a control or the primary button wasn't used.
 * Returns whether the press may become a drag.
 */
export function dragFrom(event: PointerEvent, drag: Drag): boolean {
  if (event.button !== 0 || !(event.target instanceof Element)) return false
  if (!drag.fromControl && event.target.closest(CONTROLS)) return false
  // No text selection and no focus change: a field being typed into keeps its caret through the drag.
  event.preventDefault()
  const origin = { x: event.clientX, y: event.clientY }
  const target = event.target
  let moving = false
  const onMove = (move: PointerEvent) => {
    if (move.pointerId !== event.pointerId) return
    const dx = move.clientX - origin.x
    const dy = move.clientY - origin.y
    if (!moving) {
      if (Math.hypot(dx, dy) < THRESHOLD) return
      moving = true
      // Captured only now: captured on the press, the click that follows a plain press would lose its target.
      target.setPointerCapture?.(event.pointerId)
      drag.start?.()
    }
    move.preventDefault()
    drag.move(dx, dy)
  }
  const onUp = (up: PointerEvent) => {
    if (up.pointerId !== event.pointerId) return
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', onUp, true)
    if (!moving) return
    // The click a drag ends with is not a click on what lies under the pointer. It comes in the same task as the
    // release, if at all, so a later click is never swallowed.
    window.addEventListener('click', swallow, true)
    setTimeout(() => window.removeEventListener('click', swallow, true), 0)
    drag.end?.()
  }
  const swallow = (click: Event) => {
    click.stopPropagation()
    click.preventDefault()
  }
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', onUp, true)
  return true
}
