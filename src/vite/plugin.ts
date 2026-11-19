// Vite plugin: puts Design in Browser into the app's own dev server.
//   vite.config.ts:  plugins: [designInBrowser(), react()]
// Dev server only (apply: 'serve'). It injects the client into index.html, serves it as a virtual module,
// and relays between pages (over Vite's HMR socket) and the local daemon (over its token-guarded socket).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'
import { CLIENT_MODULE, PAGE_EVENT, type OpAck, type OpRequest } from '../shared/page-protocol.ts'
import { PRODUCT_NAME } from '../shared/protocol.ts'
import { Hub } from './hub.ts'

export type DesignInBrowserOptions = {
  /** The project the agent works in. Defaults to the git root above Vite's root, else Vite's root. */
  projectRoot?: string
}

const RESOLVED_CLIENT = `\0${CLIENT_MODULE}`
const REACT_MODULE = 'design-in-browser/react'
const RESOLVED_REACT = '\0design-in-browser:react'
const LEFTOVER = `A <Variants> group from ${REACT_MODULE} is still in the code. Pick a version in the browser (the agent then removes the wrapper), or remove it by hand, before building.`

function gitRoot(dir: string): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : dir
}

/** Only a dev server that listens on loopback alone may carry comments into an agent's session. */
function loopbackOnly(address: AddressInfo | string | null | undefined): boolean {
  if (!address || typeof address === 'string') return false
  return address.address === '::1' || address.address.startsWith('127.')
}

export default function designInBrowser(options: DesignInBrowserOptions = {}): Plugin[] {
  return [devServer(options), buildGuard()]
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

function devServer(options: DesignInBrowserOptions): Plugin {
  let enabled = false
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
      if (id === RESOLVED_CLIENT) return fs.readFileSync(fileURLToPath(new URL('./client.js', import.meta.url)), 'utf8')
      if (id === RESOLVED_REACT) return fs.readFileSync(fileURLToPath(new URL('./react-dev.js', import.meta.url)), 'utf8')
      return undefined
    },

    transformIndexHtml() {
      if (!enabled) return undefined
      return [{ tag: 'script', attrs: { type: 'module', src: `/@id/__x00__${CLIENT_MODULE}` }, injectTo: 'body' }]
    },

    configureServer(server) {
      const projectRoot = options.projectRoot ?? gitRoot(server.config.root)
      const hot = server.environments.client.hot
      hub = new Hub(projectRoot, server.config.root, (state) => hot.send(PAGE_EVENT.state, state))

      server.httpServer?.once('listening', () => {
        // With HMR off (as in some end-to-end setups) there is no socket to talk over: stay out of the page.
        if (server.config.server.hmr === false) return
        enabled = loopbackOnly(server.httpServer?.address())
        if (!enabled) {
          server.config.logger.warn(
            `[${PRODUCT_NAME}] Off: this dev server listens beyond localhost (--host), so anyone on the network could send text into your agent's session. Run it on localhost to use it.`
          )
          return
        }
        hub?.start()
      })
      server.httpServer?.once('close', () => hub?.stop())

      hot.on(PAGE_EVENT.hello, (_data, client) => {
        if (enabled && hub) client.send(PAGE_EVENT.state, hub.state)
      })
      hot.on(PAGE_EVENT.op, (request: OpRequest, client) => {
        if (!enabled || !hub) return
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
