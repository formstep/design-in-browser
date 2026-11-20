// The plugin inside different dev servers: a strict CSP, a server open to the network, two apps in one
// project, HMR off, a production build, and a dev server that goes down mid-save.
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { createServer } from 'vite'
import designInBrowser from '../../dist/vite.mjs'
import type { Batch } from '../../src/shared/protocol.ts'
import {
  callTool,
  shim,
  repo,
  appRoot,
  tmp,
  project,
  appUrl,
  context,
  page,
  freePort,
  startVite,
  stopAppServer,
  startAppServer,
  dock,
  useHarness,
  viteCache,
} from './harness.ts'

useHarness()

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
  const pin = strict.locator('dib-overlay .pins .pin-wrap[data-status="pending"]:not([hidden])')
  await expect(pin.locator('.pin')).toHaveCSS('border-bottom-left-radius', '0px')
  await pin.locator('.pin').click()
  await expect(pin.locator('.thread')).toBeVisible()
  // The agent finishes it: the pin leaves the page.
  const batch = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  await callTool(shim, 'live_reply', {
    batchId: batch.id,
    replies: [{ commentId: batch.comments[0]!.id, status: 'done', message: 'Works under the strict CSP.' }],
  })
  await expect(pin).toHaveCount(0)
  expect(errors.filter((text) => /design-in-browser|dib-/.test(text))).toEqual([])
  await strict.close()
})

test('a dev server that listens beyond localhost leaves the page alone', async () => {
  const exposed = await startVite('0.0.0.0', await freePort())
  try {
    const port = (exposed.httpServer!.address() as AddressInfo).port
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

test('two apps in one project keep their own threads', async () => {
  const twoPort = await freePort()
  const two = await createServer({
    root: path.join(repo, 'test/e2e/app-two'),
    configFile: false,
    cacheDir: viteCache(twoPort),
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
    await expect(dock(other).getByTestId('sent')).toContainText('Only in the second app')
    await callTool(shim, 'live_get_batch')
    await page.goto(appUrl)
    if (await page.locator('dib-dock .launcher').isVisible()) await page.locator('dib-dock .launcher').click()
    await expect(dock().getByTestId('status')).toContainText('Claude is listening')
    await expect(dock().getByTestId('sent')).not.toContainText('Only in the second app')
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
    cacheDir: viteCache(offPort),
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

test('a comment survives a send that fails while the dev server is down', async () => {
  await page.goto(appUrl)
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('.lede').click()
  await stopAppServer()
  const composer = page.locator('dib-overlay .composer')
  await composer.locator('textarea').fill('Text I typed before noticing')
  await composer.locator('textarea').press('Enter')
  await expect(composer).toBeVisible({ timeout: 8000 })
  await expect(composer.locator('textarea')).toHaveValue('Text I typed before noticing')
  await expect(composer.locator('.composer-error')).toContainText('The dev server isn’t running')
  await startAppServer()
})

test('an answer from the dock or a pin, and a dock message, keep their text and say why when the dev server is down', async () => {
  await page.goto(appUrl)
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('h1').click()
  const composer = page.locator('dib-overlay .composer')
  await composer.locator('textarea').fill('Bolder')
  await composer.locator('textarea').press('Enter')
  await expect(composer).toBeHidden()
  await page.keyboard.press('Escape')
  let batch = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  while (batch.comments[0]!.text !== 'Bolder') batch = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  await callTool(shim, 'live_reply', {
    batchId: batch.id,
    replies: [{ commentId: batch.comments[0]!.id, status: 'question', message: 'Heavier, or larger too?' }],
  })
  if (await page.locator('dib-dock .launcher').isVisible()) await page.locator('dib-dock .launcher').click()
  const field = page.locator('dib-dock .dock').getByTestId('answer-field')
  await expect(field).toBeVisible()

  await stopAppServer()
  await field.fill('Heavier only')
  await field.press('Enter')
  await expect(page.locator('dib-dock .answer-error')).toContainText('The dev server isn’t running', { timeout: 8000 })
  await expect(field).toHaveValue('Heavier only')

  const pin = page.locator('dib-overlay .pins .pin-wrap[data-status="question"]')
  await pin.locator('.pin').click()
  const pinField = pin.locator('textarea')
  await pinField.fill('Larger too')
  await pinField.press('Enter')
  await expect(pin.locator('.reply-error')).toContainText('The dev server isn’t running')
  await expect(pinField).toHaveValue('Larger too')

  const message = page.locator('dib-dock .dock').getByTestId('message')
  await message.fill('And the subtitle')
  await message.press('Enter')
  await expect(page.locator('dib-dock .dock').getByTestId('error')).toContainText('The dev server isn’t running')
  await expect(message).toHaveValue('And the subtitle')
  await startAppServer()
})

test('a build with a <Variants> group left in the code fails and says why', async () => {
  const { build } = await import('vite')
  process.env.DIB_BUILD_OUT = path.join(tmp, 'build-out')
  await expect(build({ root: appRoot, configFile: path.join(appRoot, 'vite.config.ts'), logLevel: 'silent' })).rejects.toThrow(
    /A <Variants> group from design-in-browser\/react is still in the code/
  )
})
