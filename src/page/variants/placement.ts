// Where a switcher and its tweaks card go: the first spot that covers none of the page's text, media or
// controls, so a group that wraps only a button doesn't get its heading hidden by its own switcher.
import { clamp } from '../ui/geometry.ts'
import { usableWidth } from '../ui/layout.ts'

export type Spot = { left: number; top: number }
type Area = Spot & { width: number; height: number }

export const BAR_HEIGHT = 36
const GAP = 8
const CONTENT_TAGS = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'input', 'button', 'select', 'textarea'])

export const toPage = (spot: Spot): Spot => ({ left: spot.left + window.scrollX, top: spot.top + window.scrollY })
export const fromPage = (spot: Spot): Spot => ({ left: spot.left - window.scrollX, top: spot.top - window.scrollY })

/** The window box of a group: its rendered children, since the wrapper itself has `display: contents`. */
export function boxOf(wrapper: Element): DOMRect | null {
  const boxes = [...wrapper.children].map((child) => child.getBoundingClientRect()).filter((box) => box.width > 0 || box.height > 0)
  if (boxes.length === 0) return null
  const left = Math.min(...boxes.map((box) => box.left))
  const top = Math.min(...boxes.map((box) => box.top))
  const right = Math.max(...boxes.map((box) => box.right))
  const bottom = Math.max(...boxes.map((box) => box.bottom))
  return new DOMRect(left, top, right - left, bottom - top)
}

/** A held spot, pulled back on screen if the viewport or the dock changed under it. */
export function onScreen(spot: Spot, width: number): Spot {
  return { left: clamp(spot.left, GAP, usableWidth() - width - GAP), top: spot.top }
}

function fits(area: Area): boolean {
  return area.left >= GAP && area.top >= GAP && area.left + area.width <= usableWidth() - GAP && area.top + area.height <= innerHeight - GAP
}

const overlap = (a: Area, b: Area) =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height

/** The first free spot of: above the group's top-left, inside its top-right corner, below it. Else the corner. */
export function placeBar(box: DOMRect, width: number, wrapper: Element): Spot {
  const left = (preferred: number) => clamp(preferred, GAP, usableWidth() - width - GAP)
  const corner = { left: left(box.right - width - GAP), top: box.top + GAP }
  const spots = [{ left: left(box.left), top: box.top - BAR_HEIGHT - GAP }, corner, { left: left(box.left), top: box.bottom + GAP }]
  const free = spots.find(
    (spot) => fits({ ...spot, width, height: BAR_HEIGHT }) && coverage({ ...spot, width, height: BAR_HEIGHT }, wrapper) === 0
  )
  return free ?? corner
}

/**
 * The tweaks card must not hide what it tweaks. It takes the first spot that covers no content: beside the group,
 * under or over the switcher, inside the group's top-right or bottom-right corner, below the group. When every spot
 * covers something, it takes the one that hides least of the group itself.
 */
export function placeCard(bar: Spot, barWidth: number, box: DOMRect, card: HTMLElement, wrapper: Element): Spot {
  const width = card.offsetWidth
  const height = card.offsetHeight
  const barArea = { ...bar, width: barWidth, height: BAR_HEIGHT }
  const right = Math.min(box.right, usableWidth()) - width - GAP
  const level = clamp(box.top, GAP, innerHeight - height - GAP)
  const under = { left: bar.left, top: bar.top + BAR_HEIGHT + 6 }
  const spots = [
    { left: box.right + 12, top: level },
    { left: box.left - width - 12, top: level },
    under,
    { left: bar.left, top: bar.top - height - 6 },
    { left: right, top: box.top + GAP },
    { left: right, top: box.bottom - height - GAP },
    { left: bar.left, top: box.bottom + GAP },
    { left: right, top: box.bottom + GAP },
  ]
  let best = { spot: { left: under.left, top: Math.min(under.top, innerHeight - height - GAP) }, score: Infinity }
  for (const spot of spots) {
    const area = { ...spot, width, height }
    if (!fits(area) || overlap(area, barArea)) continue
    const score = coverage(area, wrapper)
    if (score === 0) return spot
    if (score < best.score) best = { spot, score }
  }
  return best.spot
}

/**
 * How much of the page's content an area would cover: sample points over text, media or a control. Points on
 * the group's own content weigh three times as much, since that is what the user is looking at. The boxes around
 * the group are not content.
 */
function coverage(area: Area, wrapper: Element): number {
  const rows = Math.max(2, Math.ceil(area.height / 18))
  const columns = Math.max(5, Math.ceil(area.width / 36))
  let score = 0
  for (let row = 0; row < rows; row++) {
    const y = area.top + 6 + ((area.height - 12) * row) / (rows - 1)
    for (let column = 0; column < columns; column++) {
      const x = area.left + 6 + ((area.width - 12) * column) / (columns - 1)
      for (const element of document.elementsFromPoint(x, y)) {
        if (element.closest('dib-overlay, dib-dock')) continue
        if (element.contains(wrapper)) break
        if (CONTENT_TAGS.has(element.localName) || textAt(element, x, y)) {
          score += wrapper.contains(element) ? 3 : 1
          break
        }
      }
    }
  }
  return score
}

/** Whether one of the element's own lines of text is under the point; a block's empty space around its text is not. */
function textAt(element: Element, x: number, y: number): boolean {
  const range = document.createRange()
  for (const child of element.childNodes) {
    if (child.nodeType !== Node.TEXT_NODE || !child.textContent?.trim()) continue
    range.selectNodeContents(child)
    for (const line of range.getClientRects()) {
      if (x >= line.left - 4 && x <= line.right + 4 && y >= line.top - 4 && y <= line.bottom + 4) return true
    }
  }
  return false
}
