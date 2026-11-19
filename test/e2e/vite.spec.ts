// The Vite plugin end to end: a React fixture app served by Vite with the built plugin, a real daemon and
// MCP server, and a listener standing in for the agent's Monitor. Same assertions as the extension suite.
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { chromium, expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createServer, type ViteDevServer } from 'vite'
import WebSocket from 'ws'
import designInBrowser from '../../dist/vite.mjs'
import type { Batch } from '../../src/shared/protocol.ts'

// The tests build on each other, so a failure skips the rest instead of running them without that state.
test.describe.configure({ mode: 'serial' })

const repo = path.resolve(import.meta.dirname, '../..')
const appRoot = path.join(repo, 'test/e2e/app')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dib-vite-e2e-'))
const home = path.join(tmp, 'home')
const project = path.join(tmp, 'project')
fs.mkdirSync(project)

let daemonPort = 0
let appPort = 0
let appUrl = ''
let vite: ViteDevServer
let shim: Client
let listener: WebSocket
const doorbells: string[] = []
let browser: Browser
let context: BrowserContext
let page: Page

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

const startVite = async (host = 'localhost', port = appPort) => {
  const server = await createServer({ root: appRoot, configFile: path.join(appRoot, 'vite.config.ts'), server: { host, port, strictPort: true } })
  await server.listen()
  return server
}

async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
  const text = result.content.map((part) => part.text).join('\n')
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

async function startShim(name: string, projectRoot: string): Promise<Client> {
  const client = new Client({ name, version: '0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'plugin/dist/mcp.mjs')], env: process.env as Record<string, string> }))
  await callTool(client, 'live_connect', { projectRoot })
  return client
}

const dock = (target: Page = page) => target.locator('dib-dock .dock')

test.beforeAll(async () => {
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
})

async function comment(selector: string, text: string): Promise<void> {
  await page.locator(selector).first().click()
  const composer = page.locator('dib-overlay .composer')
  await expect(composer).toBeVisible()
  await composer.locator('textarea').fill(text)
  await composer.locator('textarea').press('Enter')
  await expect(composer).toBeHidden()
}

test('pick, comment, send, and see the reply on the page', async () => {
  await page.goto(appUrl)
  await expect(page.locator('dib-overlay')).toBeAttached()
  await page.locator('dib-dock .launcher').click()
  await expect(dock().getByTestId('status')).toContainText('Claude is listening')

  // Clicks while picking or commenting never reach the app.
  await page.locator('h1').hover()
  await page.keyboard.press('Alt+Shift+C')
  await expect(page.locator('dib-overlay .tools')).toBeVisible()
  await page.locator('h1').click()
  await expect(page.locator('dib-overlay .composer .target')).toContainText('h1 · “Simple pricing”')
  await page.locator('[data-testid="starter-cta"]').click()
  await expect(page.locator('dib-overlay .composer .target')).toContainText('button.cta')
  await expect(page.locator('#clicks')).toHaveText('0')
  await page.keyboard.press('Escape')

  await comment('h1', 'Make the headline bolder and larger')
  await comment('[data-testid="starter-cta"]', 'Use the accent color for the free plan button')
  await page.keyboard.press('Escape')
  await expect(page.locator('dib-overlay .tools')).toBeHidden()
  const pins = page.locator('dib-overlay .pins .pin-wrap:not([hidden])')
  await expect(pins.locator('.pin')).toHaveText(['1', '2'])
  await page.locator('[data-testid="starter-cta"]').click()
  await expect(page.locator('#clicks')).toHaveText('1')

  await expect(dock().getByTestId('draft-item')).toHaveCount(2)
  await dock().getByTestId('send').click()
  await expect(dock().getByTestId('draft-item')).toHaveCount(0)
  await expect.poll(() => doorbells.at(-1)).toBe('design-in-browser: batch 001 ready, 2 comments. Call live_get_batch.')

  const batch = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  expect(batch.comments.map((c) => [c.element?.selector, c.text])).toEqual([
    ['h1', 'Make the headline bolder and larger'],
    ['button[data-testid="starter-cta"]', 'Use the accent color for the free plan button'],
  ])
  expect(batch.comments[1]!.element!.ancestors).toEqual(['article.plan', 'div.plans', 'main', 'div#root'])
  await expect(dock().getByTestId('sent')).toContainText('Working on it')
  await callTool(shim, 'live_reply', {
    batchId: batch.id,
    replies: [
      { commentId: batch.comments[0]!.id, status: 'done', message: 'Headline is now 40px, weight 800.' },
      { commentId: batch.comments[1]!.id, status: 'question', message: 'Accent purple or the green from the logo?' },
    ],
  })
  await expect(dock().getByTestId('sent')).toContainText('Headline is now 40px, weight 800.')
  await expect.poll(() => pins.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.status))).toEqual(['done', 'question'])
})

test('answer a question from the dock and from a pin', async () => {
  const field = dock().getByTestId('answer-field')
  await field.fill('Accent')
  await dock().getByTestId('message').fill('A note in progress')
  await page.waitForTimeout(2000)
  await expect(field).toHaveValue('Accent')
  await expect(dock().getByTestId('message')).toHaveValue('A note in progress')
  await dock().getByTestId('message').fill('')
  await field.fill('Accent purple')
  await field.press('Enter')
  await expect(dock().getByTestId('draft-item')).toContainText('Claude asked: Accent purple or the green from the logo?')
  await dock().getByTestId('send').click()
  await expect.poll(() => doorbells.at(-1)).toBe('design-in-browser: batch 002 ready, 1 comment. Call live_get_batch.')
  const second = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  expect(second.comments[0]!.inReplyTo?.batchId).toBe('001')

  await callTool(shim, 'live_reply', { batchId: '002', replies: [{ commentId: second.comments[0]!.id, status: 'question', message: 'Which shade, 500 or 600?' }] })
  const asking = page.locator('dib-overlay .pin-wrap[data-status="question"]')
  await asking.locator('.pin').click()
  await expect(asking.locator('.thread')).toContainText('Which shade, 500 or 600?')
  // On a short window the card still opens fully on screen.
  await page.setViewportSize({ width: 1100, height: 420 })
  await page.waitForTimeout(1000)
  const box = (await asking.locator('.thread').boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(8)
  expect(box.y + box.height).toBeLessThanOrEqual(420 - 8)
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.waitForTimeout(1000)
  await asking.getByRole('textbox', { name: 'Answer Claude' }).fill('600')
  await asking.getByRole('textbox', { name: 'Answer Claude' }).press('Enter')
  await expect(dock().getByTestId('draft-item')).toContainText('Claude asked: Which shade, 500 or 600?')
  await dock().getByTestId('draft-item').getByRole('button', { name: 'Remove comment 1' }).click()
  await expect(dock().getByTestId('draft-item')).toHaveCount(0)

  // The agent closes the first question once it acts on the answer: the pin and the dock follow.
  const first = (JSON.parse(await callTool(shim, 'live_get_batch', { batchId: '001' })) as Batch).comments[1]!
  await expect(page.locator('dib-overlay .pin-wrap[data-status="answered"]')).toHaveCount(1)
  await callTool(shim, 'live_reply', { batchId: '001', replies: [{ commentId: first.id, status: 'done', message: 'The free plan button is accent purple now.' }] })
  await expect(page.locator('dib-overlay .pin-wrap[data-status="answered"]')).toHaveCount(0)
  await expect(dock().getByTestId('sent')).toContainText('The free plan button is accent purple now.')
})

test('the Ask bar, Send to the agent, and a dock message all reach the agent', async () => {
  // "Ask Claude" in the tool pill adds a note about the whole page to the stack.
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('dib-overlay .tool.ask').click()
  await page.locator('dib-overlay .askbar input').fill('Less crowded overall')
  await page.locator('dib-overlay .askbar input').press('Enter')
  await expect(page.locator('dib-overlay .askbar')).toBeHidden()

  // Ticking "Send to Claude" sends the whole stack with the new comment.
  const before = doorbells.length
  await page.locator('.lede').click()
  const composer = page.locator('dib-overlay .composer')
  await expect(composer.locator('.check')).toHaveText('Send to Claude')
  await composer.locator('.send-on-add').check()
  await composer.locator('textarea').fill('Shorter subtitle')
  await composer.locator('textarea').press('Enter')
  await page.keyboard.press('Escape')
  await expect.poll(() => doorbells.length).toBe(before + 1)
  expect(doorbells.at(-1)).toMatch(/ready, 2 comments/)
  const stacked = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  expect(stacked.comments.map((c) => [c.element?.tag ?? null, c.text])).toEqual([
    [null, 'Less crowded overall'],
    ['p', 'Shorter subtitle'],
  ])
  // The tick box stays as left; untick it for the tests after this one.
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('.lede').click()
  await expect(composer.locator('.send-on-add')).toBeChecked()
  await composer.locator('.send-on-add').uncheck()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  // A message typed in the dock with nothing stacked goes alone, as a page note, on Enter.
  await expect(dock().getByTestId('draft-item')).toHaveCount(0)
  await dock().getByTestId('message').fill('Just a note')
  await dock().getByTestId('message').press('Enter')
  await expect.poll(() => doorbells.length).toBe(before + 2)
  const note = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  expect(note.comments.map((c) => [c.element, c.text])).toEqual([[null, 'Just a note']])
  await expect(dock().getByTestId('message')).toHaveValue('')
})

test('the stack survives a reload and a dev-server restart, and every tab shares it', async () => {
  await page.keyboard.press('Alt+Shift+C')
  await comment('.lede', 'Shorter subtitle')
  await page.keyboard.press('Escape')
  await expect(dock().getByTestId('draft-item')).toHaveCount(1)

  const other = await context.newPage()
  await other.goto(appUrl)
  await expect(dock(other).getByTestId('draft-item')).toHaveCount(1)

  await page.reload()
  await expect(dock().getByTestId('draft-item')).toHaveCount(1)

  // Vite reloads open pages when its server comes back.
  await vite.close()
  vite = await startVite()
  await page.waitForTimeout(1500)
  await page.goto(appUrl)
  await expect(dock().getByTestId('draft-item').locator('textarea')).toHaveValue('Shorter subtitle')
  await expect(page.locator('dib-overlay .pins .pin-wrap[data-status="draft"]:not([hidden]) .pin')).toHaveText('1')
  await dock().getByTestId('draft-item').getByRole('button', { name: 'Remove comment 1' }).click()
  await expect(dock(other).getByTestId('draft-item')).toHaveCount(0)
  await other.close()
})

test('the dock picks the session working on this project and keeps a manual pick', async () => {
  const elsewhere = path.join(tmp, 'elsewhere')
  fs.mkdirSync(elsewhere)
  const second = await startShim('opencode', elsewhere)
  try {
    const select = dock().getByTestId('session')
    await expect(select.locator('option')).toHaveCount(2)
    // The session on this project is chosen; the other is only an option.
    await expect(dock().locator('.picker-text')).toHaveText('project · Claude')
    const secondId = (JSON.parse(await callTool(second, 'live_status')) as { sessionId: string }).sessionId
    await select.selectOption(secondId)
    await page.waitForTimeout(2000)
    await expect(dock().locator('.picker-text')).toHaveText('elsewhere · OpenCode')
    await dock().getByTestId('message').fill('For the other agent')
    await dock().getByTestId('message').press('Enter')
    await expect.poll(async () => JSON.parse((await callTool(second, 'live_status'))).unfetched.length).toBe(1)
    expect(await callTool(shim, 'live_get_batch')).toBe('No unfetched batch.')
  } finally {
    await second.close()
  }
  // With the picked session gone, the dock falls back to the session on this project.
  await expect(dock().locator('.project')).toHaveText('project')
})

test('the overlay works on a page whose CSP forbids inline styles', async () => {
  const strict = await context.newPage()
  const errors: string[] = []
  strict.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  await strict.goto(new URL('/strict.html', appUrl).href)
  await expect(strict.locator('dib-overlay')).toBeAttached()
  // Proof the CSP is enforced: the page's own inline style is blocked.
  await expect(strict.locator('.plan')).toHaveCSS('border-radius', '0px')
  await strict.keyboard.press('Alt+Shift+C')
  await expect(strict.locator('dib-overlay .tools')).toHaveCSS('background-color', 'rgb(31, 31, 31)')
  await strict.locator('h1').click()
  await expect(strict.locator('dib-overlay .composer')).toHaveCSS('border-radius', '16px')
  await strict.locator('dib-overlay .composer textarea').fill('Under a strict CSP')
  await strict.locator('dib-overlay .composer textarea').press('Enter')
  await strict.keyboard.press('Escape')
  const pin = strict.locator('dib-overlay .pins .pin-wrap[data-status="draft"]:not([hidden])')
  await expect(pin.locator('.pin')).toHaveCSS('border-bottom-left-radius', '0px')
  await pin.locator('.pin').click()
  await expect(pin.locator('.thread')).toBeVisible()
  await pin.getByRole('button', { name: 'Remove comment' }).click()
  await expect(pin).toHaveCount(0)
  expect(errors.filter((text) => /design-in-browser|dib-/.test(text))).toEqual([])
  await strict.close()
})

test('a dev server that listens beyond localhost leaves the page alone', async () => {
  const exposed = await startVite('0.0.0.0', await freePort())
  try {
    const port = (exposed.httpServer!.address() as net.AddressInfo).port
    const other = await context.newPage()
    await other.goto(`http://localhost:${port}/`)
    await expect(other.locator('h1')).toBeVisible()
    await other.waitForTimeout(500)
    await expect(other.locator('dib-overlay')).toHaveCount(0)
    await other.close()
  } finally {
    await exposed.close()
  }
})

test('two apps in one project keep their own stacks', async () => {
  const twoPort = await freePort()
  const two = await createServer({
    root: path.join(repo, 'test/e2e/app-two'),
    configFile: false,
    logLevel: 'error',
    plugins: [designInBrowser({ projectRoot: project })],
    server: { port: twoPort, strictPort: true },
  })
  await two.listen()
  try {
    const other = await context.newPage()
    await other.goto(`http://localhost:${twoPort}/`)
    await other.locator('dib-dock .launcher').click()
    await other.keyboard.press('Alt+Shift+C')
    await other.locator('.note').click()
    await other.locator('dib-overlay .composer textarea').fill('Only in the second app')
    await other.locator('dib-overlay .composer textarea').press('Enter')
    await expect(dock(other).getByTestId('draft-item')).toHaveCount(1)
    await expect(dock().getByTestId('draft-item')).toHaveCount(0)
    expect(fs.readdirSync(path.join(project, '.design-in-browser')).filter((name) => name.startsWith('page-state.')).length).toBe(2)
    await other.close()
  } finally {
    await two.close()
  }
})

test('with HMR off the page is left alone', async () => {
  const offPort = await freePort()
  const off = await createServer({
    root: path.join(repo, 'test/e2e/app-two'),
    configFile: false,
    logLevel: 'error',
    plugins: [designInBrowser({ projectRoot: project })],
    server: { port: offPort, strictPort: true, hmr: false },
  })
  await off.listen()
  try {
    const other = await context.newPage()
    const errors: string[] = []
    other.on('pageerror', (error) => errors.push(error.message))
    await other.goto(`http://localhost:${offPort}/`)
    await expect(other.locator('h1')).toBeVisible()
    await other.waitForTimeout(500)
    await expect(other.locator('dib-overlay')).toHaveCount(0)
    expect(errors).toEqual([])
    await other.close()
  } finally {
    await off.close()
  }
})

test('a comment survives a save that fails while the dev server is down', async () => {
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('.lede').click()
  await vite.close()
  const composer = page.locator('dib-overlay .composer')
  await composer.locator('textarea').fill('Text I typed before noticing')
  await composer.locator('textarea').press('Enter')
  await expect(composer).toBeVisible({ timeout: 8000 })
  await expect(composer.locator('textarea')).toHaveValue('Text I typed before noticing')
  await expect(composer.locator('.composer-error')).toContainText('Couldn’t save')
  vite = await startVite()
})
