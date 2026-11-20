// Screenshots every overlay and dock state for design review. The UI is dark only, like Claude Design.
// Serves the fixture app (test/e2e/app) with the built plugin, and runs a real daemon and MCP server on
// spare ports; nothing touches ~/.design-in-browser.
// Usage: pnpm capture [outDir], or CAPTURE_SCALE=2 pnpm capture docs/images for the README's images.
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
// CAPTURE_SCALE=2 for images people will see, such as the README's.
const context = await browser.newContext({
  viewport: { width: 1100, height: 720 },
  colorScheme: 'dark',
  deviceScaleFactor: Number(process.env.CAPTURE_SCALE ?? 1),
})
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

// Notes the agent leaves on the page: a pin per note, and the agent's own turn in the dock.
await page.locator('dib-dock .launcher').click()
await call('live_note', {
  url: appUrl,
  notes: [
    { selector: 'h1', note: 'The headline is 40px and weight 800 now, as you asked.' },
    { selector: '.plan:nth-of-type(2) h2', note: 'Should the team plan get the accent color too, or stay neutral?', question: true },
  ],
})
await page.locator('dib-overlay .pin-wrap[data-status="note"] .pin').waitFor()
await page.locator('dib-overlay .pin-wrap[data-status="note"] .pin').click()
await shot('notes-1-pin-and-dock')
await page.keyboard.press('Escape')

// Long words in both directions: a long comment, a long reply, and a selector with no spaces to break at.
await page.keyboard.press('Alt+Shift+C')
await page.locator('.lede').click()
await page
  .locator('dib-overlay .composer textarea')
  .fill(
    'This subtitle reads like a disclaimer. Make it one confident sentence about what the team plan gives you, keep it under the heading width, and check https://example.com/a-very-long-reference-link-that-has-no-spaces-at-all-and-should-wrap-somewhere for the tone we want.'
  )
await page.locator('dib-overlay .composer textarea').press('Enter')
await page.keyboard.press('Escape')
await dock.getByTestId('send').click()
let long = null
for (let tries = 0; !long && tries < 50; tries++) {
  const answer = await call('live_get_batch')
  if (answer.startsWith('{')) long = JSON.parse(answer)
  else await page.waitForTimeout(100)
}
const longComment = long.comments.find((comment) => comment.text.startsWith('This subtitle'))
await call('live_reply', {
  batchId: long.id,
  replies: [
    {
      commentId: longComment.id,
      status: 'done',
      message:
        'Rewrote it as "One plan, every feature, for the whole team." It fits the heading width at every breakpoint I could see, and the reference link was too long to show, so I followed its tone instead: short, plain, no exclamation marks.',
    },
  ],
})
await page.waitForTimeout(400)
await shot('dock-10-long-text')

// Keyboard: focus on the toolbar's drawing tools.
await page.keyboard.press('Alt+Shift+C')
await page.locator('dib-overlay .tools .pick-tool').focus()
await page.keyboard.press('Tab')
await shot('overlay-7-keyboard-focus')
await page.keyboard.press('Escape')

// A phone-width window: the dock and the toolbar have to fit.
await page.setViewportSize({ width: 390, height: 844 })
await page.waitForTimeout(300)
await shot('narrow-1-dock')
await page.locator('dib-dock .close').click()
await page.keyboard.press('Alt+Shift+C')
await page.locator('h1').click()
await page.locator('dib-overlay .composer textarea').fill('Smaller on phones')
await shot('narrow-2-comment-card')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await page.setViewportSize({ width: 1100, height: 720 })

// Drawing: a box and an arrow with the comment card open beside them.
await page.goto(appUrl)
await page.keyboard.press('Alt+Shift+C')
await page.locator('dib-overlay .tools').getByRole('button', { name: 'Draw a box' }).click()
const drag = async (from, to) => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
}
await drag({ x: 60, y: 160 }, { x: 330, y: 240 })
await page.locator('dib-overlay .tools').getByRole('button', { name: 'Draw an arrow' }).click()
await drag({ x: 520, y: 120 }, { x: 345, y: 190 })
await page.locator('dib-overlay .composer textarea').fill('Too much space between these')
await shot('overlay-6-drawing')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')

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
