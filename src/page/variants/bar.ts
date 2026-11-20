// The switcher's bar. Version 0 is the original, "Before". With one alternative the bar is a Before | After
// toggle; with more, a Before | <alternative> toggle plus arrows through the alternatives. Tweaks and the pick
// button join on hover. Its width never changes between versions, so a second click lands on the same button.
import { icon } from '../icons.ts'
import { button, el } from '../ui/dom.ts'

type BarModel = {
  group: string
  labels: string[]
  /** The version shown. */
  index: number
  /** The alternative the arrows start from: the one shown, or the last one seen while Before shows. */
  alternative: number
  hasTweaks: boolean
  /** Another version has tweaks: keep an empty slot so the pick button stays put. */
  reserveTweaks: boolean
  tweaksOpen: boolean
  /** A pick the agent has not applied yet: the bar freezes on it. */
  pick: { label: string } | null
  /** Why the last pick didn't reach the agent: shown beside the controls, which stay, so the user can pick again. */
  pickError: string | null
  agent: string
}

const action = (name: string, label: string) => ({ 'data-action': name, 'aria-label': label })

/**
 * Text as wide as the widest of `all`: every option sits in the same grid cell and only `shown` is visible,
 * so switching versions never shifts the controls after it.
 */
function steadyText(target: HTMLElement, shown: string, all: string[]): void {
  target.classList.add('steady')
  const spares = [...new Set(all.filter((option) => option !== shown))]
  target.replaceChildren(
    el('span', { className: 'steady-shown', textContent: shown }),
    ...spares.map((option) => el('span', { className: 'steady-spare', textContent: option, attrs: { 'aria-hidden': 'true' } }))
  )
}

function segment(label: string, name: string, pressed: boolean, className = 'segment'): HTMLButtonElement {
  return button({ className, textContent: label, attrs: { ...action(name, label), 'aria-pressed': String(pressed) } })
}

export function bar(model: BarModel): HTMLElement {
  const { group, labels, index } = model
  const element = el('div', { className: 'variant-bar', attrs: { role: 'toolbar', 'aria-label': `Versions of ${group}` } })
  const name = el('span', { className: 'variant-group', html: icon('layers', 14) }, [group])
  if (model.pick) {
    element.append(
      name,
      el('span', { className: 'variant-picked', textContent: `Picked “${model.pick.label}” · waiting for ${model.agent}` })
    )
    return element
  }
  const alternatives = labels.length - 1
  const before = segment('Before', 'before', index === 0)
  element.append(name)
  if (alternatives === 1) {
    const after = segment('After', 'after', index === 1)
    after.title = labels[1] ?? ''
    element.append(el('span', { className: 'segments' }, [before, after]))
  } else if (alternatives > 1) {
    const label = labels[model.alternative] ?? ''
    const shown = segment(label, 'after', index > 0, 'segment variant-label')
    steadyText(shown, label, labels.slice(1))
    shown.title = label
    element.append(
      el('span', { className: 'segments' }, [before, shown]),
      button({ className: 'variant-step', html: icon('chevronLeft', 16), attrs: action('prev', 'Previous alternative') }),
      el('span', {
        className: 'variant-count',
        textContent: `${model.alternative} / ${alternatives}`,
        attrs: { 'data-testid': 'variant-count' },
      }),
      button({ className: 'variant-step', html: icon('chevronRight', 16), attrs: action('next', 'Next alternative') })
    )
    if (index === 0) element.classList.add('on-before')
  }
  if (model.hasTweaks && index > 0) {
    element.append(
      button({
        className: 'variant-tweaks',
        html: `${icon('sliders', 15)}<span>Tweaks</span>`,
        attrs: { ...action('tweaks', 'Tweaks'), 'aria-pressed': String(model.tweaksOpen) },
      })
    )
  } else if (model.reserveTweaks) {
    element.append(
      el('span', {
        className: 'variant-tweaks reserved',
        html: `${icon('sliders', 15)}<span>Tweaks</span>`,
        attrs: { 'aria-hidden': 'true' },
      })
    )
  }
  const keepAfter = alternatives === 1 ? 'Keep after' : 'Use this'
  const use = button({
    className: 'variant-use',
    attrs: action('use', index === 0 ? 'Keep before' : `Use ${labels[index] ?? 'this version'}`),
  })
  steadyText(use, index === 0 ? 'Keep before' : keepAfter, ['Keep before', keepAfter])
  element.append(use)
  if (model.pickError) element.append(el('span', { className: 'variant-error', textContent: model.pickError, attrs: { role: 'alert' } }))
  return element
}
