// Screenshots every overlay and dock state for design review. The UI is dark only, like Claude Design.
// Serves the fixture app (test/e2e/app) with the built plugin, and runs a real daemon and MCP server on
// spare ports; nothing touches ~/.design-in-browser.
// Usage: pnpm build && node scripts/capture.mjs [outDir]
import fs from 'node:fs'
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
const log = (name) => process.env.CAPTURE_VERBOSE && console.log(new Date().toISOString().slice(11, 19), name)

const freePort = () =>
  new Promise((resolve) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dib-capture-'))
const project = path.join(tmp, 'acme-web')
fs.mkdirSync(project)
process.env.DIB_PORT = String(await freePort())
process.env.DIB_HOME = path.join(tmp, 'home')
process.env.DIB_PROJECT_ROOT = project
const { createServer } = await import('vite')
const appPort = await freePort()
const vite = await createServer({
  root: path.join(repo, 'test/e2e/app'),
  configFile: path.join(repo, 'test/e2e/app/vite.config.ts'),
  server: { port: appPort, strictPort: true },
})
await vite.listen()
const appUrl = `http://localhost:${appPort}/`

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1100, height: 720 }, colorScheme: 'dark' })
context.setDefaultTimeout(15_000)
const page = await context.newPage()
const shot = async (name) => {
  log(name)
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(outDir, `${name}.png`) })
}
const dock = page.locator('dib-dock .dock')

await page.goto(appUrl)
await page.locator('dib-overlay').waitFor({ state: 'attached' })
await page.locator('dib-dock .launcher').click()
await shot('dock-1-offline')

const shim = new Client({ name: 'claude-code', version: '0' })
await shim.connect(
  new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'plugin/dist/mcp.mjs')], env: process.env })
)
const call = async (name, args = {}) =>
  (await shim.callTool({ name, arguments: args }, undefined, { timeout: 15_000 })).content.map((part) => part.text).join('\n')
const connected = await call('live_connect', { projectRoot: project })
const listenUrl = /ws:\/\/\S+\/listen\/\S+/.exec(connected)[0].replace(/,$/, '')
await dock.getByTestId('status').filter({ hasText: 'Not listening' }).waitFor()
await shot('dock-2-not-listening')
const other = new Client({ name: 'opencode', version: '0' })
await other.connect(
  new StdioClientTransport({ command: process.execPath, args: [path.join(repo, 'plugin/dist/mcp.mjs')], env: process.env })
)
fs.mkdirSync(path.join(tmp, 'acme-admin'))
await other.callTool({ name: 'live_connect', arguments: { projectRoot: path.join(tmp, 'acme-admin') } })
await dock.getByTestId('session').locator('option').nth(1).waitFor({ state: 'attached' })
await shot('dock-3-two-sessions')
await other.close()
const listener = new WebSocket(listenUrl)
await new Promise((resolve) => listener.once('open', resolve))
await dock.getByTestId('status').filter({ hasText: 'is listening' }).waitFor()
await shot('dock-4-listening-empty')

await page.locator('.cta').first().hover()
await page.keyboard.press('Alt+Shift+C')
await page.locator('.cta').first().hover()
await shot('overlay-1-picking')
await page.locator('dib-overlay .tool.ask').click()
await page.locator('dib-overlay .askbar input').fill('Make the whole page feel less crowded')
await shot('overlay-2-ask')
await page.locator('dib-overlay .tool.ask').click()
const comment = async (selector, text, name) => {
  await page.locator(selector).first().click()
  await page.locator('dib-overlay .composer textarea').fill(text)
  if (name) await shot(name)
  await page.locator('dib-overlay .composer textarea').press('Enter')
}
await comment('h1', 'Make the headline bolder and larger', 'overlay-3-comment-card')
await comment(
  '[data-testid="starter-cta"]',
  'Use the accent color for the free plan button so it reads as the recommended plan, and make the label say "Start for free"'
)
await comment('.lede', 'Shorter subtitle')
await page.keyboard.press('Escape')
await page.mouse.move(300, 600)
await shot('dock-5-stacked')
await dock.getByTestId('send').click()
await shot('dock-6-queued')

const batch = JSON.parse(await call('live_get_batch'))
await call('live_reply', {
  batchId: batch.id,
  replies: [{ commentId: batch.comments[0].id, status: 'done', message: 'Headline is now 40px, weight 800.' }],
})
await shot('dock-7-working')
await call('live_reply', {
  batchId: batch.id,
  replies: [
    {
      commentId: batch.comments[1].id,
      status: 'question',
      message: 'Accent purple or the green from the logo? The button sits on white, so both pass contrast.',
    },
    { commentId: batch.comments[2].id, status: 'skipped', message: 'The subtitle is already one line at every breakpoint.' },
  ],
  summary: 'One change, one question, one skipped.',
})
await shot('dock-8-replied')
await page.locator('dib-overlay .pin-wrap[data-status="question"] .pin').click()
await shot('overlay-4-pin-thread')
await page.keyboard.press('Escape')
await dock.getByTestId('answer-field').fill('Accent purple, the logo green is for success states')
await dock.getByTestId('answer-field').press('Enter')
await dock.getByTestId('message').fill('Also tighten the spacing between the two plans')
await shot('dock-9-composer')
await page.locator('dib-dock .close').click()
await shot('overlay-5-dock-closed')

// Alternatives: the switcher, its tweaks, and a pick waiting for the agent.
await page.goto(new URL('/variants.html', appUrl).href)
await page.locator('dib-overlay .variant-bar').first().waitFor()
await shot('variants-1-switcher')
await page.locator('dib-overlay .variant[data-group="hero"]').getByRole('button', { name: 'Before', exact: true }).click()
await page.mouse.move(900, 650)
await shot('variants-1b-before')
await page.locator('dib-overlay .variant[data-group="hero"]').getByRole('button', { name: 'Previous alternative' }).click()
await page.locator('dib-overlay .variant[data-group="hero"]').hover()
await page.locator('dib-overlay .variant[data-group="hero"] .variant-tweaks').click()
await page.locator('dib-overlay .tweaks input[data-tweak="padding"]').fill('72')
await shot('variants-2-tweaks')
await page.locator('dib-overlay .variant[data-group="hero"] .variant-use').click()
await page.locator('dib-overlay .variant-picked').waitFor()
await shot('variants-3-picked')

await browser.close()
listener.terminate()
await shim.close()
const token = fs.readFileSync(path.join(tmp, 'home/token'), 'utf8').trim()
await fetch(`http://127.0.0.1:${process.env.DIB_PORT}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).catch(
  () => {}
)
await vite.close()
fs.rmSync(tmp, { recursive: true, force: true })
console.log(`screenshots in ${outDir}`)
