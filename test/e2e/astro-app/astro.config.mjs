// Fixture Astro site for the e2e suite. It loads the built integration, as a site that installed the package would.
import react from '@astrojs/react'
import { defineConfig } from 'astro/config'
import designInBrowser from '../../../dist/astro.mjs'

export default defineConfig({
  integrations: [designInBrowser({ projectRoot: process.env.DIB_PROJECT_ROOT }), react()],
  logLevel: 'error',
})
