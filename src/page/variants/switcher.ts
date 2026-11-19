// The switcher on each `<Variants>` group: step through the versions, adjust the shown version's tweaks
// live, and pick one. A pick goes to the agent as a comment with the version and every tweak's final value;
// the agent then writes that version into the code and removes the wrapper.
import type { ChosenTweak, DraftComment, TweakSpec, TweakValue, VariantContext } from '../../shared/protocol.ts'
import { bridge, notify, shownIndex, subscribe, tweakKey, valuesFor } from '../../shared/variants-bridge.ts'
import { captureElement, capturePage } from '../capture.ts'
import { icon } from '../icons.ts'
import type { PageState } from '../store.ts'
import { sendOp } from '../store.ts'

const SAVE_DELAY_MS = 250

type Deps = {
  root: ShadowRoot
  state: () => PageState | null
  agent: () => string
  addComment: (comment: DraftComment, send: boolean) => Promise<void>
  usableWidth: () => number
}

let deps: Deps
let layer: HTMLDivElement
/** Tweaks the user moved and the plugin has not echoed back yet; incoming state must not undo them mid-drag. */
const unsaved = new Map<string, TweakValue>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** Groups whose tweaks card is open. */
const open = new Set<string>()
/** The alternative last looked at per group, so leaving "Before" returns to it. */
const lastAlternative = new Map<string, number>()
/**
 * Where each group's switcher and tweaks card were last put, in page coordinates. While the pointer or focus is
 * in a switcher it stays there, so Before and the alternative can be flipped with clicks on one spot even though
 * each version has a different shape.
 */
const placed = new Map<string, { bar: Spot; card?: Spot }>()

type Spot = { left: number; top: number }
type Area = Spot & { width: number; height: number }

export function mountVariants(next: Deps): void {
  deps = next
  layer = document.createElement('div')
  layer.className = 'variant-layer'
  deps.root.append(layer)
  layer.addEventListener('click', onClick)
  layer.addEventListener('input', onInput)
  for (const type of ['keydown', 'keyup', 'keypress']) layer.addEventListener(type, (event) => event.stopPropagation())
}

/** Copies the plugin's saved choices and values into the bridge, except values the user is still moving. */
export function syncFromState(state: PageState): void {
  const shared = bridge()
  let changed = false
  for (const [group, index] of Object.entries(state.variantChoices)) {
    if (shared.choices[group] !== index) {
      shared.choices[group] = index
      changed = true
    }
  }
  for (const [key, values] of Object.entries(state.tweakValues)) {
    const current = (shared.values[key] ??= {})
    for (const [id, value] of Object.entries(values)) {
      const pending = unsaved.get(`${key}/${id}`)
      if (pending !== undefined && pending !== value) continue
      unsaved.delete(`${key}/${id}`)
      if (current[id] !== value) {
        current[id] = value
        changed = true
      }
    }
  }
  if (changed) notify()
}

export function onGroupsChange(listener: () => void): void {
  subscribe(listener)
}

/** The version a comment was made on, when it was made inside a group. */
export function variantContextOf(element: Element): VariantContext | undefined {
  const wrapper = element.closest('dib-variants')
  const group = wrapper?.getAttribute('data-group')
  const meta = group ? bridge().groups.get(group) : undefined
  if (!wrapper || !group || !meta) return undefined
  const index = shownIndex(group, meta.labels.length)
  return { group, index, label: meta.labels[index] ?? '', tweaks: chosenTweaks(group, index, meta.tweaks[index]) }
}

function chosenTweaks(group: string, index: number, specs: Record<string, TweakSpec> | undefined): ChosenTweak[] {
  const values = valuesFor(group, index, specs)
  return Object.entries(specs ?? {}).map(([id, spec]) => ({ id, label: spec.label, value: values[id] ?? spec.default }))
}

const describe = (tweak: ChosenTweak, spec: TweakSpec | undefined): string => {
  if (typeof tweak.value === 'boolean') return `${tweak.label} ${tweak.value ? 'on' : 'off'}`
  const unit = spec?.kind === 'range' ? (spec.unit ?? '') : ''
  return `${tweak.label} ${tweak.value}${unit}`
}

/** The page box of a group: its rendered children, since the wrapper itself has `display: contents`. */
function boxOf(wrapper: Element): DOMRect | null {
  const boxes = [...wrapper.children].map((child) => child.getBoundingClientRect()).filter((box) => box.width > 0 || box.height > 0)
  if (boxes.length === 0) return null
  const left = Math.min(...boxes.map((box) => box.left))
  const top = Math.min(...boxes.map((box) => box.top))
  const right = Math.max(...boxes.map((box) => box.right))
  const bottom = Math.max(...boxes.map((box) => box.bottom))
  return new DOMRect(left, top, right - left, bottom - top)
}

/** A pick the agent has not applied yet: the switcher stays frozen on it. */
function pendingPick(group: string): { label: string } | null {
  const state = deps.state()
  if (!state) return null
  const picks = [
    ...state.draft.filter((comment) => comment.intent?.kind === 'choose-variant'),
    ...state.batches.flatMap((batch) => batch.comments).filter((comment) => comment.intent?.kind === 'choose-variant' && comment.status === 'pending'),
  ]
  const pick = picks.find((comment) => comment.intent?.kind === 'choose-variant' && comment.intent.group === group)
  return pick?.intent?.kind === 'choose-variant' ? { label: pick.intent.label } : null
}

export function renderVariants(): void {
  if (!layer) return
  const groups = bridge().groups
  for (const node of [...layer.children] as HTMLElement[]) if (!groups.has(node.dataset.group ?? '')) node.remove()

  for (const [group, meta] of groups) {
    const wrapper = document.querySelector(`dib-variants[data-group="${CSS.escape(group)}"]`)
    const box = wrapper ? boxOf(wrapper) : null
    let node = layer.querySelector<HTMLElement>(`:scope > [data-group="${CSS.escape(group)}"]`)
    if (!wrapper || !box) {
      node?.remove()
      continue
    }
    if (!node) {
      node = document.createElement('div')
      node.className = 'variant'
      node.dataset.group = group
      // Once the pointer and focus have left, the switcher may move to fit the version now shown.
      const settle = () => requestAnimationFrame(renderVariants)
      node.addEventListener('pointerleave', settle)
      node.addEventListener('focusout', settle)
      layer.append(node)
    }
    const count = meta.labels.length
    const index = shownIndex(group, count)
    const specs = meta.tweaks[index] ?? {}
    const pick = pendingPick(group)
    const values = valuesFor(group, index, specs)
    const signature = JSON.stringify([count, index, meta.labels, specs, open.has(group), pick, deps.agent()])
    node.classList.toggle('open', open.has(group))
    if (node.dataset.signature !== signature) {
      node.dataset.signature = signature
      const hasTweaks = Object.keys(specs).length > 0
      const reserveTweaks = meta.tweaks.some((versionSpecs) => Object.keys(versionSpecs).length > 0)
      // The bar is rebuilt on every switch; a keyboard user keeps focus on the same control.
      const active = deps.root.activeElement
      const focused = active instanceof HTMLElement && node.contains(active) ? active.dataset.action : undefined
      node.replaceChildren(
        bar(group, meta.labels, index, hasTweaks, reserveTweaks, pick),
        ...(open.has(group) && hasTweaks && !pick ? [tweaksCard(group, index, specs, values)] : []),
      )
      if (focused) node.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus()
    } else {
      syncControls(node, values)
    }
    const card = node.querySelector<HTMLElement>('.tweaks')
    const barWidth = fullWidth(node)
    // Held while in use: the pointer or keyboard focus inside, or the tweaks card open (tweaking reshapes the group
    // under it). A clicked button keeps focus too, but that must not pin the bar over the version you look at next.
    const inUse = node.matches(':hover') || node.querySelector(':focus-visible') !== null || card !== null
    const held = inUse ? placed.get(group) : undefined
    const barSpot = held ? onScreen(fromPage(held.bar), barWidth) : placeBar(box, barWidth, wrapper)
    const cardSpot = card ? (held?.card ? fromPage(held.card) : placeCard(barSpot, barWidth, box, card, wrapper)) : undefined
    placed.set(group, { bar: toPage(barSpot), card: cardSpot && toPage(cardSpot) })
    node.style.transform = `translate(${barSpot.left}px, ${barSpot.top}px)`
    if (card && cardSpot) {
      card.style.left = `${cardSpot.left - barSpot.left}px`
      card.style.top = `${cardSpot.top - barSpot.top}px`
    }
  }
}

const BAR_HEIGHT = 36
const GAP = 8
const CONTENT_TAGS = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'input', 'button', 'select', 'textarea'])

/**
 * The bar's width with Tweaks and the pick button showing. It is placed at that width, so growing on hover
 * neither moves it nor pushes it under the dock or onto content.
 */
function fullWidth(node: HTMLElement): number {
  node.classList.add('measuring')
  const width = node.querySelector<HTMLElement>('.variant-bar')?.offsetWidth ?? 0
  node.classList.remove('measuring')
  return width
}

/** A held spot, pulled back on screen if the viewport or the dock changed under it. */
function onScreen(spot: Spot, width: number): Spot {
  return { left: Math.min(Math.max(GAP, spot.left), deps.usableWidth() - width - GAP), top: spot.top }
}

const toPage = (spot: Spot): Spot => ({ left: spot.left + window.scrollX, top: spot.top + window.scrollY })
const fromPage = (spot: Spot): Spot => ({ left: spot.left - window.scrollX, top: spot.top - window.scrollY })

function fits(area: Area): boolean {
  return area.left >= GAP && area.top >= GAP && area.left + area.width <= deps.usableWidth() - GAP && area.top + area.height <= window.innerHeight - GAP
}

const overlap = (a: Area, b: Area) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height

/** The first free spot of: above the group's top-left, inside its top-right corner, below it. Else the corner. */
function placeBar(box: DOMRect, width: number, wrapper: Element): Spot {
  const clamp = (left: number) => Math.min(Math.max(GAP, left), deps.usableWidth() - width - GAP)
  const corner = { left: clamp(box.right - width - GAP), top: box.top + GAP }
  const spots = [{ left: clamp(box.left), top: box.top - BAR_HEIGHT - GAP }, corner, { left: clamp(box.left), top: box.bottom + GAP }]
  const free = spots.find((spot) => fits({ ...spot, width, height: BAR_HEIGHT }) && coverage({ ...spot, width, height: BAR_HEIGHT }, wrapper) === 0)
  return free ?? corner
}

/**
 * The tweaks card must not hide what it tweaks. It takes the first spot that covers no content: beside the group,
 * under or over the switcher, inside the group's top-right or bottom-right corner, below the group. When every spot
 * covers something, it takes the one that hides least of the group itself.
 */
function placeCard(bar: Spot, barWidth: number, box: DOMRect, card: HTMLElement, wrapper: Element): Spot {
  const width = card.offsetWidth
  const height = card.offsetHeight
  const barArea = { ...bar, width: barWidth, height: BAR_HEIGHT }
  const right = Math.min(box.right, deps.usableWidth()) - width - GAP
  const level = Math.min(Math.max(GAP, box.top), window.innerHeight - height - GAP)
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
  let best = { spot: { left: under.left, top: Math.min(under.top, window.innerHeight - height - GAP) }, score: Infinity }
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
 * the group are not content. A group that wraps only a button usually has a heading right above it.
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

function button(className: string, label: string, content: string, action: string): HTMLButtonElement {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.dataset.action = action
  element.setAttribute('aria-label', label)
  element.innerHTML = content
  return element
}

function text(tag: string, className: string, value: string): HTMLElement {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = value
  return element
}

/**
 * Text that keeps the width of the widest of `all`: every option sits in the same grid cell and only `shown` is
 * visible, so switching versions never shifts the controls after it.
 */
function steadyText(target: HTMLElement, shown: string, all: string[]): void {
  target.classList.add('steady')
  const options = [shown, ...new Set(all.filter((option) => option !== shown))]
  target.replaceChildren(
    ...options.map((option, position) => {
      const span = text('span', position === 0 ? 'steady-shown' : 'steady-spare', option)
      if (position > 0) span.setAttribute('aria-hidden', 'true')
      return span
    }),
  )
}

function bar(group: string, labels: string[], index: number, hasTweaks: boolean, reserveTweaks: boolean, pick: { label: string } | null): HTMLElement {
  const element = document.createElement('div')
  element.className = 'variant-bar'
  element.setAttribute('role', 'toolbar')
  element.setAttribute('aria-label', `Versions of ${group}`)
  const name = text('span', 'variant-group', group)
  name.insertAdjacentHTML('afterbegin', icon('layers', 14))
  if (pick) {
    element.append(name, text('span', 'variant-picked', `Picked “${pick.label}” · waiting for ${deps.agent()}`))
    return element
  }
  // Version 0 is the original, "Before". One alternative: a Before/After toggle. More: Before, then pages.
  const alternatives = labels.length - 1
  const before = button('segment', 'Before', 'Before', 'before')
  before.textContent = 'Before'
  before.setAttribute('aria-pressed', String(index === 0))
  element.append(name)
  if (alternatives === 1) {
    const after = button('segment', 'After', 'After', 'after')
    after.textContent = 'After'
    after.title = labels[1] ?? ''
    after.setAttribute('aria-pressed', String(index === 1))
    element.append(segmented(before, after))
  } else if (alternatives > 1) {
    // Before against the alternative you'd see, then arrows to page through the alternatives.
    const current = index === 0 ? (lastAlternative.get(group) ?? 1) : index
    const label = labels[current] ?? ''
    const alternative = button('segment variant-label', label, '', 'after')
    steadyText(alternative, label, labels.slice(1))
    alternative.title = label
    alternative.setAttribute('aria-pressed', String(index > 0))
    const position = text('span', 'variant-count', `${current} / ${alternatives}`)
    position.dataset.testid = 'variant-count'
    element.append(
      segmented(before, alternative),
      button('variant-step', 'Previous alternative', icon('chevronLeft', 16), 'prev'),
      position,
      button('variant-step', 'Next alternative', icon('chevronRight', 16), 'next'),
    )
    if (index === 0) element.classList.add('on-before')
  }
  if (hasTweaks && index > 0) {
    const tweaks = button('variant-tweaks', 'Tweaks', `${icon('sliders', 15)}<span>Tweaks</span>`, 'tweaks')
    tweaks.setAttribute('aria-pressed', String(open.has(group)))
    element.append(tweaks)
  } else if (reserveTweaks) {
    // Another version has tweaks: keep its slot, empty, so the pick button never moves.
    const slot = document.createElement('span')
    slot.className = 'variant-tweaks reserved'
    slot.setAttribute('aria-hidden', 'true')
    slot.innerHTML = `${icon('sliders', 15)}<span>Tweaks</span>`
    element.append(slot)
  }
  const after = alternatives === 1 ? 'Keep after' : 'Use this'
  const use = button('variant-use', index === 0 ? 'Keep before' : `Use ${labels[index] ?? 'this version'}`, '', 'use')
  steadyText(use, index === 0 ? 'Keep before' : after, ['Keep before', after])
  element.append(use)
  return element
}

function segmented(...segments: HTMLButtonElement[]): HTMLElement {
  const group = document.createElement('span')
  group.className = 'segments'
  group.append(...segments)
  return group
}

function tweaksCard(group: string, index: number, specs: Record<string, TweakSpec>, values: Record<string, TweakValue>): HTMLElement {
  const card = document.createElement('div')
  card.className = 'tweaks'
  card.dataset.key = tweakKey(group, index)
  for (const [id, spec] of Object.entries(specs)) {
    const row = document.createElement('label')
    row.className = 'tweak'
    row.append(text('span', 'tweak-label', spec.label))
    row.append(control(id, spec, values[id] ?? spec.default))
    card.append(row)
  }
  return card
}

function control(id: string, spec: TweakSpec, value: TweakValue): HTMLElement {
  if (spec.kind === 'toggle') {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'switch'
    input.dataset.tweak = id
    input.checked = value === true
    return input
  }
  if (spec.kind === 'range') {
    const wrap = document.createElement('span')
    wrap.className = 'range'
    const input = document.createElement('input')
    input.type = 'range'
    input.dataset.tweak = id
    input.min = String(spec.min)
    input.max = String(spec.max)
    input.step = String(spec.step)
    input.value = String(value)
    const output = text('output', 'range-value', `${value}${spec.unit ?? ''}`)
    output.dataset.unit = spec.unit ?? ''
    wrap.append(input, output)
    return wrap
  }
  const choices = document.createElement('span')
  choices.className = 'choices'
  choices.setAttribute('role', 'radiogroup')
  for (const option of spec.options) {
    const choice = button('choice', option, '', 'choice')
    choice.textContent = option
    choice.dataset.tweak = id
    choice.dataset.value = option
    choice.setAttribute('aria-pressed', String(option === value))
    choices.append(choice)
  }
  return choices
}

/** Keeps controls in step with values set elsewhere (another tab), without rebuilding a slider mid-drag. */
function syncControls(node: HTMLElement, values: Record<string, TweakValue>): void {
  for (const input of node.querySelectorAll<HTMLInputElement>('input[data-tweak]')) {
    const value = values[input.dataset.tweak ?? '']
    if (value === undefined || deps.root.activeElement === input) continue
    if (input.type === 'checkbox') input.checked = value === true
    else input.value = String(value)
  }
  for (const choice of node.querySelectorAll<HTMLElement>('.choice')) {
    choice.setAttribute('aria-pressed', String(values[choice.dataset.tweak ?? ''] === choice.dataset.value))
  }
}

function groupOf(target: Element): string | null {
  return target.closest<HTMLElement>('.variant')?.dataset.group ?? null
}

function show(group: string, index: number): void {
  bridge().choices[group] = index
  notify()
  void sendOp({ type: 'show-variant', group, index })
}

function setTweak(group: string, index: number, id: string, value: TweakValue): void {
  const key = tweakKey(group, index)
  const shared = bridge()
  shared.values[key] = { ...shared.values[key], [id]: value }
  notify()
  // Live on the page at once; saved to the plugin once the drag settles.
  unsaved.set(`${key}/${id}`, value)
  clearTimeout(timers.get(`${key}/${id}`))
  timers.set(
    `${key}/${id}`,
    setTimeout(() => void sendOp({ type: 'set-tweak', group, index, id, value }).catch(() => {}), SAVE_DELAY_MS),
  )
}

async function use(group: string): Promise<void> {
  const meta = bridge().groups.get(group)
  if (!meta) return
  const index = shownIndex(group, meta.labels.length)
  const label = meta.labels[index] ?? ''
  const specs = meta.tweaks[index]
  const tweaks = chosenTweaks(group, index, specs)
  const wrapper = document.querySelector(`dib-variants[data-group="${CSS.escape(group)}"]`)
  const first = wrapper?.firstElementChild ?? null
  const details = tweaks.map((tweak) => describe(tweak, specs?.[tweak.id])).join(', ')
  const comment: DraftComment = {
    id: crypto.randomUUID(),
    text: `Use “${label}” for ${group}${details ? ` (${details})` : ''}`,
    page: capturePage(),
    element: first ? captureElement(first) : null,
    inReplyTo: null,
    intent: { kind: 'choose-variant', group, index, label, tweaks },
    createdAt: new Date().toISOString(),
  }
  open.delete(group)
  // A pick is a decision: it goes to the agent right away when a session is there, else waits in the stack.
  await deps.addComment(comment, true)
}

function onClick(event: Event): void {
  const target = (event.target as Element).closest<HTMLElement>('[data-action]')
  const group = target ? groupOf(target) : null
  const meta = group ? bridge().groups.get(group) : undefined
  if (!target || !group || !meta) return
  const count = meta.labels.length
  const index = shownIndex(group, count)
  // Paging moves through the alternatives (1..n) only; Before is its own button.
  const alternatives = count - 1
  const from = index === 0 ? (lastAlternative.get(group) ?? 1) : index
  const page = (to: number) => {
    lastAlternative.set(group, to)
    show(group, to)
  }
  switch (target.dataset.action) {
    case 'before':
      if (index > 0) lastAlternative.set(group, index)
      show(group, 0)
      return
    case 'after':
      page(from)
      return
    case 'prev':
      page(index === 0 ? from : ((from - 2 + alternatives) % alternatives) + 1)
      return
    case 'next':
      page(index === 0 ? from : (from % alternatives) + 1)
      return
    case 'tweaks':
      if (open.has(group)) open.delete(group)
      else open.add(group)
      // The switcher stays where it is; the card finds its own spot.
      const held = placed.get(group)
      if (held) placed.set(group, { bar: held.bar })
      renderVariants()
      return
    case 'use':
      void use(group)
      return
    case 'choice':
      setTweak(group, index, target.dataset.tweak ?? '', target.dataset.value ?? '')
      return
  }
}

function onInput(event: Event): void {
  const input = event.target as HTMLInputElement
  const id = input.dataset.tweak
  const group = groupOf(input)
  const meta = group ? bridge().groups.get(group) : undefined
  if (!id || !group || !meta) return
  const index = shownIndex(group, meta.labels.length)
  if (input.type === 'checkbox') {
    setTweak(group, index, id, input.checked)
    return
  }
  const value = Number(input.value)
  const output = input.parentElement?.querySelector<HTMLOutputElement>('.range-value')
  if (output) output.textContent = `${value}${output.dataset.unit ?? ''}`
  setTweak(group, index, id, value)
}
