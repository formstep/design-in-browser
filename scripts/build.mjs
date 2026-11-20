// Bundles the daemon and the MCP server into the Claude Code plugin (self-contained, no node_modules at
// install time), and the Vite plugin with the client it serves into dist/.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

// Start clean, so files from older builds never ship.
fs.rmSync('dist', { recursive: true, force: true })

// The build ID tells an MCP server whether the running daemon is from the same build. It is a hash of what
// the daemon and the MCP server are built from, so the same source gives the same committed plugin/dist, and a
// change to the page alone leaves it alone.
const BRIDGE_SOURCES = ['src/daemon', 'src/mcp', 'src/node', 'src/shared']

function buildId() {
  const hash = crypto.createHash('sha256')
  const sources = BRIDGE_SOURCES.flatMap((dir) => fs.readdirSync(dir, { recursive: true }).map((name) => path.join(dir, name)))
  const files = ['package.json', 'pnpm-lock.yaml', 'scripts/build.mjs', ...sources]
  for (const file of files.sort()) {
    if (!fs.statSync(file).isFile()) continue
    hash.update(file)
    hash.update(fs.readFileSync(file))
  }
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  return `${version}-${hash.digest('hex').slice(0, 12)}`
}
const id = buildId()

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
  // The shebang lets npm install mcp.mjs as the design-in-browser-mcp command, for agents other than Claude Code.
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  define: { __BUILD_ID__: JSON.stringify(id) },
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
fs.copyFileSync('src/vite/types.d.mts', 'dist/vite.d.mts')

// The Astro integration: the same plugin, plus the client in Astro's pages.
await build({
  entryPoints: { astro: 'src/astro/integration.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['vite', 'astro', 'bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'warning',
})
// Its types import the Vite plugin's options from the published vite.d.mts.
fs.writeFileSync('dist/astro.d.mts', fs.readFileSync('src/astro/types.d.mts', 'utf8').replace("'../vite/types.d.mts'", "'./vite.d.mts'"))

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

// The setup CLI (npx design-in-browser setup <agent>), with the listening instructions it writes inlined.
await build({
  entryPoints: { cli: 'src/setup/cli.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  loader: { '.md': 'text' },
  define: { __PACKAGE_VERSION__: JSON.stringify(JSON.parse(fs.readFileSync('package.json', 'utf8')).version) },
  logLevel: 'warning',
})
fs.chmodSync('dist/cli.mjs', 0o755)

// The OpenCode plugin (the package's ./server export), with ws and its instructions inlined.
await build({
  entryPoints: { opencode: 'src/opencode/plugin.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  loader: { '.md': 'text' },
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
  "throw new Error('design-in-browser: a <Variants> group is still in the code. Pick a version in the browser, or remove the wrapper, before building.')\n"
)
fs.copyFileSync('src/react/types.d.mts', 'dist/react.d.mts')

console.log(`built ${id}`)
