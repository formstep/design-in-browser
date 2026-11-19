// Picking: the hover outline with its tag, and the window-level listeners that keep the page from seeing
// clicks while the user points at things.
import { label } from '../capture.ts'
import type { Point } from '../ui/geometry.ts'
import { cameFromUi, isUiHost } from '../ui/layout.ts'
import { query } from '../ui/dom.ts'
import { getMode, onModeChange } from './mode.ts'
import { root } from './root.ts'

const highlight = query<HTMLDivElement>(root, '.highlight')
const tagLabel = query<HTMLSpanElement>(root, '.tag-label')
const tagSize = query<HTMLSpanElement>(root, '.tag-size')

let hovered: Element | null = null
const pickListeners = new Set<(pick: { element: Element; offset: Point }) => void>()

/** Called when the user clicks an element to comment on, with where in it they clicked. */
export function onPick(listener: (pick: { element: Element; offset: Point }) => void): void {
  pickListeners.add(listener)
}

export function showHighlight(element: Element | null, selected = false): void {
  const box = element?.getBoundingClientRect()
  if (!element || !box) {
    highlight.hidden = true
    return
  }
  highlight.hidden = false
  highlight.classList.toggle('selected', selected)
  highlight.classList.toggle('below', box.top < 34)
  highlight.style.transform = `translate(${box.left}px, ${box.top}px)`
  highlight.style.width = `${box.width}px`
  highlight.style.height = `${box.height}px`
  tagLabel.textContent = label(element)
  tagSize.textContent = `${Math.round(box.width)} × ${Math.round(box.height)}`
}

function elementAt(x: number, y: number): Element | null {
  const element = document.elementFromPoint(x, y)
  return element && !isUiHost(element) && element !== document.documentElement ? element : null
}

/** While picking or commenting, the page must not see clicks: no navigation, no buttons firing. */
function swallow(event: Event): void {
  if (getMode().kind === 'idle' || cameFromUi(event)) return
  event.preventDefault()
  event.stopImmediatePropagation()
}

function onClick(event: MouseEvent): void {
  if (getMode().kind === 'idle' || cameFromUi(event)) return
  swallow(event)
  const element = elementAt(event.clientX, event.clientY)
  if (!element) return
  const box = element.getBoundingClientRect()
  for (const listener of pickListeners) listener({ element, offset: { x: event.clientX - box.left, y: event.clientY - box.top } })
}

for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick'])
  window.addEventListener(type, swallow, true)
window.addEventListener('click', onClick, true)
window.addEventListener(
  'mousemove',
  (event) => {
    if (getMode().kind !== 'picking') return
    hovered = elementAt(event.clientX, event.clientY)
    showHighlight(hovered)
  },
  true
)

onModeChange((mode) => {
  document.documentElement.style.cursor = mode.kind === 'picking' ? 'crosshair' : ''
  if (mode.kind === 'idle') hovered = null
  if (mode.kind === 'idle') showHighlight(null)
  // Back from a comment card: outline what the pointer is over again.
  else if (mode.kind === 'picking') showHighlight(hovered)
  else showHighlight(mode.element, true)
})
