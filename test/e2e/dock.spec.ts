// The dock beside the page: it pushes the page aside, keeps long lines inside its width, and the markers on the page
// can be hidden, while finished comments drop theirs.
import { expect, test } from '@playwright/test'
import type { Batch } from '../../src/shared/protocol.ts'
import { appUrl, callTool, comment, dock, doorbells, page, shim, useHarness, vite } from './harness.ts'

useHarness()

const rootMargin = () => page.evaluate(() => document.documentElement.style.marginRight)

test('the open dock pushes the page aside, and gives the room back when it closes', async () => {
  await page.goto(appUrl)
  // A layout sized to the window, as Tailwind's w-screen does: a margin on the root alone wouldn't move it.
  await page.evaluate(() => {
    const root = document.getElementById('root')!
    const wide = document.createElement('div')
    wide.className = 'window-wide'
    wide.style.width = '100vw'
    root.before(wide)
    wide.append(root)
  })
  await page.locator('dib-dock .launcher').click()
  await expect(dock()).toBeVisible()
  expect(await rootMargin()).toBe('380px')
  await expect
    .poll(async () => (await page.locator('.plans').boundingBox())!.x + (await page.locator('.plans').boundingBox())!.width)
    .toBeLessThanOrEqual(1100 - 380)
  const wideBox = (await page.locator('.window-wide').boundingBox())!
  expect(wideBox.x + wideBox.width).toBeLessThanOrEqual(1100 - 380)

  await dock().getByRole('button', { name: 'Close' }).click()
  expect(await rootMargin()).toBe('')
  await expect(page.locator('.window-wide')).toHaveCSS('width', '1100px')
  expect(await page.locator('.window-wide').evaluate((node: HTMLElement) => node.style.maxWidth)).toBe('')

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

test('dismiss a question from the dock and a note from its pin, without answering', async () => {
  const dismiss = dock().getByTestId('dismiss')
  await expect(dismiss).toHaveCount(1)
  await dismiss.click()
  await expect(dock().getByTestId('sent')).toContainText('Dismissed.')
  await expect(dock().getByTestId('answer-field')).toHaveCount(0)
  await expect(page.locator('dib-overlay .pins .pin-wrap[data-status="question"]')).toHaveCount(0)

  await callTool(shim, 'live_note', {
    url: page.url(),
    notes: [{ selector: '.lede', note: 'This line now wraps at 60 characters.' }],
  })
  const note = page.locator('dib-overlay .pins .pin-wrap[data-status="note"]:not([hidden])')
  await note.locator('.pin').click()
  await note.getByRole('button', { name: 'Dismiss' }).click()
  await expect(note).toHaveCount(0)

  // Dismissals are kept with the comment stack, so a reload (or another tab) agrees.
  await page.reload()
  await expect(dock().getByTestId('dismiss')).toHaveCount(0)
  await expect(page.locator('dib-overlay .pins .pin-wrap:not([hidden])')).toHaveCount(0)
})

test('a dev server still running an older plugin gets a restart notice, and the dock keeps working', async () => {
  await page.goto(appUrl)
  if (await page.locator('dib-dock .launcher').isVisible()) await page.locator('dib-dock .launcher').click()
  // What a plugin from before the page build ID sends: no build, and none of the newer fields.
  vite.environments.client.hot.send('design-in-browser:state', {
    connection: 'connected',
    projectRoot: '/elsewhere',
    sessions: [],
    batches: [],
    draft: [],
    sending: false,
    lastError: null,
    pickedSessionId: null,
    sendOnAdd: false,
    variantChoices: {},
    tweakValues: {},
  })
  const notice = dock().locator('.notice')
  await expect(notice).toHaveText('This dev server still runs an older design-in-browser. Restart it to finish the update.')
  await expect(dock().getByTestId('start-over')).toBeHidden()
  await expect(dock().getByTestId('status')).toHaveText('No session')

  // The current plugin's next state clears it.
  await page.reload()
  await expect(dock().getByTestId('status')).toContainText('Claude is listening')
  await expect(notice).toBeHidden()
})
