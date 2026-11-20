// The overlay's layer: one shadow root over the whole window holding the selection outline, the pins, the
// comment card and the tool pill. Each part's module finds its elements here; the markup stays in one place so
// the stacking order reads top to bottom.
import { fillIcons } from '../icons.ts'
import { getReservedRight, onReservedRightChange, registerUiHost } from '../ui/layout.ts'
import { createShadowHost } from '../ui/shadow-host.ts'
import baseCss from './base.css'
import composerCss from './composer.css'
import drawingCss from './drawing.css'
import pickerCss from './picker.css'
import pinsCss from './pins.css'
import toolsCss from './tools.css'

/** Pin height: the pin's sharp corner sits on the clicked point, its body above it. */
export const PIN = 32
/** Width of the comment card and of a pin's thread card. */
export const CARD_WIDTH = 300

export const { host, root } = createShadowHost('dib-overlay', baseCss + pickerCss + drawingCss + toolsCss + composerCss + pinsCss)
registerUiHost(host)
/** Below this much free width (a phone with the dock open) the overlay steps back: pins would only crowd the edge. */
const MIN_FREE_WIDTH = 160
onReservedRightChange(() => {
  host.style.setProperty('--reserved-right', `${getReservedRight()}px`)
  host.style.visibility = innerWidth - getReservedRight() < MIN_FREE_WIDTH ? 'hidden' : ''
})

root.innerHTML = `
<div class="highlight" hidden>
  <span class="tag"><span class="tag-label"></span><span class="tag-size"></span></span>
</div>
<svg class="ink" aria-hidden="true"></svg>
<div class="pins"></div>
<div class="pin-wrap composing" hidden><span class="pin"><span class="disc"></span></span></div>
<form class="composer" hidden>
  <div class="modes" role="tablist" aria-label="What to ask for">
    <button type="button" class="mode" data-mode="comment" role="tab" aria-selected="true">Comment</button>
    <button type="button" class="mode" data-mode="alternatives" role="tab" aria-selected="false">Alternatives</button>
  </div>
  <p class="target"></p>
  <div class="field"><span class="chip"></span><textarea rows="1"></textarea></div>
  <div class="count-row" hidden>
    <span class="count-label">How many</span>
    <span class="choices" role="radiogroup" aria-label="How many alternatives">
      <button type="button" class="choice" data-count="1">1</button><button type="button" class="choice" data-count="2">2</button><button type="button" class="choice" data-count="3">3</button><button type="button" class="choice" data-count="4">4</button>
    </span>
  </div>
  <label class="shot-check" hidden><input type="checkbox" class="attach-shot" /> <span>Attach a screenshot</span></label>
  <p class="composer-error" role="alert" hidden></p>
  <div class="composer-foot">
    <span class="hint"><kbd>Enter</kbd> to send</span>
  </div>
</form>
<div class="toolbar" hidden>
  <form class="askbar" hidden>
    <input type="text" placeholder="Describe a change to this page" aria-label="Note about this page" />
    <button type="submit" class="send" aria-label="Send note"><span data-icon="arrowUp" data-size="15"></span></button>
  </form>
  <p class="ask-error" role="alert" hidden></p>
  <div class="tools" role="toolbar" aria-label="Design in Browser">
    <button type="button" class="tool pick-tool" title="Comment on an element" aria-label="Comment on an element"><span data-icon="comment" data-size="18"></span></button>
    <button type="button" class="tool draw-tool" data-tool="box" title="Draw a box" aria-label="Draw a box"><span data-icon="square" data-size="17"></span></button>
    <button type="button" class="tool draw-tool" data-tool="arrow" title="Draw an arrow" aria-label="Draw an arrow"><span data-icon="arrowUpRight" data-size="17"></span></button>
    <button type="button" class="tool draw-tool" data-tool="pen" title="Draw freehand" aria-label="Draw freehand"><span data-icon="pen" data-size="17"></span></button>
    <span class="tools-divider"></span>
    <button type="button" class="tool ask" aria-pressed="false"></button>
    <span class="tools-divider"></span>
    <button type="button" class="tool done-tool"><kbd>Esc</kbd>Done</button>
  </div>
</div>`
fillIcons(root)
