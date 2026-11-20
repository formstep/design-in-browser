// The bridge as an agent and a dev server see it: the built MCP server over stdio, the daemon it starts on a spare
// port with its own home folder, a stand-in for the Vite plugin's socket, and a listener standing in for the
// agent's Monitor. A test file calls useBridge() once.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import WebSocket from 'ws'
import type { DaemonToPlugin, DraftComment, Health } from '../src/shared/protocol.ts'

export const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dib-test-'))
export const home = path.join(tmp, 'home')
export const project = path.join(tmp, 'project')
fs.mkdirSync(project)
export let port = 0
export let env: Record<string, string> = {}
const shims: Client[] = []
const sockets: WebSocket[] = []

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const address = server.address() as net.AddressInfo
      server.close(() => resolve(address.port))
    })
  })
}

/** Starts an MCP server as an agent named `name` would; `mcp` picks another build of it. */
export async function startShim(name = 'bridge-test', mcp = 'plugin/dist/mcp.mjs'): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcp], env, stderr: 'pipe' })
  const client = new Client({ name, version: '0' })
  await client.connect(transport)
  shims.push(client)
  return client
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
  const text = result.content.map((part) => part.text).join('\n')
  assert.ok(!result.isError, `${name} failed: ${text}`)
  return text
}

/** The running daemon's /health, or null when none answers. */
export async function health(): Promise<Health | null> {
  try {
    return (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Health
  } catch {
    return null
  }
}

/** Kills the daemon the hard way, as a crash would, and waits until its port is free. */
export async function killDaemon(): Promise<void> {
  const running = await health()
  assert.ok(running, 'no daemon to kill')
  process.kill(running.pid, 'SIGKILL')
  for (let i = 0; i < 50 && (await health()); i++) await new Promise((resolve) => setTimeout(resolve, 100))
}

export type Inbox<T> = { items: T[]; next: (match: (item: T) => boolean, timeoutMs?: number) => Promise<T> }

function inbox<T>(socket: WebSocket, parse: (raw: string) => T): Inbox<T> {
  const items: T[] = []
  const waiters: Array<{ match: (item: T) => boolean; resolve: (item: T) => void }> = []
  let seen = 0
  socket.on('message', (data) => {
    const item = parse(data.toString())
    items.push(item)
    for (const waiter of waiters.filter((entry) => entry.match(item))) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(item)
    }
  })
  return {
    items,
    next(match, timeoutMs = 3000) {
      // Look at messages that arrived since the last match first.
      const index = items.findIndex((item, i) => i >= seen && match(item))
      if (index !== -1) {
        seen = index + 1
        return Promise.resolve(items[index]!)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${match.toString()}; got ${JSON.stringify(items).slice(0, 600)}`)),
          timeoutMs
        )
        waiters.push({ match, resolve: (item) => (clearTimeout(timer), (seen = items.length), resolve(item)) })
      })
    },
  }
}

/** The inbox is attached before the handshake: a frame can arrive in the same packet as the 101 response. */
export function open<T>(url: string, parse: (raw: string) => T, origin?: string): Promise<{ socket: WebSocket; inbox: Inbox<T> }> {
  const socket = new WebSocket(url, origin ? { origin } : {})
  sockets.push(socket)
  const box = inbox(socket, parse)
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve({ socket, inbox: box }))
    socket.once('error', reject)
    socket.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
  })
}

export const openDevServer = () =>
  open<DaemonToPlugin>(`ws://127.0.0.1:${port}/page?token=${fs.readFileSync(path.join(home, 'token'), 'utf8').trim()}`, (raw) =>
    JSON.parse(raw)
  )

export const openListener = (url: string) => open<string>(url, (raw) => raw)

export function comment(text: string, selector = 'main > h1'): DraftComment {
  return {
    id: crypto.randomUUID(),
    text,
    page: { url: 'http://localhost:5173/pricing', title: 'Pricing', viewport: { width: 1280, height: 800 } },
    element: {
      selector,
      tag: 'h1',
      id: null,
      classes: ['title'],
      text: 'Simple pricing',
      html: '<h1 class="title">Simple pricing</h1>',
      rect: { x: 0, y: 0, width: 400, height: 40 },
      styles: { 'font-size': '32px' },
      ancestors: ['main'],
      sources: ['src/Pricing.tsx:12:7'],
    },
    inReplyTo: null,
    createdAt: new Date().toISOString(),
  }
}

export const listenUrlFrom = (text: string) => {
  const match = /ws:\/\/\S+\/listen\/\S+/.exec(text)
  assert.ok(match, `no listen url in: ${text}`)
  return match[0].replace(/,$/, '')
}

export function useBridge(): void {
  before(async () => {
    port = await freePort()
    env = { ...(process.env as Record<string, string>), DIB_PORT: String(port), DIB_HOME: home }
  })

  after(async () => {
    for (const socket of sockets) socket.terminate()
    for (const client of shims) await client.close().catch(() => {})
    const token = fs.existsSync(path.join(home, 'token')) ? fs.readFileSync(path.join(home, 'token'), 'utf8').trim() : ''
    await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {})
    fs.rmSync(tmp, { recursive: true, force: true })
  })
}
