// Drawing on the page: boxes, arrows and pen strokes on a layer over the window. The first mark opens a comment
// card beside it; more marks join the same comment until it is sent. A sent comment's marks stay drawn on their page
// until the agent settles it.
import type { DraftComment, Mark, PagePoint } from '../../shared/protocol.ts'
import { samePage } from '../capture.ts'
import { settled, threads } from '../comments.ts'
import { readState } from '../store.ts'
import { findBySelector, query } from '../ui/dom.ts'
import { isUiHost } from '../ui/layout.ts'
import { markersHidden } from '../ui/markers.ts'
import { openComposer } from './composer.ts'
import { centerOf, cornerOf, drawMark, toPage } from './marks.ts'
import { getMode, onModeChange, setMode, type DrawTool } from './mode.ts'
import { root } from './root.ts'

/** Shorter than this, a drag was a click, not a mark. */
const MIN_SIZE = 6

const ink = query<SVGSVGElement>(root, '.ink')
let tool: DrawTool = 'box'
/** The mark being drawn, from pointer down to pointer up. */
let stroke: { tool: DrawTool; points: PagePoint[] } | null = null

export const currentTool = () => tool

/** Picks a drawing tool. With a drawing's card open, the next marks join that comment, drawn with the new tool. */
export function startDrawing(next: DrawTool): void {
  tool = next
  const mode = getMode()
  if (mode.kind === 'commenting' && mode.marks.length > 0) setMode({ ...mode, after: { kind: 'drawing', tool } })
  else setMode({ kind: 'drawing', tool })
}

/** The layer takes pointers while drawing, and while a drawing's card is open, so more marks can join it. */
function acceptsMarks(): boolean {
  const mode = getMode()
  return mode.kind === 'drawing' || (mode.kind === 'commenting' && mode.marks.length > 0)
}

function markOf(drawn: { tool: DrawTool; points: PagePoint[] }): Mark | null {
  const first = drawn.points[0]
  const last = drawn.points.at(-1)
  if (!first || !last) return null
  const size = Math.max(Math.abs(last.x - first.x), Math.abs(last.y - first.y))
  if (drawn.tool === 'pen') return drawn.points.length > 2 ? { kind: 'pen', points: drawn.points } : null
  if (size < MIN_SIZE) return null
  if (drawn.tool === 'arrow') return { kind: 'arrow', from: first, to: last }
  return {
    kind: 'box',
    x: Math.min(first.x, last.x),
    y: Math.min(first.y, last.y),
    width: Math.abs(last.x - first.x),
    height: Math.abs(last.y - first.y),
  }
}

/** The page element under the marks, which the comment is about. */
function elementUnder(marks: Mark[]): Element {
  const center = centerOf(marks)
  const hit = document.elementsFromPoint(center.x, center.y).find((element) => !isUiHost(element) && element !== document.documentElement)
  return hit ?? document.body
}

function addMark(mark: Mark): void {
  const mode = getMode()
  if (mode.kind === 'commenting') {
    setMode({ ...mode, marks: [...mode.marks, mark] })
    return
  }
  const marks = [mark]
  const element = elementUnder(marks)
  const box = element.getBoundingClientRect()
  const corner = cornerOf(marks)
  openComposer({ element, offset: { x: corner.x - box.left, y: corner.y - box.top }, marks, after: { kind: 'drawing', tool } })
}

/**
 * How far a sent comment's marks have to move to sit on their element again. Marks are kept in page coordinates,
 * so when the page reflows (the dock opening, a resize) the element moves away from them; the comment's click offset
 * is where the marks' top-right corner was on the element.
 */
function driftOf(comment: DraftComment): { x: number; y: number } {
  const { element, marks } = comment
  const offset = element?.clickOffset
  const found = element && offset && marks?.length ? findBySelector(element.selector) : null
  if (!offset || !marks?.length || !found) return { x: 0, y: 0 }
  const box = found.getBoundingClientRect()
  const corner = cornerOf(marks)
  return { x: box.left + offset.x - corner.x, y: box.top + offset.y - corner.y }
}

/** A sent comment's marks, moved with their element. */
function savedMarks(comment: DraftComment): SVGElement {
  const { x, y } = driftOf(comment)
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  group.setAttribute('transform', `translate(${x} ${y})`)
  group.append(...(comment.marks ?? []).map((mark) => drawMark(mark, 'mark saved')))
  return group
}

/**
 * Draws the marks of the comment being written, the one being drawn, and those of sent comments the agent hasn't
 * settled yet (on this page), so a drawing stays where it was made until its comment is done.
 */
export function renderMarks(): void {
  ink.classList.toggle('active', acceptsMarks())
  const mode = getMode()
  const state = readState()
  // A thread is settled by its newest comment, as its pin is: an answered drawing stays until the thread is done.
  const sent = markersHidden()
    ? []
    : threads(state.batches)
        .filter((thread) => {
          const last = thread.at(-1)
          return last !== undefined && !settled(last.comment, state)
        })
        .flat()
        .map((sent) => sent.comment)
        .filter((comment) => comment.marks?.length && samePage(comment.page.url))
  const current = mode.kind === 'commenting' ? mode.marks : []
  const drawing = stroke ? markOf(stroke) : null
  ink.replaceChildren(
    ...sent.map(savedMarks),
    ...current.map((mark) => drawMark(mark, 'mark')),
    ...(drawing ? [drawMark(drawing, 'mark')] : [])
  )
}

ink.addEventListener('pointerdown', (event) => {
  if (!acceptsMarks() || event.button !== 0) return
  event.preventDefault()
  ink.setPointerCapture(event.pointerId)
  const mode = getMode()
  stroke = { tool: mode.kind === 'drawing' ? mode.tool : tool, points: [toPage({ x: event.clientX, y: event.clientY })] }
})
ink.addEventListener('pointermove', (event) => {
  if (!stroke) return
  const point = toPage({ x: event.clientX, y: event.clientY })
  // A box and an arrow need only their two ends; a pen stroke keeps its path.
  stroke.points = stroke.tool === 'pen' ? [...stroke.points, point] : [stroke.points[0] ?? point, point]
  renderMarks()
})
ink.addEventListener('pointerup', () => {
  const finished = stroke ? markOf(stroke) : null
  stroke = null
  if (finished) addMark(finished)
  renderMarks()
})
ink.addEventListener('pointercancel', () => {
  stroke = null
  renderMarks()
})

onModeChange(renderMarks)
