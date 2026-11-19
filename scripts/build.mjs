// Bundles the bridge into the Claude Code plugin (self-contained, no node_modules at install time),
// and the Vite plugin with the client it serves into dist/.
import crypto from 'node:crypto'
import fs from 'node:fs'
import { build } from 'esbuild'

// Start clean, so files from older builds never ship.
fs.rmSync('dist', { recursive: true, force: true })

const buildId = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`

await build({
  entryPoints: { daemon: 'src/daemon/daemon.ts', mcp: 'src/mcp/server.ts' },
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

// Vite plugin (Node) and the client it serves to pages.
await build({
  entryPoints: { vite: 'src/vite/plugin.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['vite', 'bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
})
fs.writeFileSync(
  'dist/vite.d.mts',
  `import type { Plugin } from 'vite'\nexport type DesignInBrowserOptions = { projectRoot?: string }\nexport default function designInBrowser(options?: DesignInBrowserOptions): Plugin[]\n`,
)

await build({
  entryPoints: { client: 'src/page/client.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  // Styles go into shadow roots as strings; import.meta.hot stays for Vite to fill in.
  loader: { '.css': 'text' },
  logLevel: 'warning',
})

// design-in-browser/react: the dev implementation (served by the plugin, `react` left to the app) and the
// package entry a build would load, which refuses, because alternatives must be resolved before shipping.
await build({
  entryPoints: { 'react-dev': 'src/react/variants.ts' },
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  external: ['react'],
  logLevel: 'warning',
})
fs.writeFileSync(
  'dist/react.mjs',
  "throw new Error('design-in-browser: a <Variants> group is still in the code. Pick a version in the browser, or remove the wrapper, before building.')\n",
)
fs.copyFileSync('src/react/types.d.mts', 'dist/react.d.mts')

console.log(`built ${buildId}`)
