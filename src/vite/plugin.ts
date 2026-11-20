// Vite plugin: puts Design in Browser into the app's own dev server.
//   vite.config.ts:  plugins: [designInBrowser(), react()]
// Dev server only (apply: 'serve'). It injects the client into index.html (Astro's integration puts it into its
// pages instead), serves it as a virtual module, and relays between pages (over Vite's HMR socket) and the local
// daemon (over its token-guarded socket).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { CLIENT_MODULE, PAGE_EVENT, SOURCE_ATTRIBUTE, type OpAck, type OpRequest } from '../shared/page-protocol.ts'
import { PRODUCT_NAME } from '../shared/protocol.ts'
import { Hub } from './hub.ts'

export type DesignInBrowserOptions = {
  /** The project the agent works in. Defaults to the git root above Vite's root, else Vite's root. */
  projectRoot?: string
  /**
   * Put each element's source location (`data-dib-src="src/App.tsx:12:5"`) on the elements React renders from the
   * project's JSX, so the agent opens the right file. Default true.
   */
  sourceLocations?: boolean
}

const RESOLVED_CLIENT = `\0${CLIENT_MODULE}`
const REACT_MODULE = 'design-in-browser/react'
const RESOLVED_REACT = '\0design-in-browser:react'
const JSX_DEV_RUNTIME = 'react/jsx-dev-runtime'

/**
 * A jsxDEV, on one line, that puts each host element's source location on it as an attribute the overlay can read,
 * then calls React's (`react`, an expression). The dev JSX transform already passes each element's file, line and
 * column. Paths are relative to the project root, or absolute for a file outside it; elements from node_modules get
 * none.
 */
function stampingJsxDEV(projectRoot: string, react: string): string {
  const root = JSON.stringify(projectRoot.endsWith('/') ? projectRoot : `${projectRoot}/`)
  return `function (type, props, key, isStatic, source, self) { const file = source && source.fileName; if (typeof type === 'string' && file && !file.includes('/node_modules/')) { const where = file.startsWith(${root}) ? file.slice(${root}.length) : file; props = { ...props, ${JSON.stringify(SOURCE_ATTRIBUTE)}: where + ':' + source.lineNumber + ':' + source.columnNumber }; } return ${react}(type, props, key, isStatic, source, self); }`
}

const DEV_RUNTIME_IMPORT = /import\s*\{([^}]*)\}\s*from\s*(['"])react\/jsx-dev-runtime\2;?/

/**
 * Wraps jsxDEV inside one compiled module, in the browser and on the server alike: on the server Vite leaves
 * `react/jsx-dev-runtime` to Node, so nothing short of the module itself can stand in for it, and one way for both
 * keeps server-rendered HTML and the browser's render the same, so hydration matches. The import stays on its own
 * line, so the lines below keep their numbers. Null when the module doesn't import jsxDEV.
 */
export function stampJsxInModule(code: string, projectRoot: string): string | null {
  const found = DEV_RUNTIME_IMPORT.exec(code)
  if (!found) return null
  let local: string | null = null
  const specifiers = (found[1] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const [imported, alias] = part.split(/\s+as\s+/)
      if (imported !== 'jsxDEV') return part
      local = alias ?? imported
      return 'jsxDEV as __dibReactJsxDEV'
    })
  if (local === null) return null
  const quote = found[2]
  return code.replace(
    found[0],
    `import { ${specifiers.join(', ')} } from ${quote}${JSX_DEV_RUNTIME}${quote}; const ${local} = ${stampingJsxDEV(projectRoot, '__dibReactJsxDEV')};`
  )
}

const LEFTOVER = `A <Variants> group from ${REACT_MODULE} is still in the code. Pick a version in the browser (the agent then removes the wrapper), or remove it by hand, before building.`

function gitRoot(dir: string): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : dir
}

/** Only a dev server that listens on loopback alone may carry comments into an agent's session. */
function loopbackOnly(address: AddressInfo | string | null | undefined): address is AddressInfo {
  if (!address || typeof address === 'string') return false
  return address.address === '::1' || address.address.startsWith('127.')
}

/** A position the dev JSX transform passes to jsxDEV, as written in a compiled module. */
const SOURCE_POSITION = /lineNumber: (\d+),(\s*)columnNumber: (\d+)/g
/** How far down a header can push a module's code; past it, positions are left as they are. */
const MAX_LINE_SHIFT = 64

/**
 * How many lines too low a compiled module reports its JSX elements. @vitejs/plugin-react 4 puts React Refresh's
 * header above the source before the JSX is compiled, so every element is reported that many lines down (19).
 * Found from where each element's `<` really is in the original source: 0 when they line up already, or when no
 * one shift lines them all up.
 */
export function lineShift(original: string, compiled: string): number {
  const lines = original.split('\n')
  const positions = [...compiled.matchAll(SOURCE_POSITION)].map((match) => ({ line: Number(match[1]), column: Number(match[3]) }))
  const hits = (shift: number) => positions.filter(({ line, column }) => lines[line - 1 - shift]?.[column - 1] === '<').length
  if (positions.length === 0 || hits(0) === positions.length) return 0
  for (let shift = 1; shift <= MAX_LINE_SHIFT; shift++) if (hits(shift) === positions.length) return shift
  return 0
}

/** The compiled module with its JSX positions moved up `shift` lines, back onto the source. */
export function shiftLines(compiled: string, shift: number): string {
  return compiled.replace(
    SOURCE_POSITION,
    (_, line: string, space: string, column: string) => `lineNumber: ${Number(line) - shift},${space}columnNumber: ${column}`
  )
}

/** What the dev server learns once it listens, shared by the plugins below. */
type DevState = { enabled: boolean; projectRoot: string }

export default function designInBrowser(options: DesignInBrowserOptions = {}): Plugin[] {
  const state: DevState = { enabled: false, projectRoot: '' }
  const plugins = [devServer(options, state), buildGuard()]
  return (options.sourceLocations ?? true) ? [...plugins, sourceLocations(state)] : plugins
}

/**
 * Source locations, for every module of the project's own with JSX, in the browser and on the server: after the
 * JSX is compiled, positions a transform above the compiler pushed down go back on their lines (lineShift, from the
 * file on disk), then jsxDEV is wrapped in place to put each element's location on it (stampJsxInModule).
 */
function sourceLocations(state: DevState): Plugin {
  return {
    name: `${PRODUCT_NAME}:source-locations`,
    apply: 'serve',
    enforce: 'post',
    transform(code, id) {
      const file = id.split('?')[0] ?? id
      if (!state.enabled || id.startsWith('\0') || file.includes('/node_modules/') || !code.includes('react/jsx-dev-runtime')) return null
      const shift = /\.[jt]sx$/.test(file) && fs.existsSync(file) ? lineShift(fs.readFileSync(file, 'utf8'), code) : 0
      const stamped = stampJsxInModule(shift === 0 ? code : shiftLines(code, shift), state.projectRoot)
      return stamped === null ? null : { code: stamped, map: null }
    },
  }
}

/** A build that still imports the alternatives wrapper fails here, with the reason, instead of shipping it. */
function buildGuard(): Plugin {
  return {
    name: `${PRODUCT_NAME}:build-guard`,
    apply: 'build',
    enforce: 'pre',
    resolveId(id) {
      if (id === REACT_MODULE) this.error(LEFTOVER)
      return undefined
    },
  }
}

function devServer(options: DesignInBrowserOptions, state: DevState): Plugin {
  let hub: Hub | null = null

  return {
    name: PRODUCT_NAME,
    apply: 'serve',
    enforce: 'pre',

    resolveId(id) {
      if (id === CLIENT_MODULE) return RESOLVED_CLIENT
      // Served from here, not from the package, so `react` inside it is the app's own React.
      if (id === REACT_MODULE) return RESOLVED_REACT
      return undefined
    },

    load(id) {
      // Empty while off: Astro puts the client into every page whether or not the plugin turned itself on.
      if (id === RESOLVED_CLIENT)
        return state.enabled ? fs.readFileSync(fileURLToPath(new URL('./client.js', import.meta.url)), 'utf8') : ''
      if (id === RESOLVED_REACT) return fs.readFileSync(fileURLToPath(new URL('./react-dev.js', import.meta.url)), 'utf8')
      return undefined
    },

    transformIndexHtml() {
      if (!state.enabled) return undefined
      return [{ tag: 'script', attrs: { type: 'module', src: `/@id/__x00__${CLIENT_MODULE}` }, injectTo: 'body' }]
    },

    configureServer(server) {
      state.projectRoot = options.projectRoot ?? gitRoot(server.config.root)
      const hot = server.environments.client.hot

      // The hub exists once the server listens on loopback, and not otherwise: then the page is left alone.
      server.httpServer?.once('listening', () => {
        // With HMR off (as in some end-to-end setups) there is no socket to talk over: stay out of the page.
        if (server.config.server.hmr === false) return
        const address = server.httpServer?.address()
        if (!loopbackOnly(address)) {
          server.config.logger.warn(
            `[${PRODUCT_NAME}] Off: this dev server listens beyond localhost (--host), so anyone on the network could send text into your agent's session. Run it on localhost to use it.`
          )
          return
        }
        state.enabled = true
        hub = new Hub(state.projectRoot, server.config.root, address.port, (next) => hot.send(PAGE_EVENT.state, next))
        hub.start()
      })
      server.httpServer?.once('close', () => hub?.stop())

      hot.on(PAGE_EVENT.hello, (_data, client) => {
        if (hub) client.send(PAGE_EVENT.state, hub.state)
      })
      hot.on(PAGE_EVENT.op, (request: OpRequest, client) => {
        if (!hub) return
        let ack: OpAck
        try {
          const error = hub.apply(request.op)
          ack = error === null ? { id: request.id, ok: true } : { id: request.id, ok: false, error }
        } catch (error) {
          ack = { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        client.send(PAGE_EVENT.ack, ack)
      })
    },
  }
}
