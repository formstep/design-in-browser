/** Keys typed into this package's UI belong to it, not to the app's own shortcuts. */
export function keepKeys(element: EventTarget): void {
  for (const type of ['keydown', 'keyup', 'keypress']) element.addEventListener(type, (event) => event.stopPropagation())
}

/** Enter submits, Shift+Enter makes a new line, and Enter while an IME is composing does nothing. */
export function submitOnEnter(field: HTMLElement, submit: () => void): void {
  field.addEventListener('keydown', (event) => {
    if (!(event instanceof KeyboardEvent) || event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    submit()
  })
}

/** Batches render requests into one call per animation frame. */
export function frameScheduler(render: () => void): () => void {
  let frame = 0
  return () => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      render()
    })
  }
}
