// What the overlay is doing: nothing, picking an element, drawing on the page, or writing a comment. Every part
// of the overlay, and the dock's Comment button, follows this one state.
import type { Mark } from '../../shared/protocol.ts'
import type { Point } from '../ui/geometry.ts'

export type DrawTool = 'box' | 'arrow' | 'pen'

/** Where Esc or adding a comment leads from the comment card. */
type After = { kind: 'idle' } | { kind: 'picking' } | { kind: 'drawing'; tool: DrawTool }

export type Mode =
  | { kind: 'idle' }
  | { kind: 'picking' }
  | { kind: 'drawing'; tool: DrawTool }
  /** `marks`: what the user drew for this comment, empty for a comment on a clicked element. */
  | { kind: 'commenting'; element: Element; offset: Point; marks: Mark[]; after: After }

let mode: Mode = { kind: 'idle' }
const listeners = new Set<(mode: Mode) => void>()

export const getMode = (): Mode => mode
export const isPicking = () => mode.kind !== 'idle'

export function setMode(next: Mode): void {
  mode = next
  for (const listener of listeners) listener(mode)
}

export function onModeChange(listener: (mode: Mode) => void): void {
  listeners.add(listener)
}

export function togglePicker(): void {
  setMode(mode.kind === 'idle' ? { kind: 'picking' } : { kind: 'idle' })
}
