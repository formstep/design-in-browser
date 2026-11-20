// Drawing on the page: boxes, arrows and pen strokes go with a comment, and a cropped screenshot when asked.
import { expect, test } from '@playwright/test'
import type { Batch } from '../../src/shared/protocol.ts'
import { appUrl, callTool, doorbells, dock, page, shim, useHarness } from './harness.ts'

// Chromium answers the capture prompt itself, so the screenshot path runs end to end. Headless, the stream is a
// stand-in for the tab, so the test checks that a JPEG of the area arrives, not what it shows.
useHarness({ browserArgs: ['--use-fake-ui-for-media-stream'] })

async function drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 8): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
}

test('draw a box and an arrow, then send them with a comment', async () => {
  await page.goto(appUrl)
  await page.keyboard.press('Alt+Shift+C')
  const tools = page.locator('dib-overlay .tools')
  await tools.getByRole('button', { name: 'Draw a box' }).click()
  await expect(tools.getByRole('button', { name: 'Draw a box' })).toHaveAttribute('aria-pressed', 'true')

  // The first mark opens the card beside it; more marks join the same comment.
  await drag({ x: 60, y: 160 }, { x: 330, y: 240 })
  const composer = page.locator('dib-overlay .composer')
  await expect(composer).toBeVisible()
  await expect(composer.locator('.shot-check')).toBeVisible()
  await tools.getByRole('button', { name: 'Draw an arrow' }).click()
  await drag({ x: 420, y: 120 }, { x: 340, y: 190 })
  await expect(page.locator('dib-overlay .ink .mark')).toHaveCount(2)
  await expect(composer).toBeVisible()

  await composer.locator('textarea').fill('Too much space between the cards')
  await composer.locator('textarea').press('Enter')
  await expect(composer).toBeHidden()
  // The drawing stays on the page with its comment in the stack.
  await expect(page.locator('dib-overlay .ink .mark.saved')).toHaveCount(2)
  await page.keyboard.press('Escape')

  if (await page.locator('dib-dock .launcher').isVisible()) await page.locator('dib-dock .launcher').click()
  await dock().getByTestId('send').click()
  await expect.poll(() => doorbells.at(-1)).toMatch(/ready, 1 comment/)
  const batch = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  const [box, arrow] = batch.comments[0]!.marks ?? []
  expect(box).toMatchObject({ kind: 'box', x: 60, y: 160, width: 270, height: 80 })
  expect(arrow).toMatchObject({ kind: 'arrow', from: { x: 420, y: 120 }, to: { x: 340, y: 190 } })
  expect(batch.comments[0]!.element).not.toBeNull()
})

test('a pen stroke with a screenshot of the marked area', async () => {
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('dib-overlay .tools').getByRole('button', { name: 'Draw freehand' }).click()
  await page.mouse.move(80, 300)
  await page.mouse.down()
  for (const [x, y] of [
    [120, 290],
    [160, 320],
    [200, 300],
    [240, 330],
  ]) {
    await page.mouse.move(x!, y!)
  }
  await page.mouse.up()
  const composer = page.locator('dib-overlay .composer')
  await composer.locator('textarea').fill('This row is crooked')
  await composer.locator('.attach-shot').check()
  await composer.locator('textarea').press('Enter')
  await expect(composer).toBeHidden({ timeout: 10_000 })
  await page.keyboard.press('Escape')

  await dock().getByTestId('send').click()
  await expect.poll(() => doorbells.at(-1)).toMatch(/ready, 1 comment/)
  const result = (await shim.callTool({ name: 'live_get_batch', arguments: {} })) as {
    content: Array<{ type: string; text?: string; data?: string }>
  }
  const batch = JSON.parse(result.content[0]!.text!) as Batch
  expect(batch.comments[0]!.marks?.[0]?.kind).toBe('pen')
  expect(batch.comments[0]!.screenshotFile).toMatch(/^screenshots\/.+\.jpg$/)
  const image = result.content.find((part) => part.type === 'image')
  // A real JPEG of the area around the stroke.
  expect(Buffer.from(image!.data!, 'base64').subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
})
