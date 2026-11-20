// Types for `design-in-browser/astro`, published as dist/astro.d.mts. test/public-types.ts checks them against
// the implementation in integration.ts.
import type { AstroIntegration } from 'astro'
import type { DesignInBrowserOptions } from '../vite/types.d.mts'

export type { DesignInBrowserOptions }

/** Puts Design in Browser into Astro's dev server and its pages. Does nothing in a build. */
export default function designInBrowser(options?: DesignInBrowserOptions): AstroIntegration
