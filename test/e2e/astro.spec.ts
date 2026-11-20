// Astro: the integration puts the client into the pages Astro renders, and a React island carries its source
// locations in the server's HTML too, so hydration matches the browser's render.
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { dev } from 'astro'
import type { Batch } from '../../src/shared/protocol.ts'
import { callTool, comment, dock, doorbells, freePort, page, repo, shim, tmp, useHarness } from './harness.ts'

useHarness()

let astro: Awaited<ReturnType<typeof dev>>
let siteUrl = ''

test.beforeAll(async () => {
  const port = await freePort()
  astro = await dev({
    root: path.join(repo, 'test/e2e/astro-app'),
    cacheDir: path.join(tmp, 'astro-cache'),
    vite: { cacheDir: path.join(tmp, 'astro-vite-cache') },
    server: { port },
    logLevel: 'error',
  })
  siteUrl = `http://localhost:${port}/`
})

test.afterAll(async () => {
  await astro?.stop()
})

test('an Astro page gets the overlay, and its island is located in the server HTML and in the browser alike', async () => {
  const html = await (await fetch(siteUrl)).text()
  expect(html).toMatch(/data-dib-src="[^"]*astro-app\/src\/components\/Counter\.tsx:\d+:\d+"/)

  const hydrationErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydrat/i.test(message.text())) hydrationErrors.push(message.text())
  })
  await page.goto(siteUrl)
  await expect(page.locator('dib-overlay')).toBeAttached()
  // The island hydrated (Astro drops its ssr attribute then): it counts.
  await expect(page.locator('astro-island', { has: page.locator('.counter') })).not.toHaveAttribute('ssr')
  await page.locator('.counter button').click()
  await expect(page.locator('.counter p')).toHaveText('Cups ordered: 1')
  await expect(page.locator('.counter button')).toHaveAttribute('data-dib-src', /Counter\.tsx:\d+:\d+$/)
  expect(hydrationErrors).toEqual([])

  await page.keyboard.press('Alt+Shift+C')
  await comment('.counter button', 'Say "Order a coffee"')
  await page.keyboard.press('Escape')
  if (await page.locator('dib-dock .launcher').isVisible()) await page.locator('dib-dock .launcher').click()
  await expect.poll(() => doorbells.at(-1)).toMatch(/ready, 1 comment\./)
  const batch = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  const [sent] = batch.comments
  expect(sent!.element?.sources?.[0]).toMatch(/astro-app\/src\/components\/Counter\.tsx:\d+:\d+$/)
  await callTool(shim, 'live_reply', {
    batchId: batch.id,
    replies: [{ commentId: sent!.id, status: 'done', message: 'The button says "Order a coffee" now.' }],
  })
  await expect(dock()).toContainText('The button says "Order a coffee" now.')
})

test('alternatives in an Astro island keep their switcher on Before, though Astro passes it in through <astro-slot>', async () => {
  await page.goto(siteUrl)
  // The group sits far down the page, and its switcher follows it on screen.
  await page.evaluate(() => document.querySelector('section')!.scrollIntoView({ block: 'center' }))
  const bar = page.locator('dib-overlay .variant[data-group="tagline"]')
  await expect(bar).toBeVisible()
  // Before is the markup Astro passed into the island, inside <astro-slot>, which has no box of its own.
  await bar.getByRole('button', { name: 'Before', exact: true }).click()
  await expect(page.locator('dib-variants[data-group="tagline"] astro-slot .tagline')).toBeVisible()
  await expect(bar).toBeVisible()
  await bar.getByRole('button', { name: 'After', exact: true }).click()
  await expect(page.locator('.tagline-louder')).toBeVisible()
  await bar.getByRole('button', { name: 'Before', exact: true }).click()

  // "Show on page" in the dock takes the reader to the group, wherever its content is.
  await page.evaluate(() => scrollTo(0, 0))
  await page.keyboard.press('Alt+Shift+C')
  await comment('h1', 'Try a louder tagline')
  await page.keyboard.press('Escape')
  if (await page.locator('dib-dock .launcher').isVisible()) await page.locator('dib-dock .launcher').click()
  await expect.poll(() => doorbells.at(-1)).toMatch(/ready, 1 comment\./)
  const batch = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  await callTool(shim, 'live_reply', {
    batchId: batch.id,
    replies: [{ commentId: batch.comments[0]!.id, status: 'variants', message: 'One louder tagline is up.', group: 'tagline' }],
  })
  await dock().getByTestId('show-group').click()
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(500)
})
