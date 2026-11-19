export type Point = { x: number; y: number }

export const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

/** The window point a pin marks: the click offset inside the element, kept inside its box as it resizes. */
export function pointOn(element: Element, offset: Point | undefined): Point | null {
  const box = element.getBoundingClientRect()
  if (box.width === 0 && box.height === 0) return null
  return { x: box.left + clamp(offset?.x ?? 0, 0, box.width), y: box.top + clamp(offset?.y ?? 0, 0, box.height) }
}
