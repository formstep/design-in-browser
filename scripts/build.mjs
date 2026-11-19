// Bundles the bridge into the Claude Code plugin (self-contained, no node_modules at install time),
// and the Vite plugin with the client it serves into dist/.
import crypto from 'node:crypto'
import fs from 'node:fs'
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
  `import type { Plugin } from 'vite'\nexport type DesignInBrowserOptions = { projectRoot?: string }\nexport default function designInBrowser(options?: DesignInBrowserOptions): Plugin\n`,
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

console.log(`built ${buildId}`)
