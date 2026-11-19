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

/** Make sure a daemon from this build is listening. A daemon from another build is asked to stop first. */
export async function ensureDaemon(): Promise<void> {
  const health = await readHealth()
  if (health && health.name !== PRODUCT_NAME) {
    throw new Error(`Port ${config.port} is used by something else. Set DIB_PORT to another port.`)
  }
  if (health && health.buildId === BUILD_ID) return
  if (health) {
    const token = fs.readFileSync(tokenPath(), 'utf8').trim()
    await fetch(`${baseUrl()}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    const stopped = await waitFor(async () => (await readHealth()) === null, 3000)
    if (!stopped) throw new Error(`The daemon from build ${health.buildId} did not stop (pid ${health.pid}).`)
  }
  spawnDaemon()
  const started = await waitFor(async () => (await readHealth())?.buildId === BUILD_ID, 5000)
  if (!started) throw new Error(`The daemon did not start. See ${daemonLogPath()}.`)
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void }

export class DaemonConnection {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly socket: WebSocket

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
