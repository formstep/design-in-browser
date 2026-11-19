// What the overlay is doing: nothing, picking an element, or writing a comment on one. Every part of the
// overlay, and the dock's Comment button, follows this one state.
import type { Point } from '../ui/geometry.ts'

export type Mode =
  | { kind: 'idle' }
  | { kind: 'picking' }
  /** `then`: where Esc or adding the comment leads, back to picking or out. */
  | { kind: 'commenting'; element: Element; offset: Point; then: 'picking' | 'idle' }

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
