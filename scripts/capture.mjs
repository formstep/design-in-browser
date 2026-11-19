// Screenshots every side panel and overlay state for design review. The UI is dark only, like Claude Design.
// Runs a real daemon and MCP server on a spare port; nothing touches ~/.design-in-browser.
// Usage: pnpm build && node scripts/capture.mjs [outDir]
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from 'playwright'
import WebSocket from 'ws'

const repo = path.resolve(import.meta.dirname, '..')
const outDir = path.resolve(process.argv[2] ?? path.join(repo, 'test-results/capture'))
fs.mkdirSync(outDir, { recursive: true })

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

const html = fs.readFileSync(path.join(repo, 'test/e2e/fixture/index.html'), 'utf8')
const darkPage = html.replace('</style>', 'body{background:#101014;color:#eee}.plan{background:#1b1b22;border-color:#333}</style>')

async function run(colorScheme) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dib-capture-'))
  const project = path.join(tmp, 'acme-web')
  fs.mkdirSync(project)
  const fixture = http.createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(req.url === '/dark' ? darkPage : html))
  const fixturePort = await freePort()
  await new Promise((resolve) => fixture.listen(fixturePort, '127.0.0.1', resolve))
  const origin = `http://localhost:${fixturePort}`
  const daemonPort = await freePort()
  const env = { ...process.env, DIB_PORT: String(daemonPort), DIB_HOME: path.join(tmp, 'home') }

  const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    colorScheme,
    viewport: { width: 1100, height: 720 },
    args: [`--disable-extensions-except=${path.join(repo, 'extension')}`, `--load-extension=${path.join(repo, 'extension')}`],
  })
  // Fail fast instead of hanging when a step can't find what it expects.
  context.setDefaultTimeout(15_000)
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const extensionId = new URL(worker.url()).host
  const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${colorScheme}-${name}.png`) })

  const page = await context.newPage()
  await page.goto(`${origin}/pricing`)
  await page.locator('dib-overlay').waitFor({ state: 'attached' })
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${origin}/*`)
  const panel = await context.newPage()
  await panel.setViewportSize({ width: 360, height: 760 })
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`)
  const panelShot = async (name) => {
    if (process.env.CAPTURE_VERBOSE) console.log(new Date().toISOString().slice(11, 19), name)
    await panel.bringToFront()
    await panel.waitForTimeout(400)
    await panel.screenshot({ path: path.join(outDir, `${colorScheme}-panel-${name}.png`) })
  }

  await panelShot('1-offline')
  await worker.evaluate((port) => chrome.storage.local.set({ port }), daemonPort)
  await panel.waitForTimeout(800)
  await panelShot('2-no-session')

  const shim = new Client({ name: 'claude-code', version: '0' })
  await shim.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'plugin/dist/mcp.mjs')], env }))
  const call = async (name, args = {}) => {
    const result = await shim.callTool({ name, arguments: args }, undefined, { timeout: 15_000 })
    return result.content.map((part) => part.text).join('\n')
  }
  const connected = await call('live_connect', { projectRoot: project, origins: [origin] })
  const listenUrl = /ws:\/\/\S+\/listen\/\S+/.exec(connected)[0].replace(/,$/, '')
  await panel.getByTestId('status').filter({ hasText: 'Not listening' }).waitFor()
  await panelShot('3-not-listening')
  const other = new Client({ name: 'opencode', version: '0' })
  await other.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'plugin/dist/mcp.mjs')], env }))
  fs.mkdirSync(path.join(tmp, 'acme-admin'))
  await other.callTool({ name: 'live_connect', arguments: { projectRoot: path.join(tmp, 'acme-admin'), origins: ['http://localhost:5174'] } })
  await panel.getByTestId('session').locator('option').nth(1).waitFor({ state: 'attached' })
  await panelShot('3b-two-sessions')
  await other.close()
  const listener = new WebSocket(listenUrl)
  await new Promise((resolve) => listener.once('open', resolve))
  await panel.getByTestId('status').filter({ hasText: 'is listening' }).waitFor()
  await panelShot('4-listening-empty')

  await page.bringToFront()
  await page.locator('.cta').first().hover()
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('.cta').first().hover()
  await page.waitForTimeout(150)
  await shot(page, 'overlay-1-picking')
  await page.locator('dib-overlay .tool.ask').click()
  await page.locator('dib-overlay .askbar input').fill('Make the whole page feel less crowded')
  await page.waitForTimeout(200)
  await shot(page, 'overlay-1b-ask-claude')
  await page.locator('dib-overlay .tool.ask').click()
  const comment = async (selector, text, popoverShot) => {
    await page.locator(selector).first().click()
    await page.locator('dib-overlay .composer textarea').fill(text)
    if (popoverShot) {
      await page.waitForTimeout(250)
      await shot(page, popoverShot)
    }
    await page.locator('dib-overlay .composer textarea').press('Enter')
  }
  await comment('h1', 'Make the headline bolder and larger', 'overlay-2-popover')
  await comment('[data-testid="starter-cta"]', 'Use the accent color for the free plan button so it reads as the recommended plan, and make the label say "Start for free"')
  await comment('.lede', 'Shorter subtitle')
  await page.keyboard.press('Escape')
  await page.mouse.move(900, 600)
  await shot(page, 'overlay-3-draft-pins')

  await panel.bringToFront()
  await panelShot('5-draft')
  await panel.getByTestId('send').click()
  await panel.waitForTimeout(300)
  await panelShot('6-queued')

  const batch = JSON.parse(await call('live_get_batch'))
  await call('live_reply', { batchId: batch.id, replies: [{ commentId: batch.comments[0].id, status: 'done', message: 'Headline is now 40px, weight 800.' }] })
  await panelShot('7-working')
  await call('live_reply', {
    batchId: batch.id,
    replies: [
      { commentId: batch.comments[1].id, status: 'question', message: 'Accent purple or the green from the logo? The button sits on white, so both pass contrast.' },
      { commentId: batch.comments[2].id, status: 'skipped', message: 'The subtitle is already one line at every breakpoint.' },
    ],
    summary: 'One change, one question, one skipped.',
  })
  await page.bringToFront()
  await page.keyboard.press('Alt+Shift+C')
  await comment('.plan:nth-of-type(2) h2', 'Rename to Business')
  await page.keyboard.press('Escape')
  await panelShot('8-done-plus-draft')
  await page.bringToFront()
  await page.locator('dib-overlay .pin-wrap[data-status="skipped"] .pin').hover()
  await page.waitForTimeout(200)
  await shot(page, 'overlay-4-replied-hover')
  await page.mouse.move(900, 600)
  await page.locator('dib-overlay .pin-wrap[data-status="question"] .pin').first().click()
  await page.waitForTimeout(200)
  await shot(page, 'overlay-4b-question-card')
  await page.keyboard.press('Escape')
  await panel.bringToFront()
  await panel.getByTestId('answer-field').fill('Accent purple, the logo green is for success states')
  await panelShot('8b-answering')
  await panel.getByTestId('answer-field').press('Enter')
  await panel.getByTestId('message').fill('Also tighten the spacing between the two plans')
  await panelShot('8c-answer-drafted')
  await worker.evaluate(() =>
    chrome.storage.local.set({ lastError: 'That agent session has ended. Connect a session again (in Claude Code: /design-in-browser:live), then send.' }),
  )
  await panelShot('9-error')
  await panel.screenshot({ path: path.join(outDir, `${colorScheme}-panel-9b-full.png`), fullPage: true })

  // A tab the extension doesn't run on.
  const blank = await context.newPage()
  await blank.goto('about:blank')
  const blankId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'about:blank' }))[0]?.id)
  const offPanel = await context.newPage()
  await offPanel.setViewportSize({ width: 360, height: 420 })
  await offPanel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${blankId}`)
  await offPanel.waitForTimeout(500)
  await offPanel.screenshot({ path: path.join(outDir, `${colorScheme}-panel-10-unsupported-tab.png`) })


  const dark = await context.newPage()
  await dark.goto(`${origin}/dark`)
  await dark.locator('dib-overlay').waitFor({ state: 'attached' })
  await dark.locator('h1').hover()
  await dark.keyboard.press('Alt+Shift+C')
  await dark.locator('h1').hover()
  await dark.locator('h1').click()
  await dark.locator('dib-overlay .composer textarea').fill('On a dark page')
  await dark.waitForTimeout(250)
  await shot(dark, 'overlay-5-dark-page')

  await context.close()
  listener.terminate()
  await shim.close()
  const token = fs.readFileSync(path.join(tmp, 'home/token'), 'utf8').trim()
  await fetch(`http://127.0.0.1:${daemonPort}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(() => {})
  fixture.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}

for (const scheme of (process.env.CAPTURE_SCHEMES ?? 'dark').split(',')) await run(scheme)
console.log(`screenshots in ${outDir}`)
