import type { ReactNode } from 'react'
import { Variant, Variants } from 'design-in-browser/react'

/** As an agent writes alternatives on an Astro page: the original markup comes in from Astro as children. */
export function TaglineVariants({ children }: { children?: ReactNode }) {
  return (
    <Variants group="tagline">
      <Variant label="Before">{children}</Variant>
      <Variant label="Louder">
        <p className="tagline-louder">FRESH ROASTS EVERY MORNING</p>
      </Variant>
    </Variants>
  )
}
