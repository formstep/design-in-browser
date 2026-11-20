// The open dock pushes the page aside, so what sat under it can still be commented on. A right margin on the root
// element moves everything laid out in the page's flow. Elements sized to the window (100vw, Tailwind's w-screen)
// ignore that margin, so each one that runs under the dock is held to its parent's width (max-width: 100%) while the
// dock is open, and given its own value back when the dock closes. Elements fixed to the window stay where they are.
import { isUiHost } from '../ui/layout.ts'

/** Elements held to their parent's width, with the inline max-width each had before. */
const held = new Map<HTMLElement, string>()
let watch: ReturnType<typeof setInterval> | null = null

/** How far apart, down the window, the page is sampled for elements running under the dock. */
const SAMPLE_STEP = 80

/**
 * Holds each element as wide as the window that runs under the dock while its parent doesn't: sampled just right of
 * `limit`, down the window. Holding an outer one narrows what is inside it, so its children read as fitting.
 */
function holdWindowWide(limit: number): void {
  const x = Math.min(innerWidth - 1, limit + 20)
  for (let y = 4; y < innerHeight; y += SAMPLE_STEP) {
    for (const element of document.elementsFromPoint(x, y)) {
      if (!(element instanceof HTMLElement) || held.has(element) || isUiHost(element)) continue
      const parent = element.parentElement
      if (!parent || element === document.body) continue
      if (Math.abs(element.getBoundingClientRect().width - innerWidth) > 1) continue
      if (parent.getBoundingClientRect().right > limit + 1) continue
      const { position } = getComputedStyle(element)
      if (position === 'fixed' || position === 'absolute') continue
      held.set(element, element.style.maxWidth)
      element.style.maxWidth = '100%'
    }
  }
}

function release(): void {
  for (const [element, before] of held) if (element.style.maxWidth === '100%') element.style.maxWidth = before
  held.clear()
}

/** Pushes the page `width` pixels from the right edge, or gives the room back with 0. */
export function pushPage(width: number): void {
  document.documentElement.style.marginRight = width > 0 ? `${width}px` : ''
  if (watch !== null) clearInterval(watch)
  watch = null
  if (width === 0) {
    release()
    return
  }
  const limit = innerWidth - width
  holdWindowWide(limit)
  // Client-side routing and lazy content bring new elements while the dock stays open.
  watch = setInterval(() => holdWindowWide(limit), 1000)
}
