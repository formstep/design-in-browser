// The end-to-end harness: a React fixture app served by Vite with the built plugin, a real daemon and MCP
// server, and a listener standing in for the agent's Monitor. Each spec file calls useHarness() once and gets
// its own daemon, dev server and browser, on spare ports, with nothing written to ~/.design-in-browser.
// The bindings below are filled in by the beforeAll that useHarness() registers.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer, type ViteDevServer } from 'vite'
import WebSocket from 'ws'

export const repo = path.resolve(import.meta.dirname, '../..')
export const appRoot = path.join(repo, 'test/e2e/app')

export let tmp = ''
export let home = ''
export let project = ''
export let appUrl = ''
export let vite: ViteDevServer
/** The agent's MCP client, named like Claude Code's. */
export let shim: Client
export let context: BrowserContext
export let page: Page
/** Every doorbell the agent's Monitor received, oldest first. */
export const doorbells: string[] = []

let daemonPort = 0
let appPort = 0
let listener: WebSocket
let browser: Browser

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

/** Serves the fixture app; by default on the harness's own port, as `vite`. */
export async function startVite(host = 'localhost', port = appPort): Promise<ViteDevServer> {
  const server = await createServer({ root: appRoot, configFile: path.join(appRoot, 'vite.config.ts'), cacheDir: viteCache(port), server: { host, port, strictPort: true } })
  await server.listen()
  return server
}

/** A dep cache per dev server: servers sharing one re-optimize under each other and answer 504. */
export const viteCache = (port: number) => path.join(tmp, `vite-cache-${port}`)

export async function stopAppServer(): Promise<void> {
  await vite.close()
}

export async function startAppServer(): Promise<void> {
  vite = await startVite()
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
  const text = result.content.map((part) => part.text).join('\n')
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

/** Starts the built MCP server as an agent named `name` would, connected to `projectRoot`. */
export async function startShim(name: string, projectRoot: string): Promise<Client> {
  const client = new Client({ name, version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'plugin/dist/mcp.mjs')], env: process.env as Record<string, string> }))
  await callTool(client, 'live_connect', { projectRoot })
  return client
}

export const dock = (target: Page = page) => target.locator('dib-dock .dock')

/** Clicks an element while picking, types a comment and adds it to the stack. */
export async function comment(selector: string, text: string): Promise<void> {
  await page.locator(selector).first().click()
  const composer = page.locator('dib-overlay .composer')
  await expect(composer).toBeVisible()
  await composer.locator('textarea').fill(text)
  await composer.locator('textarea').press('Enter')
  await expect(composer).toBeHidden()
}

export function useHarness(): void {
  // The tests in a file build on each other, so a failure skips the rest instead of running them without that state.
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dib-e2e-'))
    home = path.join(tmp, 'home')
    project = path.join(tmp, 'project')
    fs.mkdirSync(project)
    daemonPort = await freePort()
    appPort = await freePort()
    appUrl = `http://localhost:${appPort}/`
    // The plugin runs in this process (Vite loads it here), so it reads these too.
    process.env.DIB_PORT = String(daemonPort)
    process.env.DIB_HOME = home
    process.env.DIB_PROJECT_ROOT = project

    shim = new Client({ name: 'claude-code', version: '0' })
    await shim.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'plugin/dist/mcp.mjs')], env: process.env as Record<string, string> }))
    const connected = await callTool(shim, 'live_connect', { projectRoot: project })
    const listenUrl = /ws:\/\/\S+\/listen\/\S+/.exec(connected)![0].replace(/,$/, '')
    listener = new WebSocket(listenUrl)
    listener.on('message', (data) => doorbells.push(data.toString()))
    await new Promise((resolve) => listener.once('open', resolve))

    vite = await startVite()
    browser = await chromium.launch()
    context = await browser.newContext({ viewport: { width: 1100, height: 720 } })
    page = await context.newPage()
  })

  test.afterAll(async () => {
    await browser?.close()
    await vite?.close()
    listener?.terminate()
    await shim?.close()
    const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim()
    await fetch(`http://127.0.0.1:${daemonPort}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {})
    fs.rmSync(tmp, { recursive: true, force: true })
    doorbells.length = 0
  })
}
