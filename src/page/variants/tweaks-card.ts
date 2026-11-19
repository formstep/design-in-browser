// The tweaks card: one row per knob the agent gave the version shown, label left and control right.
import type { TweakSpec, TweakValue } from '../../shared/protocol.ts'
import { button, el } from '../ui/dom.ts'

export function tweaksCard(specs: Record<string, TweakSpec>, values: Record<string, TweakValue>): HTMLElement {
  return el(
    'div',
    { className: 'tweaks' },
    Object.entries(specs).map(([id, spec]) =>
      el('label', { className: 'tweak' }, [
        el('span', { className: 'tweak-label', textContent: spec.label }),
        control(id, spec, values[id] ?? spec.default),
      ])
    )
  )
}

function control(id: string, spec: TweakSpec, value: TweakValue): HTMLElement {
  switch (spec.kind) {
    case 'toggle': {
      const input = el('input', { className: 'switch', attrs: { type: 'checkbox', 'data-tweak': id } })
      input.checked = value === true
      return input
    }
    case 'range': {
      const input = el('input', {
        attrs: { type: 'range', 'data-tweak': id, min: String(spec.min), max: String(spec.max), step: String(spec.step) },
      })
      input.value = String(value)
      const unit = spec.unit ?? ''
      return el('span', { className: 'range' }, [
        input,
        el('output', { className: 'range-value', textContent: `${value}${unit}`, attrs: { 'data-unit': unit } }),
      ])
    }
    case 'choice':
      return el(
        'span',
        { className: 'choices', attrs: { role: 'radiogroup' } },
        spec.options.map((option) =>
          button({
            className: 'choice',
            textContent: option,
            attrs: {
              'aria-label': option,
              'aria-pressed': String(option === value),
              'data-action': 'choice',
              'data-tweak': id,
              'data-value': option,
            },
          })
        )
      )
  }
}

/** Keeps controls in step with values set elsewhere (another tab), without rebuilding a slider mid-drag. */
export function syncControls(node: HTMLElement, values: Record<string, TweakValue>, active: Element | null): void {
  for (const input of node.querySelectorAll<HTMLInputElement>('input[data-tweak]')) {
    const value = values[input.dataset.tweak ?? '']
    if (value === undefined || active === input) continue
    if (input.type === 'checkbox') input.checked = value === true
    else input.value = String(value)
  }
  for (const choice of node.querySelectorAll<HTMLElement>('.choice')) {
    choice.setAttribute('aria-pressed', String(values[choice.dataset.tweak ?? ''] === choice.dataset.value))
  }
}

/** Shows a range's value beside it as the slider moves. */
export function showRangeValue(input: HTMLInputElement): void {
  const output = input.parentElement?.querySelector<HTMLOutputElement>('.range-value')
  if (output) output.textContent = `${input.value}${output.dataset.unit ?? ''}`
}
