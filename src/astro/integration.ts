// Astro integration: the Vite plugin, plus the page client in every page Astro renders in dev.
//   astro.config.mjs:  integrations: [designInBrowser(), react()]
// Astro renders its own pages, so the client can't go into an index.html as it does for a Vite app. Only React
// islands get source locations; markup written in .astro files has none, and the agent finds it by its text.
import type { AstroIntegration } from 'astro'
import { CLIENT_MODULE } from '../shared/page-protocol.ts'
import { PRODUCT_NAME } from '../shared/protocol.ts'
import designInBrowserVite, { type DesignInBrowserOptions } from '../vite/plugin.ts'

export type { DesignInBrowserOptions }

export default function designInBrowser(options: DesignInBrowserOptions = {}): AstroIntegration {
  return {
    name: PRODUCT_NAME,
    hooks: {
      'astro:config:setup': ({ command, updateConfig, injectScript }) => {
        updateConfig({ vite: { plugins: designInBrowserVite(options) } })
        if (command === 'dev') injectScript('page', `import '${CLIENT_MODULE}'`)
      },
    },
  }
}
