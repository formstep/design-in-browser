// A screenshot of the marked part of the window. First the page draws that area from its own DOM, which needs
// no permission: close to what the user sees, though cross-origin images and some effects can come out blank.
// When that fails, the browser's tab capture takes a real screenshot, after its share prompt.
import { toCanvas } from 'html-to-image'
import type { Mark } from '../../shared/protocol.ts'
import { isUiHost } from '../ui/layout.ts'
import { toWindow } from './marks.ts'

export type Area = { left: number; top: number; width: number; height: number }

const contains = (box: DOMRect, area: Area) =>
  box.left <= area.left && box.top <= area.top && box.right >= area.left + area.width && box.bottom >= area.top + area.height

/** The smallest element that holds the whole area, so only that much of the page is drawn. */
function holderOf(area: Area): HTMLElement {
  const center = document.elementsFromPoint(area.left + area.width / 2, area.top + area.height / 2).find((element) => !isUiHost(element))
  for (let node = center instanceof HTMLElement ? center : null; node && node !== document.body; node = node.parentElement) {
    if (contains(node.getBoundingClientRect(), area)) return node
  }
  return document.body
}

/** Paints the marks onto a screenshot of `area`, as the overlay shows them: the page drawing doesn't include it. */
function paintMarks(context: CanvasRenderingContext2D, marks: Mark[], area: Area, scale: number): void {
  const at = (point: { x: number; y: number }) => {
    const spot = toWindow(point)
    return { x: (spot.x - area.left) * scale, y: (spot.y - area.top) * scale }
  }
  context.strokeStyle = '#257de0'
  context.fillStyle = 'rgb(37 125 224 / 0.06)'
  context.lineWidth = 2.5 * scale
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (const mark of marks) {
    context.beginPath()
    if (mark.kind === 'box') {
      const corner = at({ x: mark.x, y: mark.y })
      context.rect(corner.x, corner.y, mark.width * scale, mark.height * scale)
      context.fill()
    } else if (mark.kind === 'arrow') {
      const from = at(mark.from)
      const to = at(mark.to)
      const angle = Math.atan2(to.y - from.y, to.x - from.x)
      const head = 12 * scale
      context.moveTo(from.x, from.y)
      context.lineTo(to.x, to.y)
      context.moveTo(to.x - head * Math.cos(angle + 0.5), to.y - head * Math.sin(angle + 0.5))
      context.lineTo(to.x, to.y)
      context.lineTo(to.x - head * Math.cos(angle - 0.5), to.y - head * Math.sin(angle - 0.5))
    } else {
      mark.points.map(at).forEach((point, index) => (index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)))
    }
    context.stroke()
  }
}

/** Draws `area` (window coordinates) from the page's DOM, with the marks on top, as a JPEG data URL. No prompt. */
export async function renderArea(area: Area, marks: Mark[]): Promise<string> {
  const holder = holderOf(area)
  const box = holder.getBoundingClientRect()
  const scale = devicePixelRatio
  const drawn = await toCanvas(holder, { pixelRatio: scale, filter: (node) => !isUiHost(node) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(area.width * scale)
  canvas.height = Math.round(area.height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser cannot draw the screenshot.')
  // The page's background shows where the holder is transparent, as on screen.
  context.fillStyle = getComputedStyle(document.body).backgroundColor || '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(
    drawn,
    (area.left - box.left) * scale,
    (area.top - box.top) * scale,
    canvas.width,
    canvas.height,
    0,
    0,
    canvas.width,
    canvas.height
  )
  paintMarks(context, marks, area, scale)
  return canvas.toDataURL('image/jpeg', 0.85)
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

/** Captures `area` (window coordinates) through the browser's tab capture, with `hide` hidden for the moment. */
export async function captureArea(area: Area, hide: HTMLElement[]): Promise<string> {
  const options: DisplayMediaStreamOptions & { preferCurrentTab: boolean } = {
    video: { displaySurface: 'browser' },
    audio: false,
    preferCurrentTab: true,
  }
  const stream = await navigator.mediaDevices.getDisplayMedia(options)
  const shown = hide.map((node) => node.style.visibility)
  try {
    for (const node of hide) node.style.visibility = 'hidden'
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    await video.play()
    // Let the hidden UI leave the captured frames.
    await nextFrame()
    await nextFrame()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const scale = video.videoWidth / innerWidth
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(area.width * scale)
    canvas.height = Math.round(area.height * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser cannot draw the screenshot.')
    context.drawImage(
      video,
      area.left * scale,
      area.top * scale,
      area.width * scale,
      area.height * scale,
      0,
      0,
      canvas.width,
      canvas.height
    )
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    for (const track of stream.getTracks()) track.stop()
    hide.forEach((node, index) => (node.style.visibility = shown[index] ?? ''))
  }
}
