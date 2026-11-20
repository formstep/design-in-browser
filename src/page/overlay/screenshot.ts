// A screenshot of part of the window, through the browser's own tab capture. A page cannot capture itself
// without asking, so the browser shows its share prompt each time, with this tab preselected where it can.
export type Area = { left: number; top: number; width: number; height: number }

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

/** Captures `area` (window coordinates) as a JPEG data URL, with `hide` hidden for the moment of capture. */
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
