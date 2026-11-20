// The switcher on each `<Variants>` group: flip between Before and the alternatives, adjust the shown version's
// tweaks live, and pick one. A pick goes to the agent as a comment with the version and every tweak's final
// value; the agent then writes that version into the code and removes the wrapper.
import { versionKey } from '../../shared/page-protocol.ts'
import type { ChosenTweak, ShownVersion, TweakSpec, TweakValue } from '../../shared/protocol.ts'
import { bridge, notify, shownIndex, subscribe, valuesFor } from '../../shared/variants-bridge.ts'
import { captureElement, capturePage } from '../capture.ts'
import { isPick, newComment } from '../comments.ts'
import { addComment, agentName, readState, sendOp, type PageState } from '../store.ts'
import { el, query } from '../ui/dom.ts'
import { keepKeys } from '../ui/events.ts'
import { addStyles } from '../ui/shadow-host.ts'
import { bar } from './bar.ts'
import { boxOf, fromPage, onScreen, placeBar, placeCard, shownElements, toPage, type Spot } from './placement.ts'
import switcherCss from './switcher.css'
import { showRangeValue, syncControls, tweaksCard } from './tweaks-card.ts'

const SAVE_DELAY_MS = 250

let root: ShadowRoot
let layer: HTMLDivElement
/** Tweaks the user moved and the plugin has not echoed back yet; incoming state must not undo them mid-drag. */
const unsaved = new Map<string, TweakValue>()
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Groups whose tweaks card is open. */
const open = new Set<string>()
/** The alternative last looked at per group, so leaving "Before" returns to it. */
const lastAlternative = new Map<string, number>()
/**
 * Where each group's switcher and tweaks card were last put, in page coordinates. While the switcher is in use
 * it stays there, so Before and the alternative can be flipped with clicks on one spot although each version
 * has a different shape.
 */
const placed = new Map<string, { bar: Spot; card?: Spot }>()

/** Puts the switchers' layer into the overlay's shadow root. */
export function mountVariants(overlayRoot: ShadowRoot): void {
  root = overlayRoot
  addStyles(root, switcherCss)
  layer = el('div', { className: 'variant-layer' })
  root.append(layer)
  layer.addEventListener('click', onClick)
  layer.addEventListener('input', onInput)
  keepKeys(layer)
}

/** Copies the plugin's saved choices and values into the bridge, except values the user is still moving. */
export function syncFromState(state: PageState): void {
  const shared = bridge()
  let changed = false
  for (const [group, index] of Object.entries(state.variantChoices)) {
    if (shared.choices[group] === index) continue
    shared.choices[group] = index
    changed = true
  }
  for (const [key, values] of Object.entries(state.tweakValues)) {
    const current = (shared.values[key] ??= {})
    for (const [id, value] of Object.entries(values)) {
      const pending = unsaved.get(`${key}/${id}`)
      if (pending !== undefined && pending !== value) continue
      unsaved.delete(`${key}/${id}`)
      if (current[id] === value) continue
      current[id] = value
      changed = true
    }
  }
  if (changed) notify()
}

export const onGroupsChange = subscribe

/** The version a comment was made on, when it was made inside a group. */
export function shownVersionOf(element: Element): ShownVersion | undefined {
  const group = element.closest('dib-variants')?.getAttribute('data-group')
  const meta = group ? bridge().groups.get(group) : undefined
  if (!group || !meta) return undefined
  const index = shownIndex(group, meta.labels.length)
  return { group, index, label: meta.labels[index] ?? '', tweaks: chosenTweaks(group, index, meta.tweaks[index]) }
}

function chosenTweaks(group: string, index: number, specs: Record<string, TweakSpec> | undefined): ChosenTweak[] {
  const values = valuesFor(group, index, specs)
  return Object.entries(specs ?? {}).map(([id, spec]) => ({ id, label: spec.label, value: values[id] ?? spec.default }))
}

function describe(tweak: ChosenTweak, spec: TweakSpec | undefined): string {
  if (typeof tweak.value === 'boolean') return `${tweak.label} ${tweak.value ? 'on' : 'off'}`
  const unit = spec?.kind === 'range' ? (spec.unit ?? '') : ''
  return `${tweak.label} ${tweak.value}${unit}`
}

const wrapperOf = (group: string) => document.querySelector(`dib-variants[data-group="${CSS.escape(group)}"]`)

/** A pick the agent has not applied yet: in the stack, or sent and still pending. */
function pendingPick(state: PageState, group: string): { label: string } | null {
  const sent = state.batches.flatMap((batch) => batch.comments).filter((comment) => comment.status === 'pending')
  const pick = [...state.draft, ...sent].filter(isPick).find((comment) => comment.intent.group === group)
  return pick ? { label: pick.intent.label } : null
}

/** The bar's width with Tweaks and the pick button showing: it is placed at that width, so hover never moves it. */
function fullWidth(node: HTMLElement): number {
  node.classList.add('measuring')
  const width = query<HTMLElement>(node, '.variant-bar').offsetWidth
  node.classList.remove('measuring')
  return width
}

function nodeFor(group: string): HTMLElement {
  const existing = layer.querySelector<HTMLElement>(`:scope > [data-group="${CSS.escape(group)}"]`)
  if (existing) return existing
  const node = el('div', { className: 'variant', attrs: { 'data-group': group } })
  // Once the pointer and focus have left, the switcher may move to fit the version now shown.
  const settle = () => requestAnimationFrame(renderVariants)
  node.addEventListener('pointerleave', settle)
  node.addEventListener('focusout', settle)
  layer.append(node)
  return node
}

export function renderVariants(): void {
  if (!layer) return
  const state = readState()
  const groups = bridge().groups
  for (const node of [...layer.children] as HTMLElement[]) if (!groups.has(node.dataset.group ?? '')) node.remove()

  for (const [group, meta] of groups) {
    const wrapper = wrapperOf(group)
    const box = wrapper ? boxOf(wrapper) : null
    if (!wrapper || !box) {
      layer.querySelector(`:scope > [data-group="${CSS.escape(group)}"]`)?.remove()
      continue
    }
    const node = nodeFor(group)
    const index = shownIndex(group, meta.labels.length)
    const specs = meta.tweaks[index] ?? {}
    const hasTweaks = Object.keys(specs).length > 0
    const values = valuesFor(group, index, specs)
    const model = {
      group,
      labels: meta.labels,
      index,
      alternative: index === 0 ? (lastAlternative.get(group) ?? 1) : index,
      hasTweaks,
      reserveTweaks: meta.tweaks.some((versionSpecs) => Object.keys(versionSpecs).length > 0),
      tweaksOpen: open.has(group),
      pick: pendingPick(state, group),
      agent: agentName(state),
    }
    node.classList.toggle('open', model.tweaksOpen)
    const signature = JSON.stringify([model, specs])
    if (node.dataset.signature !== signature) {
      node.dataset.signature = signature
      // The bar is rebuilt on every switch; a keyboard user keeps focus on the same control.
      const active = root.activeElement
      const focused = active instanceof HTMLElement && node.contains(active) ? active.dataset.action : undefined
      node.replaceChildren(bar(model), ...(model.tweaksOpen && hasTweaks && !model.pick ? [tweaksCard(specs, values)] : []))
      if (focused) node.querySelector<HTMLElement>(`[data-action="${focused}"]`)?.focus()
    } else {
      syncControls(node, values, root.activeElement)
    }
    place(group, node, box, wrapper)
  }
}

function place(group: string, node: HTMLElement, box: DOMRect, wrapper: Element): void {
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

function show(group: string, index: number): void {
  bridge().choices[group] = index
  notify()
  void sendOp({ type: 'show-variant', group, index })
}

function setTweak(group: string, index: number, id: string, value: TweakValue): void {
  const key = versionKey(group, index)
  const shared = bridge()
  shared.values[key] = { ...shared.values[key], [id]: value }
  notify()
  // Live on the page at once; saved to the plugin once the drag settles.
  const pendingKey = `${key}/${id}`
  unsaved.set(pendingKey, value)
  clearTimeout(saveTimers.get(pendingKey))
  saveTimers.set(
    pendingKey,
    setTimeout(() => void sendOp({ type: 'set-tweak', group, index, id, value }).catch(() => {}), SAVE_DELAY_MS)
  )
}

/** Sends the pick: the version shown, with every tweak as the user left it. */
async function use(group: string): Promise<void> {
  const meta = bridge().groups.get(group)
  if (!meta) return
  const index = shownIndex(group, meta.labels.length)
  const label = meta.labels[index] ?? ''
  const specs = meta.tweaks[index]
  const tweaks = chosenTweaks(group, index, specs)
  const wrapper = wrapperOf(group)
  const [first = null] = wrapper ? shownElements(wrapper) : []
  const details = tweaks.map((tweak) => describe(tweak, specs?.[tweak.id])).join(', ')
  const comment = newComment({
    text: `Use “${label}” for ${group}${details ? ` (${details})` : ''}`,
    page: capturePage(),
    element: first ? captureElement(first) : null,
    intent: { kind: 'choose-variant', group, index, label, tweaks },
  })
  open.delete(group)
  // A pick is a decision: it goes to the agent right away when a session is there, else waits in the stack.
  await addComment(comment, true)
}

function onClick(event: Event): void {
  const target = (event.target as Element).closest<HTMLElement>('[data-action]')
  const group = target?.closest<HTMLElement>('.variant')?.dataset.group
  const meta = group ? bridge().groups.get(group) : undefined
  if (!target || !group || !meta) return
  const index = shownIndex(group, meta.labels.length)
  // The arrows page through the alternatives (1..n) only; Before is its own button.
  const alternatives = meta.labels.length - 1
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
    case 'tweaks': {
      if (open.has(group)) open.delete(group)
      else open.add(group)
      // The switcher stays where it is; the card finds its own spot.
      const held = placed.get(group)
      if (held) placed.set(group, { bar: held.bar })
      renderVariants()
      return
    }
    case 'use':
      void use(group)
      return
    case 'choice':
      setTweak(group, index, target.dataset.tweak ?? '', target.dataset.value ?? '')
      return
  }
}

function onInput(event: Event): void {
  const input = event.target
  if (!(input instanceof HTMLInputElement)) return
  const id = input.dataset.tweak
  const group = input.closest<HTMLElement>('.variant')?.dataset.group
  const meta = group ? bridge().groups.get(group) : undefined
  if (!id || !group || !meta) return
  const index = shownIndex(group, meta.labels.length)
  if (input.type === 'checkbox') {
    setTweak(group, index, id, input.checked)
    return
  }
  showRangeValue(input)
  setTweak(group, index, id, Number(input.value))
}
