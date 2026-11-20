// Each app in a repo keeps its own thread, and Start over clears it, after asking, with what the agent is still
// working on left in view.
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { createServer } from 'vite'
import designInBrowser from '../../dist/vite.mjs'
import type { Batch } from '../../src/shared/protocol.ts'
import {
  appUrl,
  callTool,
  comment,
  context,
  dock,
  doorbells,
  freePort,
  page,
  project,
  repo,
  shim,
  useHarness,
  viteCache,
} from './harness.ts'

useHarness()

/** The batch the comment just made went out as, once its doorbell rings, as the agent fetches it. */
async function fetchSent(): Promise<Batch> {
  if (await page.locator('dib-dock .launcher').isVisible()) await page.locator('dib-dock .launcher').click()
  await expect.poll(() => doorbells.at(-1)).toMatch(/ready, 1 comment\./)
  return JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
}

test('two apps in one repo each show their own thread', async () => {
  await page.goto(appUrl)
  await page.keyboard.press('Alt+Shift+C')
  await comment('h1', 'Bolder headline')
  await page.keyboard.press('Escape')
  const batch = await fetchSent()
  await callTool(shim, 'live_reply', {
    batchId: batch.id,
    replies: [{ commentId: batch.comments[0]!.id, status: 'done', message: 'Bolder now.' }],
  })
  await expect(dock().getByTestId('sent')).toContainText('Bolder now.')

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
    await expect(dock(other).getByTestId('status')).toContainText('Claude is listening')
    // Same project and session, but the other app's comments and replies aren't in this app's chat.
    await expect(dock(other).locator('.turn')).toHaveCount(0)
    await other.close()
  } finally {
    await two.close()
  }
})

test('start over asks first, then clears the chat and the pins, and keeps what is in progress', async () => {
  // A question with a pin, and a batch the agent hasn't answered yet.
  await page.goto(appUrl)
  await page.keyboard.press('Alt+Shift+C')
  await comment('.lede', 'Shorter subtitle')
  await page.keyboard.press('Escape')
  const asked = await fetchSent()
  await callTool(shim, 'live_reply', {
    batchId: asked.id,
    replies: [{ commentId: asked.comments[0]!.id, status: 'question', message: 'Five words or one line?' }],
  })
  await expect(page.locator('dib-overlay .pins .pin-wrap[data-status="question"]:not([hidden])')).toHaveCount(1)
  await page.keyboard.press('Alt+Shift+C')
  await comment('button[data-testid="starter-cta"]', 'Green button')
  await page.keyboard.press('Escape')
  const working = await fetchSent()

  // Cancel, and Esc, keep everything.
  const startOver = dock().getByTestId('start-over')
  await startOver.click()
  const dialog = dock().getByRole('alertdialog', { name: 'Start over?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('The 1 comment Claude is still working on stay until it answers.')
  await expect(dock().getByTestId('start-over-cancel')).toBeFocused()
  await dock().getByTestId('start-over-cancel').click()
  await expect(dialog).toBeHidden()
  await expect(startOver).toBeFocused()
  await startOver.click()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(dock().locator('.turn')).toHaveCount(3)

  await startOver.click()
  await dock().getByTestId('start-over-confirm').click()
  await expect(dialog).toBeHidden()
  // Only the batch still in progress stays; its pin too, the question's goes.
  await expect(dock().locator('.turn')).toHaveCount(1)
  await expect(dock().getByTestId('sent')).toContainText('Green button')
  await expect(page.locator('dib-overlay .pins .pin-wrap[data-status="question"]:not([hidden])')).toHaveCount(0)

  // A late reply to a cleared batch stays out of view; the one in progress answers in view.
  await callTool(shim, 'live_reply', {
    batchId: asked.id,
    replies: [{ commentId: asked.comments[0]!.id, status: 'done', message: 'Cut to five words.' }],
  })
  await callTool(shim, 'live_reply', {
    batchId: working.id,
    replies: [{ commentId: working.comments[0]!.id, status: 'done', message: 'The button is green.' }],
  })
  await expect(dock().getByTestId('sent')).toContainText('The button is green.')
  await expect(dock().getByTestId('sent')).not.toContainText('Cut to five words.')

  // It holds across a reload, and a new comment shows as usual.
  await page.reload()
  await expect(dock().locator('.turn')).toHaveCount(1)
  await page.keyboard.press('Alt+Shift+C')
  await comment('h1', 'After starting over')
  await page.keyboard.press('Escape')
  await fetchSent()
  await expect(dock().locator('.turn')).toHaveCount(2)
  await expect(dock().getByTestId('sent')).toContainText('After starting over')
})
