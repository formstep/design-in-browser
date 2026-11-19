// What the overlay, the dock and the switcher share about the window: which elements are this package's own,
// and how much of the window's right side the open dock takes.

const uiHosts = new Set<Element>()
const listeners = new Set<() => void>()
let reservedRight = 0

export function registerUiHost(element: Element): void {
  uiHosts.add(element)
}

/** True for this package's own layers: they are never picked, and clicks on them reach them. */
export function isUiHost(node: EventTarget | null): boolean {
  return node instanceof Element && uiHosts.has(node)
}

export function cameFromUi(event: Event): boolean {
  return event.composedPath().some(isUiHost)
}

/** Width the dock takes on the right; cards, pins and switchers keep out of it. */
export function setReservedRight(px: number): void {
  reservedRight = px
  for (const listener of listeners) listener()
}

export function onReservedRightChange(listener: () => void): void {
  listeners.add(listener)
}

export const getReservedRight = () => reservedRight
export const usableWidth = () => innerWidth - reservedRight
