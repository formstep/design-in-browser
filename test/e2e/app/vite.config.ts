// Fixture app for the e2e suite. It loads the built plugin, as an app that installed the package would.
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import designInBrowser from '../../../dist/vite.mjs'

/** /strict.html gets a CSP with no 'unsafe-inline', to prove the overlay styles itself without <style> tags. */
const strictCsp: Plugin = {
  name: 'strict-csp',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/strict')) {
        res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'")
      }
      next()
    })
  },
}

export default {
  plugins: [designInBrowser({ projectRoot: process.env.DIB_PROJECT_ROOT }), react(), strictCsp],
  logLevel: 'error',
  build: {
    outDir: process.env.DIB_BUILD_OUT ?? 'dist',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        variants: fileURLToPath(new URL('./variants.html', import.meta.url)),
      },
    },
  },
}
