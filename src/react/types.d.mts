// Types for `design-in-browser/react`. In development the Vite plugin serves the implementation;
// in a build the package entry throws, because a <Variants> group must be resolved before shipping.
import type { ReactNode } from 'react'

export type TweakSpec =
  | { kind: 'toggle'; label: string; default: boolean }
  | { kind: 'range'; label: string; min: number; max: number; step: number; default: number; unit?: string }
  | { kind: 'choice'; label: string; options: readonly string[]; default: string }

type ValueOf<S> = S extends { kind: 'toggle' } ? boolean : S extends { kind: 'range' } ? number : string

/** What a version's render function receives: one value per tweak, typed by its kind. */
export type TweakValues<T extends Record<string, TweakSpec>> = { [K in keyof T]: ValueOf<T[K]> }

/** One version inside `<Variants>`: plain JSX, or a function of its tweak values. */
export declare function Variant<T extends Record<string, TweakSpec> = Record<string, never>>(props: {
  label: string
  tweaks?: T
  children?: ReactNode | ((values: TweakValues<T>) => ReactNode)
}): ReactNode

/**
 * Alternatives for one part of the page. The first `<Variant>` is the design as it is now, unchanged: the page
 * shows it as "Before". One alternative is shown as a Before/After toggle; more are paged through.
 */
export declare function Variants(props: { group: string; children?: ReactNode }): ReactNode
