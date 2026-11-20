// Marks the user draws (boxes, arrows, pen strokes): their geometry, and how they look. Marks are kept in page
// coordinates, so they stay on what they mark as the page scrolls; they are drawn in window coordinates.
import type { Mark, PagePoint } from '../../shared/protocol.ts'
import type { Point } from '../ui/geometry.ts'

const SVG = 'http://www.w3.org/2000/svg'

/** The marks' bounding box, in page coordinates. */
export type Bounds = { left: number; top: number; right: number; bottom: number }

function pointsOf(mark: Mark): PagePoint[] {
  switch (mark.kind) {
    case 'box':
      return [
        { x: mark.x, y: mark.y },
        { x: mark.x + mark.width, y: mark.y + mark.height },
      ]
    case 'arrow':
      return [mark.from, mark.to]
    case 'pen':
      return mark.points
  }
}

export function boundsOf(marks: Mark[]): Bounds {
  const points = marks.flatMap(pointsOf)
  return {
    left: Math.min(...points.map((point) => point.x)),
    top: Math.min(...points.map((point) => point.y)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.max(...points.map((point) => point.y)),
  }
}

export const toWindow = (point: PagePoint): Point => ({ x: point.x - scrollX, y: point.y - scrollY })
export const toPage = (point: Point): PagePoint => ({ x: point.x + scrollX, y: point.y + scrollY })

/** Where a drawing's card and pin go: the top-right corner of its marks, in the window. */
export function cornerOf(marks: Mark[]): Point {
  const bounds = boundsOf(marks)
  return toWindow({ x: bounds.right, y: bounds.top })
}

export function centerOf(marks: Mark[]): Point {
  const bounds = boundsOf(marks)
  return toWindow({ x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 })
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value))
  return node
}

/** One mark as SVG in window coordinates. */
export function drawMark(mark: Mark, className: string): SVGElement {
  switch (mark.kind) {
    case 'box': {
      const corner = toWindow({ x: mark.x, y: mark.y })
      return svg('rect', { class: className, x: corner.x, y: corner.y, width: mark.width, height: mark.height, rx: 3 })
    }
    case 'arrow': {
      const from = toWindow(mark.from)
      const to = toWindow(mark.to)
      // The head: two short strokes back from the tip, 28 degrees either side of the shaft.
      const angle = Math.atan2(to.y - from.y, to.x - from.x)
      const head = (turn: number) => `${to.x - 12 * Math.cos(angle + turn)},${to.y - 12 * Math.sin(angle + turn)}`
      const group = svg('g', { class: className })
      group.append(
        svg('line', { x1: from.x, y1: from.y, x2: to.x, y2: to.y }),
        svg('polyline', { points: `${head(0.5)} ${to.x},${to.y} ${head(-0.5)}` })
      )
      return group
    }
    case 'pen':
      return svg('polyline', {
        class: className,
        points: mark.points
          .map(toWindow)
          .map((point) => `${point.x},${point.y}`)
          .join(' '),
      })
  }
}
