// Shared between the app's <Variants> components (served by the plugin, using the app's own React) and the
// overlay's switcher. Two separate bundles include this file; whichever loads first creates the one bridge
// on `window`, and both read and write it. Changes apply here at once (a slider moves the page live) and the
// overlay saves them to the plugin, so a reload or another tab shows the same version and values.
import { versionKey } from './page-protocol.ts'
import type { TweakSpec, TweakValue } from './protocol.ts'

/**
 * What a `<Variants>` group registers: one label and one set of tweak specs per version. Version 0 is always
 * the original ("Before"); with one alternative the switcher is a Before/After toggle, with more it pages
 * through the alternatives and keeps Before one click away.
 */
export type GroupMeta = { labels: string[]; tweaks: Array<Record<string, TweakSpec>> }

export type VariantsBridge = {
  /** Bumped on every change, as the snapshot for React's useSyncExternalStore. */
  revision: number
  /** group -> index of the version shown */
  choices: Record<string, number>
  /** `versionKey(group, index)` -> tweak id -> value */
  values: Record<string, Record<string, TweakValue>>
  /** Groups mounted on the page, with how many times each is rendered. */
  groups: Map<string, GroupMeta & { mounted: number }>
  listeners: Set<() => void>
}

const KEY = '__designInBrowserVariants'

export function bridge(): VariantsBridge {
  const scope = globalThis as unknown as Record<string, VariantsBridge | undefined>
  scope[KEY] ??= { revision: 0, choices: {}, values: {}, groups: new Map(), listeners: new Set() }
  return scope[KEY]
}

export function notify(): void {
  const shared = bridge()
  shared.revision += 1
  for (const listener of shared.listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  const shared = bridge()
  shared.listeners.add(listener)
  return () => shared.listeners.delete(listener)
}

/** Before anyone picks, a group shows its first alternative (index 1) when it has one: that is what was asked for. */
export function shownIndex(group: string, count: number): number {
  const chosen = bridge().choices[group]
  if (chosen !== undefined && chosen >= 0 && chosen < count) return chosen
  return count > 1 ? 1 : 0
}

/** The values a version renders with: its defaults, overridden by what the user set for ids the version still has. */
export function valuesFor(group: string, index: number, specs: Record<string, TweakSpec> | undefined): Record<string, TweakValue> {
  const stored = bridge().values[versionKey(group, index)] ?? {}
  const values: Record<string, TweakValue> = {}
  for (const [id, spec] of Object.entries(specs ?? {})) {
    const value = stored[id]
    values[id] = value !== undefined && typeof value === typeof spec.default ? value : spec.default
  }
  return values
}
