// The dock beside the page: it pushes the page aside, keeps long lines inside its width, and the markers on the page
// can be hidden, while finished comments drop theirs.
import { expect, test } from '@playwright/test'
import type { Batch } from '../../src/shared/protocol.ts'
import { appUrl, callTool, comment, dock, doorbells, page, shim, useHarness } from './harness.ts'

useHarness()

const rootMargin = () => page.evaluate(() => document.documentElement.style.marginRight)

test('the open dock pushes the page aside, and gives the room back when it closes', async () => {
  await page.goto(appUrl)
  await page.locator('dib-dock .launcher').click()
  await expect(dock()).toBeVisible()
  expect(await rootMargin()).toBe('380px')
  const plans = (await page.locator('.plans').boundingBox())!
  expect(plans.x + plans.width).toBeLessThanOrEqual(1100 - 380)

  await dock().getByRole('button', { name: 'Close' }).click()
  expect(await rootMargin()).toBe('')

  // A phone-width window: the dock covers the whole window, so it pushes nothing.
  await page.setViewportSize({ width: 390, height: 720 })
  await page.locator('dib-dock .launcher').click()
  expect(await rootMargin()).toBe('')
  await dock().getByRole('button', { name: 'Close' }).click()
  await page.setViewportSize({ width: 1100, height: 720 })
})

test('a long element name and a long reply stay inside the dock', async () => {
  await page.goto(appUrl)
  await page.evaluate(() => {
    const long = document.createElement('p')
    long.className = 'w-full max-w-none text-muted-foreground long-copy'
    long.textContent = 'No folders or forms yet. Start with a template, or begin with a new form. Translations follow later.'
    document.querySelector('main')!.append(long)
  })
  await page.keyboard.press('Alt+Shift+C')
  await comment('.long-copy', 'Make this friendlier')
  await comment('h1', 'Bolder')
  await page.keyboard.press('Escape')
  await page.locator('dib-dock .launcher').click()
  await dock().getByTestId('send').click()
  await expect.poll(() => doorbells.at(-1)).toMatch(/ready, 2 comments\./)
  const batch = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  await callTool(shim, 'live_reply', {
    batchId: batch.id,
    replies: [
      {
        commentId: batch.comments[0]!.id,
        status: 'done',
        message: 'The empty state now points at templates first, since most people start from one, then at a blank form.',
      },
      {
        commentId: batch.comments[1]!.id,
        status: 'question',
        message: 'Bolder as in a heavier weight, or larger as well, matching the size of the section headings below?',
      },
    ],
  })
  await expect(dock().getByTestId('sent')).toContainText('matching the size of the section headings below?')

  const thread = dock().getByTestId('sent')
  const overflow = await thread.evaluate((node) => node.scrollWidth - node.clientWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  const dockBox = (await dock().boundingBox())!
  const answer = (await dock().getByTestId('answer-field').boundingBox())!
  expect(answer.x + answer.width).toBeLessThanOrEqual(dockBox.x + dockBox.width)
})

test('finished comments drop their pins, and the rest hide from the header until you comment again', async () => {
  const pins = page.locator('dib-overlay .pins .pin-wrap:not([hidden])')
  // The done comment from the last test has no pin; the question on the heading keeps one.
  await expect.poll(() => pins.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.status))).toEqual(['question'])

  const toggle = dock().getByTestId('markers')
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAccessibleName('Show markers on the page')
  // The pins' layer is an empty box: whether it shows is its hidden attribute.
  const layer = page.locator('dib-overlay .pins')
  await expect(layer).toHaveAttribute('hidden', '')
  await expect(pins.locator('.pin')).toBeHidden()

  // It holds across a reload.
  await page.reload()
  await expect(dock().getByTestId('markers')).toHaveAttribute('aria-pressed', 'true')
  await expect(layer).toHaveAttribute('hidden', '')

  // Starting to comment brings them back.
  await page.keyboard.press('Alt+Shift+C')
  await expect(layer).not.toHaveAttribute('hidden')
  await expect(pins.locator('.pin')).toBeVisible()
  await expect(dock().getByTestId('markers')).toHaveAttribute('aria-pressed', 'false')
  await page.keyboard.press('Escape')
})
