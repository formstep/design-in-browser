// When the page can't draw a screenshot from its own DOM, it asks the browser to share the tab. Chromium answers
// that prompt itself here; headless, the shared stream stands in for the tab, so these tests check what happens
// to the comment, not what the picture shows.
import { expect, test } from '@playwright/test'
import type { Batch } from '../../src/shared/protocol.ts'
import { appUrl, doorbells, dock, page, shim, useHarness } from './harness.ts'

useHarness({ browserArgs: ['--use-fake-ui-for-media-stream'] })

const composer = () => page.locator('dib-overlay .composer')

/** Draws a box on a fresh page and types a comment for it, with "Attach a screenshot" ticked. */
async function boxWithComment(text: string): Promise<void> {
  if (await dock().isVisible()) await dock().getByRole('button', { name: 'Close' }).click()
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('dib-overlay .tools').getByRole('button', { name: 'Draw a box' }).click()
  await drawBox(80, 160)
  await composer().locator('textarea').fill(text)
  await composer().locator('.attach-shot').check()
}

async function drawBox(x: number, y: number): Promise<void> {
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 240, y + 80, { steps: 8 })
  await page.mouse.up()
}

/** The card closed because its comment was added. While the tab is captured it's only made invisible. */
const added = () => expect(composer()).toHaveAttribute('hidden', '', { timeout: 20_000 })

/** Sends the stack and returns the batch with whether the agent got an image. */
async function send(count = 1): Promise<{ batch: Batch; image: boolean }> {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Alt+Shift+D')
  await dock().getByTestId('send').click()
  await expect.poll(() => doorbells.at(-1)).toMatch(count === 1 ? /ready, 1 comment\./ : `ready, ${count} comments.`)
  const result = (await shim.callTool({ name: 'live_get_batch', arguments: {} })) as {
    content: Array<{ type: string; text?: string }>
  }
  return { batch: JSON.parse(result.content[0]!.text!) as Batch, image: result.content.some((part) => part.type === 'image') }
}

test('a drawing that never finishes falls back to the share prompt, and the card works afterwards', async () => {
  await page.goto(appUrl)
  // An image whose decoding fails leaves html-to-image waiting forever.
  await page.evaluate(() => {
    HTMLImageElement.prototype.decode = () => Promise.reject(new Error('decode failed'))
  })
  await boxWithComment('Align these')
  await composer().locator('textarea').press('Enter')
  await expect(composer().locator('.hint')).toHaveText('Taking a screenshot…')
  await added()
  // The card takes the next comment as usual.
  await drawBox(80, 320)
  await composer().locator('textarea').fill('And this one')
  await expect(composer().locator('.hint')).toHaveText('Enter to add')
  await composer().locator('textarea').press('Enter')
  await added()
  const { batch, image } = await send(2)
  expect(batch.comments[0]!.screenshotFile).toMatch(/^screenshots\/.+\.jpg$/)
  expect(batch.comments[1]!.text).toBe('And this one')
  expect(image).toBe(true)
})

test('when the page can’t be drawn, the tab-share prompt takes the screenshot', async () => {
  await page.goto(appUrl)
  await page.evaluate(() => {
    XMLSerializer.prototype.serializeToString = () => {
      throw new Error('cannot serialize')
    }
  })
  await boxWithComment('Too tight')
  await composer().locator('textarea').press('Enter')
  await added()
  const { batch, image } = await send()
  expect(batch.comments[0]!.screenshotFile).toMatch(/^screenshots\/.+\.jpg$/)
  expect(image).toBe(true)
})

test('declining to share the tab keeps the comment and says how to add it without a screenshot', async () => {
  await page.goto(appUrl)
  await page.evaluate(() => {
    XMLSerializer.prototype.serializeToString = () => {
      throw new Error('cannot serialize')
    }
    navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
  })
  await boxWithComment('Bigger gap')
  await composer().locator('textarea').press('Enter')
  await expect(composer().locator('.composer-error')).toHaveText(
    'The tab wasn’t shared, so there’s no screenshot. Untick "Attach a screenshot" to add the comment without one.'
  )
  await expect(composer().locator('textarea')).toHaveValue('Bigger gap')
  await expect(composer().locator('.hint')).not.toHaveText('Taking a screenshot…')

  await composer().locator('.attach-shot').uncheck()
  await composer().locator('textarea').press('Enter')
  await added()
  const { batch, image } = await send()
  expect(batch.comments[0]!.text).toBe('Bigger gap')
  expect(batch.comments[0]!.screenshotFile).toBeUndefined()
  expect(image).toBe(false)
})
