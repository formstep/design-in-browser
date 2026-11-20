// The overlay: picking elements, drawing marks, the comment card, pins with the agent's replies, the tool pill, and the
// switchers on <Variants> groups. This module wires the parts together: shortcuts, and one render per frame
// that follows the page as it scrolls, resizes and reloads.
import { onStateChange, readState } from '../store.ts'
import { frameScheduler } from '../ui/events.ts'
import { onReservedRightChange } from '../ui/layout.ts'
import { mountVariants, onGroupsChange, renderVariants, syncFromState } from '../variants/switcher.ts'
import { leaveComposer, renderComposer } from './composer.ts'
import { renderMarks } from './drawing.ts'
import { getMode, onModeChange, setMode, togglePicker } from './mode.ts'
import { closeThreads, renderPins } from './pins.ts'
import { root } from './root.ts'
import { closeAskbar, isAskbarOpen, renderTools } from './tools.ts'

const scheduleRender = frameScheduler(() => {
  renderMarks()
  renderPins()
  renderVariants()
  renderTools()
  renderComposer()
})

window.addEventListener(
  'keydown',
  (event) => {
    if (event.altKey && event.shiftKey && event.code === 'KeyC') {
      event.preventDefault()
      event.stopImmediatePropagation()
      togglePicker()
      return
    }
    if (event.key !== 'Escape') return
    const mode = getMode()
    if (mode.kind === 'idle') {
      closeThreads()
      return
    }
    // Esc steps back one level: card, then Ask bar, then out of picking.
    event.preventDefault()
    event.stopImmediatePropagation()
    if (mode.kind === 'commenting') leaveComposer()
    else if (isAskbarOpen()) closeAskbar()
    else setMode({ kind: 'idle' })
  },
  true
)

mountVariants(root)
onGroupsChange(scheduleRender)
onModeChange(scheduleRender)
onReservedRightChange(scheduleRender)
onStateChange(() => {
  syncFromState(readState())
  scheduleRender()
})
window.addEventListener('scroll', scheduleRender, { capture: true, passive: true })
window.addEventListener('resize', scheduleRender)
// Hot reloads and client-side routing move elements without a scroll or resize.
setInterval(scheduleRender, 800)
syncFromState(readState())
scheduleRender()
