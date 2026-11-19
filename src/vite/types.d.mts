// Types for `design-in-browser/vite`, published as dist/vite.d.mts. test/public-types.ts checks them against
// the implementation in plugin.ts.
import type { Plugin } from 'vite'

export type DesignInBrowserOptions = {
  /** The project the agent works in. Defaults to the git root above Vite's root, else Vite's root. */
  projectRoot?: string
}

/** Puts Design in Browser into the app's dev server. Put it first in `plugins`. Does nothing in a build. */
export default function designInBrowser(options?: DesignInBrowserOptions): Plugin[]
