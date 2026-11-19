// Bundles the bridge into the plugin (self-contained, no node_modules at install time)
// and the extension scripts into extension/dist.
import crypto from 'node:crypto'
import { build } from 'esbuild'

const buildId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`

await build({
  entryPoints: { daemon: 'src/bridge/daemon.ts', mcp: 'src/bridge/mcp.ts' },
  outdir: 'plugin/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // ws loads these optional native helpers inside try/catch.
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  // Keeps names readable in stack traces while cutting the committed bundle size.
  minifyWhitespace: true,
  minifySyntax: true,
  logLevel: 'warning',
})

await build({
  entryPoints: { background: 'src/extension/background.ts' },
  outdir: 'extension/dist',
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  logLevel: 'warning',
})

await build({
  entryPoints: { content: 'src/extension/content.ts', sidepanel: 'src/extension/sidepanel.ts' },
  outdir: 'extension/dist',
  bundle: true,
  format: 'iife',
  // The overlay's CSS goes into its shadow root as a string.
  loader: { '.css': 'text' },
  target: 'chrome120',
  logLevel: 'warning',
})

// The panel stylesheet pulls in the shared tokens with @import.
await build({
  entryPoints: { sidepanel: 'src/extension/sidepanel.css' },
  outdir: 'extension/dist',
  bundle: true,
  target: 'chrome120',
  logLevel: 'warning',
})

console.log(`built ${buildId}`)
