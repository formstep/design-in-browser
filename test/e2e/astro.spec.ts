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
  // The island hydrated: it counts.
  await page.locator('.counter button').click()
  await expect(page.locator('.counter p')).toHaveText('Cups ordered: 1')
  await expect(page.locator('.counter button')).toHaveAttribute('data-dib-src', /Counter\.tsx:\d+:\d+$/)
  expect(hydrationErrors).toEqual([])

  await page.keyboard.press('Alt+Shift+C')
  await comment('.counter button', 'Say "Order a coffee"')
  await page.keyboard.press('Escape')
  if (await page.locator('dib-dock .launcher').isVisible()) await page.locator('dib-dock .launcher').click()
  await dock().getByTestId('send').click()
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
