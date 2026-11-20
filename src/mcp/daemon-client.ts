// Used by the MCP shim: start (or replace) the daemon, then talk to it over one socket.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { PRODUCT_NAME, type Health, type ShimMethods, type ShimResponse } from '../shared/protocol.ts'
import { BUILD_ID, config, daemonLogPath, tokenPath } from '../node/config.ts'

const baseUrl = () => `http://127.0.0.1:${config.port}`

async function readHealth(): Promise<Health | null> {
  try {
    const response = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(1000) })
    if (!response.ok) return null
    return (await response.json()) as Health
  } catch {
    return null
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function daemonScript(): string {
  // Bundled: plugin/dist/mcp.mjs sits next to plugin/dist/daemon.mjs. From source: src/mcp/ next to src/daemon/.
  const self = fileURLToPath(import.meta.url)
  const bundled = path.extname(self) === '.mjs'
  return bundled ? path.join(path.dirname(self), 'daemon.mjs') : path.join(path.dirname(self), '../daemon/daemon.ts')
}

function spawnDaemon(): void {
  fs.mkdirSync(config.home, { recursive: true, mode: 0o700 })
  const logFd = fs.openSync(daemonLogPath(), 'a')
  const child = spawn(process.execPath, [daemonScript()], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  })
  child.unref()
  fs.closeSync(logFd)
}

/** `0.5.0` from a build ID such as `0.5.0-1a2b3c4d5e6f`, as numbers; null for a build without a version (from source). */
function versionOf(buildId: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)-/.exec(buildId)
  return match ? match.slice(1).map(Number) : null
}

/**
 * Whether a daemon from `running` should make way for this build. A newer version replaces an older one, and a
 * different build of the same version replaces it too (a rebuild while developing). An older version never replaces
 * a newer one, so an outdated plugin copy left on the machine can't take the daemon from an up-to-date one.
 */
export function shouldReplace(running: string, ours: string): boolean {
  if (running === ours) return false
  const [have, mine] = [versionOf(running), versionOf(ours)]
  if (!have || !mine) return true
  for (let part = 0; part < 3; part++) if (have[part] !== mine[part]) return (mine[part] ?? 0) > (have[part] ?? 0)
  return true
}

/**
 * Makes sure a daemon is listening. With `replace`, as on live_connect, a daemon this build should replace is asked
 * to stop first. Without it, as on every other tool call and when reconnecting, any running daemon will do: two
 * builds that both replaced each other on every call would take turns killing the daemon.
 */
export async function ensureDaemon({ replace }: { replace: boolean }): Promise<void> {
  const health = await readHealth()
  if (health && health.name !== PRODUCT_NAME) {
    throw new Error(`Port ${config.port} is used by something else. Set DIB_PORT to another port.`)
  }
  if (health && !(replace && shouldReplace(health.buildId, BUILD_ID))) return
  if (health) {
    const token = fs.readFileSync(tokenPath(), 'utf8').trim()
    await fetch(`${baseUrl()}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    const stopped = await waitFor(async () => (await readHealth()) === null, 3000)
    if (!stopped) throw new Error(`The daemon from build ${health.buildId} did not stop (pid ${health.pid}).`)
  }
  spawnDaemon()
  // Another MCP server may have started one first; any daemon answering will do then, except the one just stopped:
  // it can still answer on a connection kept alive from before while it no longer takes new ones.
  const stoppedPid = health?.pid ?? null
  const started = await waitFor(async () => {
    const next = await readHealth()
    return next !== null && next.pid !== stoppedPid
  }, 5000)
  if (!started) throw new Error(`The daemon did not start. See ${daemonLogPath()}.`)
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export class DaemonConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly socket: WebSocket
  private readonly closeListeners = new Set<() => void>()

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data) => {
      const response = JSON.parse(data.toString()) as ShimResponse
      const waiter = this.pending.get(response.id)
      if (!waiter) return
      this.pending.delete(response.id)
      if ('error' in response) waiter.reject(new Error(response.error))
      else waiter.resolve(response.result)
    })
    socket.on('close', () => {
      for (const waiter of this.pending.values()) waiter.reject(new Error('The daemon connection closed.'))
      this.pending.clear()
      for (const listener of this.closeListeners) listener()
    })
  }

  static open(): Promise<DaemonConnection> {
    const token = fs.readFileSync(tokenPath(), 'utf8').trim()
    const socket = new WebSocket(`ws://127.0.0.1:${config.port}/shim?token=${token}`)
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(new DaemonConnection(socket)))
      socket.once('error', reject)
    })
  }

  /** Called once the socket closes: the daemon stopped, crashed or was replaced. */
  onClose(listener: () => void): void {
    this.closeListeners.add(listener)
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN
  }

  call<M extends keyof ShimMethods>(method: M, params: ShimMethods[M]['params']): Promise<ShimMethods[M]['result']> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The daemon did not answer ${method} in 10 s.`))
      }, 10_000)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value as ShimMethods[M]['result'])
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close(): void {
    this.socket.close()
  }
}
