// `design-in-browser/react` in development: the plugin serves this as a virtual module, so `react` resolves to
// the app's own copy. An agent writes alternatives with it:
//
//   <Variants group="pricing-hero">
//     <Variant label="Before">{/* the original, unchanged */}</Variant>
//     <Variant label="Tinted card" tweaks={{ padding: { kind: 'range', label: 'Padding', min: 24, max: 96, step: 8, default: 48, unit: 'px' } }}>
//       {(t) => <section style={{ padding: t.padding }}>…</section>}
//     </Variant>
//   </Variants>
//
// Only the version the user is looking at renders; the overlay's switcher changes it and its tweaks live.
import { Children, createElement, isValidElement, useEffect, useSyncExternalStore, type ReactElement, type ReactNode } from 'react'
import type { TweakSpec, TweakValue } from '../shared/protocol.ts'
import { bridge, notify, shownIndex, subscribe, valuesFor } from '../shared/variants-bridge.ts'

type VariantProps = {
  label: string
  tweaks?: Record<string, TweakSpec>
  children?: ReactNode | ((values: Record<string, TweakValue>) => ReactNode)
}

/** One version inside `<Variants>`. It renders only through its group. */
export function Variant(_props: VariantProps): ReactNode {
  throw new Error('design-in-browser: <Variant> only works inside <Variants>.')
}

export function Variants({ group, children }: { group: string; children?: ReactNode }): ReactNode {
  useSyncExternalStore(subscribe, () => bridge().revision)
  const versions = Children.toArray(children).filter(
    (child): child is ReactElement<VariantProps> => isValidElement(child) && child.type === Variant,
  )
  const labels = versions.map((version) => version.props.label)
  const specs = versions.map((version) => version.props.tweaks ?? {})
  const shape = JSON.stringify([labels, specs])

  // The overlay finds groups through the bridge. A group rendered twice registers twice and stays until both go.
  useEffect(() => {
    const groups = bridge().groups
    const [savedLabels, savedSpecs] = JSON.parse(shape) as [string[], Array<Record<string, TweakSpec>>]
    groups.set(group, { labels: savedLabels, tweaks: savedSpecs, mounted: (groups.get(group)?.mounted ?? 0) + 1 })
    notify()
    return () => {
      const current = groups.get(group)
      if (!current) return
      if (current.mounted <= 1) groups.delete(group)
      else groups.set(group, { ...current, mounted: current.mounted - 1 })
      notify()
    }
  }, [group, shape])

  const index = shownIndex(group, versions.length)
  const version = versions[index]
  if (!version) return null
  const body = version.props.children
  const content = typeof body === 'function' ? body(valuesFor(group, index, version.props.tweaks)) : body
  // `key` remounts a version when it changes, so state from one version never leaks into another.
  return createElement('dib-variants', { 'data-group': group, 'data-index': index, key: index, style: { display: 'contents' } }, content)
}
