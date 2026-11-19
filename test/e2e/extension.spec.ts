// Loads the real extension into Chromium, comments on a fixture page, sends, and checks
// the doorbell, the batch Claude would fetch, and the replies showing up on the page.
//
// DIB_E2E_HAND_OFF=<file> leaves the doorbell to someone else: the test writes the listen URL
// to <file>, opens no listener of its own, and waits for the batch to be answered by hand.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import WebSocket from 'ws'
import { PINNED_EXTENSION_ID, type Batch } from '../../src/shared/protocol.ts'

// The tests build on each other (test 2 answers batch 001 from test 1), so a failure skips the rest
// instead of running them in a fresh worker without that state.
test.describe.configure({ mode: 'serial' })

const repo = path.resolve(import.meta.dirname, '../..')
const extensionDir = path.join(repo, 'extension')
const handOff = process.env.DIB_E2E_HAND_OFF

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dib-e2e-'))
const home = path.join(tmp, 'home')
const project = path.join(tmp, 'project')
fs.mkdirSync(project)

let fixtureServer: http.Server
let fixtureUrl = ''
let daemonPort = 0
let shim: Client
let listener: WebSocket | null = null
const doorbells: string[] = []
let context: BrowserContext
let worker: Worker

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await shim.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean }
  const text = result.content.map((part) => part.text).join('\n')
  if (result.isError) throw new Error(`${name}: ${text}`)
  return text
}

test.beforeAll(async () => {
  const html = fs.readFileSync(path.join(import.meta.dirname, 'fixture/index.html'))
  fixtureServer = http.createServer((req, res) => {
    // /strict sends a CSP with no 'unsafe-inline', so the overlay must style itself without a <style> element.
    const csp = req.url === '/strict' ? { 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'" } : {}
    res.writeHead(200, { 'content-type': 'text/html', ...csp }).end(html)
  })
  const fixturePort = await freePort()
  await new Promise<void>((resolve) => fixtureServer.listen(fixturePort, '127.0.0.1', resolve))
  fixtureUrl = `http://localhost:${fixturePort}/pricing`

  daemonPort = await freePort()
  const env = { ...(process.env as Record<string, string>), DIB_PORT: String(daemonPort), DIB_HOME: home }
  shim = new Client({ name: 'e2e', version: '0' })
  await shim.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'plugin/dist/mcp.mjs')], env }))
  const connected = await callTool('live_connect', { projectRoot: project, origins: [new URL(fixtureUrl).origin] })
  const listenUrl = /ws:\/\/\S+\/listen\/\S+/.exec(connected)![0].replace(/,$/, '')

  if (handOff) {
    fs.writeFileSync(handOff, JSON.stringify({ listenUrl, daemonPort, home, project }) + '\n')
  } else {
    listener = new WebSocket(listenUrl)
    listener.on('message', (data) => doorbells.push(data.toString()))
    await new Promise((resolve) => listener!.once('open', resolve))
  }

  context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1100, height: 720 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  })
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  await worker.evaluate((port) => chrome.storage.local.set({ port }), daemonPort)
})

test.afterAll(async () => {
  await context?.close()
  listener?.terminate()
  await shim?.close()
  const token = fs.readFileSync(path.join(home, 'token'), 'utf8').trim()
  await fetch(`http://127.0.0.1:${daemonPort}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {})
  fixtureServer?.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function comment(page: Page, selector: string, text: string): Promise<void> {
  await page.locator(selector).first().click()
  const popover = page.locator('dib-overlay .popover')
  await expect(popover).toBeVisible()
  await popover.locator('textarea').fill(text)
  if (selector === 'h1') await page.screenshot({ path: path.join(repo, 'test-results/0-popover.png') })
  await popover.locator('textarea').press('Enter')
  await expect(popover).toBeHidden()
}

test('pick, comment, send, and see Claude reply on the page', async () => {
  const extensionId = new URL(worker.url()).host
  expect(extensionId).toBe(PINNED_EXTENSION_ID)

  const page = await context.newPage()
  await page.goto(fixtureUrl)
  await expect(page.locator('dib-overlay')).toBeAttached()
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${new URL(fixtureUrl).origin}/*`)
  expect(tabId).toBeTruthy()

  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`)
  // With a hand-off the outside listener may or may not have connected yet.
  await expect(panel.getByTestId('status')).toContainText(handOff ? 'Claude is' : 'Claude is listening')

  // Pick with the keyboard shortcut; clicks while picking must not reach the page.
  await page.bringToFront()
  await page.locator('h1').hover()
  await page.keyboard.press('Alt+Shift+C')
  await expect(page.locator('dib-overlay .banner')).toBeVisible()

  // With the popover open, a click elsewhere moves the empty popover and never reaches the page.
  await page.locator('h1').click()
  await expect(page.locator('dib-overlay .popover .target code')).toHaveText('h1')
  await page.locator('[data-testid="starter-cta"]').click()
  await expect(page.locator('dib-overlay .popover .target code')).toHaveText('button.cta')
  await expect(page.locator('#clicks')).toHaveText('0')
  await page.keyboard.press('Escape')
  await expect(page.locator('dib-overlay .popover')).toBeHidden()

  await comment(page, 'h1', 'Make the headline bolder and larger')
  await comment(page, '[data-testid="starter-cta"]', 'Use the accent color for the free plan button')
  await expect(page.locator('#clicks')).toHaveText('0')
  await page.keyboard.press('Escape')
  await expect(page.locator('dib-overlay .banner')).toBeHidden()

  const pins = page.locator('dib-overlay .pin-wrap:not([hidden])')
  await expect(pins.locator('.pin')).toHaveText(['1', '2'])
  await page.screenshot({ path: path.join(repo, 'test-results/1-commented.png') })

  // The page works normally again once the picker is off.
  await page.locator('[data-testid="starter-cta"]').click()
  await expect(page.locator('#clicks')).toHaveText('1')

  await panel.bringToFront()
  await expect(panel.getByTestId('draft').locator('li')).toHaveCount(2)
  await panel.getByTestId('send').click()
  await expect(panel.getByTestId('draft').locator('li')).toHaveCount(0)
  await expect(panel.getByTestId('sent')).toContainText('Batch 001')

  if (handOff) {
    // Someone else rings, fetches and replies: wait for the batch to be done.
    await expect(panel.getByTestId('sent')).toContainText('Done', { timeout: 150_000 })
  } else {
    await expect.poll(() => doorbells).toEqual(['design-in-browser: batch 001 ready, 2 comments. Call live_get_batch.'])
    const batch = JSON.parse(await callTool('live_get_batch')) as Batch
    expect(batch.comments.map((c) => [c.element?.tag, c.element?.selector, c.text])).toEqual([
      ['h1', 'h1', 'Make the headline bolder and larger'],
      ['button', 'button[data-testid="starter-cta"]', 'Use the accent color for the free plan button'],
    ])
    expect(batch.comments[1]!.element!.ancestors).toEqual(['article.plan', 'div.plans', 'main'])
    await expect(panel.getByTestId('sent')).toContainText('Claude is working')
    await callTool('live_reply', {
      batchId: batch.id,
      replies: [
        { commentId: batch.comments[0]!.id, status: 'done', message: 'Headline is now 40px, weight 800.' },
        { commentId: batch.comments[1]!.id, status: 'question', message: 'Accent purple or the green from the logo?' },
      ],
    })
    await expect(panel.getByTestId('sent')).toContainText('Done')
    await expect(panel.getByTestId('sent')).toContainText('Claude: Headline is now 40px, weight 800.')
  }
  await panel.screenshot({ path: path.join(repo, 'test-results/2-panel.png') })

  await page.bringToFront()
  const statuses = () => pins.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.status))
  if (!handOff) await expect.poll(statuses).toEqual(['done', 'question'])
  await page.locator('dib-overlay .pin').first().hover()
  await page.screenshot({ path: path.join(repo, 'test-results/3-replied.png') })
})

test('answer Claude\'s questions from the panel and from a pin', async () => {
  test.skip(Boolean(handOff), 'needs its own listener')
  const extensionId = new URL(worker.url()).host
  const page = context.pages().find((entry) => entry.url().startsWith(fixtureUrl))!
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, fixtureUrl)
  const panel = await context.newPage()
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`)

  // From the panel: answer the question on batch 001.
  await panel.getByTestId('answer').click()
  const composer = panel.locator('textarea[data-composer]')
  await expect(composer).toBeFocused()
  await composer.fill('Accent purple')
  await composer.press('Enter')
  await expect(panel.getByTestId('draft-item')).toHaveCount(1)
  await expect(panel.getByTestId('draft-item')).toContainText('Claude asked: Accent purple or the green from the logo?')
  await expect(panel.getByTestId('sent')).toContainText('Your answer is in Comments, ready to send.')
  await panel.getByTestId('send').click()
  await expect.poll(() => doorbells.at(-1)).toBe('design-in-browser: batch 002 ready, 1 comment. Call live_get_batch.')
  const second = JSON.parse(await callTool('live_get_batch')) as Batch
  const original = (JSON.parse(await callTool('live_get_batch', { batchId: '001' })) as Batch).comments[1]!
  expect(second.comments[0]!.inReplyTo).toEqual({
    batchId: '001',
    commentId: original.id,
    comment: 'Use the accent color for the free plan button',
    question: 'Accent purple or the green from the logo?',
  })
  expect(second.comments[0]!.element?.selector).toBe('button[data-testid="starter-cta"]')
  await expect(panel.getByTestId('sent')).toContainText('Answered in batch 002.')

  // From a pin: Claude asks again, the user answers in the page.
  await callTool('live_reply', { batchId: '002', replies: [{ commentId: second.comments[0]!.id, status: 'question', message: 'Which shade, 500 or 600?' }] })
  await page.bringToFront()
  const asking = page.locator('dib-overlay .pin-wrap[data-status="question"]')
  await expect(asking).toHaveCount(1)
  await asking.locator('.pin').click()
  await asking.getByRole('button', { name: 'Answer', exact: true }).click()
  const popover = page.locator('dib-overlay .popover')
  await expect(popover.locator('.asked-text')).toHaveText('Which shade, 500 or 600?')
  await popover.locator('textarea').fill('600')
  await popover.locator('textarea').press('Enter')
  await expect(popover).toBeHidden()
  await panel.bringToFront()
  await expect(panel.getByTestId('draft-item')).toContainText('Claude asked: Which shade, 500 or 600?')
  await panel.getByTestId('draft-item').getByRole('button', { name: 'Remove comment 1' }).click()
  await expect(panel.getByTestId('draft-item')).toHaveCount(0)

  // Claude closes the first question once it acts on the answer: the pin and the panel follow.
  await expect(page.locator('dib-overlay .pin-wrap[data-status="answered"]')).toHaveCount(1)
  await callTool('live_reply', { batchId: '001', replies: [{ commentId: original.id, status: 'done', message: 'The free plan button is accent purple now.' }] })
  await expect(page.locator('dib-overlay .pin-wrap[data-status="answered"]')).toHaveCount(0)
  await expect(panel.getByTestId('sent')).not.toContainText('Answered in batch 002.')
  await expect(panel.getByTestId('sent')).toContainText('Claude: The free plan button is accent purple now.')
  await panel.close()
})

test('the overlay works on a page whose CSP forbids inline styles', async () => {
  const page = await context.newPage()
  const errors: string[] = []
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()))
  await page.goto(new URL('/strict', fixtureUrl).href)
  await expect(page.locator('dib-overlay')).toBeAttached()
  // Proof the CSP is enforced: the fixture's own inline <style> is blocked.
  await expect(page.locator('.plan').first()).toHaveCSS('border-radius', '0px')
  await page.locator('h1').hover()
  await page.keyboard.press('Alt+Shift+C')
  const banner = page.locator('dib-overlay .banner')
  await expect(banner).toBeVisible()
  // --ink, from the overlay's own sheet
  await expect(banner).toHaveCSS('background-color', 'rgb(28, 25, 23)')
  await page.locator('h1').click()
  await expect(page.locator('dib-overlay .popover')).toHaveCSS('border-radius', '12px')
  // Pins and their cards render under the same CSP; Remove on a draft pin's card deletes it.
  await page.locator('dib-overlay .popover textarea').fill('Under a strict CSP')
  await page.locator('dib-overlay .popover textarea').press('Enter')
  await page.keyboard.press('Escape')
  const pin = page.locator('dib-overlay .pin-wrap:not([hidden])')
  await expect(pin.locator('.pin')).toHaveCSS('border-bottom-right-radius', '3px')
  await pin.locator('.pin').click()
  await expect(pin.locator('.card')).toBeVisible()
  await pin.getByRole('button', { name: 'Remove' }).click()
  await expect(pin).toHaveCount(0)
  expect(errors.filter((text) => text.includes('dib') || text.includes('chrome-extension'))).toEqual([])
  await page.close()
})

test('the session picked in the panel keeps getting the comments', async () => {
  test.skip(Boolean(handOff), 'needs its own listener')
  const project2 = path.join(tmp, 'project2')
  fs.mkdirSync(project2)
  const env = { ...(process.env as Record<string, string>), DIB_PORT: String(daemonPort), DIB_HOME: home }
  const second = new Client({ name: 'e2e-second', version: '0' })
  await second.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'plugin/dist/mcp.mjs')], env }))
  try {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await second.callTool({ name, arguments: args })) as { content: Array<{ text: string }> }
      return result.content.map((part) => part.text).join('\n')
    }
    // Both sessions claim the fixture's origin.
    await call('live_connect', { projectRoot: project2, origins: [new URL(fixtureUrl).origin] })
    const secondId = (JSON.parse(await call('live_status')) as { sessionId: string }).sessionId

    const page = context.pages().find((entry) => entry.url().startsWith(fixtureUrl))!
    const extensionId = new URL(worker.url()).host
    const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, fixtureUrl)
    const panel = await context.newPage()
    await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`)
    await expect(panel.getByTestId('session').locator('option')).toHaveCount(2)
    await panel.getByTestId('session').selectOption(secondId)
    // The panel re-renders every 1.5 s; the choice must survive that.
    await panel.waitForTimeout(2000)
    await expect(panel.getByTestId('session')).toHaveValue(secondId)

    await page.bringToFront()
    await page.keyboard.press('Alt+Shift+C')
    await comment(page, '.lede', 'Shorter subtitle')
    await page.keyboard.press('Escape')
    await panel.bringToFront()
    await panel.getByTestId('send').click()
    await expect(panel.getByTestId('draft').locator('li')).toHaveCount(0)

    const batch = JSON.parse(await call('live_get_batch')) as Batch
    expect([batch.projectRoot, batch.comments[0]!.text]).toEqual([project2, 'Shorter subtitle'])
    expect(await callTool('live_get_batch')).toBe('No unfetched batch.')
    await panel.close()
  } finally {
    await second.close()
  }
})

test('a comment survives a save that fails after the extension was reloaded', async () => {
  test.skip(Boolean(handOff), 'reloads the extension')
  const page = context.pages().find((entry) => entry.url().startsWith(fixtureUrl))!
  await page.bringToFront()
  // Reloading the extension leaves this tab with the old overlay and no extension context behind it.
  await Promise.race([worker.evaluate(() => chrome.runtime.reload()).catch(() => {}), page.waitForTimeout(1000)])
  await page.waitForTimeout(500)
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('.lede').click()
  const popover = page.locator('dib-overlay .popover')
  await popover.locator('textarea').fill('Text I typed before noticing')
  await popover.locator('textarea').press('Enter')
  await expect(popover).toBeVisible()
  await expect(popover.locator('textarea')).toHaveValue('Text I typed before noticing')
  await expect(popover.locator('.popover-error')).toContainText('reload the tab')
})
