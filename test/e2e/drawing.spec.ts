// Drawing on the page: boxes, arrows and pen strokes go with a comment, and a cropped screenshot when asked.
import http from 'node:http'
import { expect, test } from '@playwright/test'
import type { Batch } from '../../src/shared/protocol.ts'
import { appUrl, callTool, doorbells, dock, freePort, page, shim, useHarness } from './harness.ts'

// No capture switches: the screenshot is drawn from the page itself, so it needs no prompt to answer.
useHarness()

type Content = Array<{ type: string; text?: string; data?: string }>

/** The batch and the screenshot `live_get_batch` hands the agent. */
async function batchWithScreenshot(): Promise<{ batch: Batch; jpeg: Buffer }> {
  const result = (await shim.callTool({ name: 'live_get_batch', arguments: {} })) as { content: Content }
  const image = result.content.find((part) => part.type === 'image')
  return { batch: JSON.parse(result.content[0]!.text!) as Batch, jpeg: Buffer.from(image!.data!, 'base64') }
}

/** The color of one pixel of a JPEG, decoded by the browser. */
function pixelOf(jpeg: Buffer, x: number, y: number): Promise<[number, number, number]> {
  return page.evaluate(
    async ({ data, x, y }) => {
      const image = new Image()
      image.src = `data:image/jpeg;base64,${data}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const [r, g, b] = context.getImageData(x, y, 1, 1).data
      return [r!, g!, b!] as [number, number, number]
    },
    { data: jpeg.toString('base64'), x, y }
  )
}

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

test('a pen stroke with a screenshot of the marked area, without any prompt', async () => {
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
  const { batch, jpeg } = await batchWithScreenshot()
  expect(batch.comments[0]!.marks?.[0]?.kind).toBe('pen')
  expect(batch.comments[0]!.screenshotFile).toMatch(/^screenshots\/.+\.jpg$/)
  // A real JPEG of the area around the stroke.
  expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
})

test('a screenshot still comes out with an image it may not read, a slow image, and the background on <html>', async () => {
  // Another origin's images, sent without CORS headers: the page shows them but may not read them.
  // slow.svg never arrives in time.
  const red = `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" fill="red"/></svg>`
  const images = http.createServer((request, response) => {
    const send = () => response.writeHead(200, { 'content-type': 'image/svg+xml' }).end(red)
    if (request.url === '/slow.svg') setTimeout(send, 20_000)
    else send()
  })
  const port = await freePort()
  await new Promise<void>((resolve) => images.listen(port, '127.0.0.1', resolve))
  try {
    await page.goto(appUrl)
    // As in Vite's own template: the background is on the root, and body is transparent.
    await page.evaluate((origin) => {
      document.documentElement.style.background = 'rgb(250, 250, 250)'
      document.body.style.background = 'transparent'
      for (const [name, left] of [
        ['pic.svg', 850],
        ['slow.svg', 950],
      ] as const) {
        const image = document.createElement('img')
        image.src = `${origin}/${name}`
        image.style.cssText = `position: fixed; left: ${left}px; top: 420px; width: 60px; height: 60px`
        document.body.append(image)
      }
    }, `http://127.0.0.1:${port}`)

    // The dock, open from the last test, would cover where this test draws.
    if (await dock().isVisible()) await dock().getByRole('button', { name: 'Close' }).click()
    await page.keyboard.press('Alt+Shift+C')
    await page.locator('dib-overlay .tools').getByRole('button', { name: 'Draw a box' }).click()
    await drag({ x: 820, y: 400 }, { x: 1040, y: 500 })
    const composer = page.locator('dib-overlay .composer')
    await composer.locator('textarea').fill('Make these images the same size')
    await composer.locator('.attach-shot').check()
    // Enter twice while the screenshot is taken: one comment.
    await composer.locator('textarea').press('Enter')
    await composer.locator('textarea').press('Enter')
    await expect(composer.locator('.hint')).toHaveText('Taking a screenshot…')
    await expect(composer).toBeHidden({ timeout: 10_000 })
    await page.keyboard.press('Escape')

    await page.keyboard.press('Alt+Shift+D')
    await dock().getByTestId('send').click()
    await expect.poll(() => doorbells.at(-1)).toMatch(/ready, 1 comment\./)
    const { batch, jpeg } = await batchWithScreenshot()
    expect(batch.comments).toHaveLength(1)
    // The area is the box with a 32px margin, from (788, 368). Its corner shows the root's light background, not black.
    for (const channel of await pixelOf(jpeg, 4, 4)) expect(channel).toBeGreaterThan(235)
    // Both images come out as grey boxes, not red and not missing.
    for (const x of [850 - 788 + 30, 950 - 788 + 30]) {
      const [r, g, b] = await pixelOf(jpeg, x, 420 - 368 + 30)
      expect(Math.abs(r - g)).toBeLessThan(20)
      expect(Math.abs(g - b)).toBeLessThan(20)
      expect(r).toBeLessThan(240)
    }
  } finally {
    images.closeAllConnections()
    images.close()
  }
})

test('a screenshot of a dark page keeps its dark background', async () => {
  await page.goto(appUrl)
  // The marked area sits in a panel with no background of its own, so the screenshot shows what's behind it.
  await page.evaluate(() => {
    document.body.style.background = 'rgb(0, 0, 0)'
    document.body.style.color = '#fff'
    const panel = document.createElement('div')
    panel.style.cssText = 'position: fixed; left: 770px; top: 350px; width: 320px; height: 200px'
    document.body.append(panel)
  })
  if (await dock().isVisible()) await dock().getByRole('button', { name: 'Close' }).click()
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('dib-overlay .tools').getByRole('button', { name: 'Draw a box' }).click()
  await drag({ x: 820, y: 400 }, { x: 1040, y: 500 })
  const composer = page.locator('dib-overlay .composer')
  await composer.locator('textarea').fill('Lighter here')
  await composer.locator('.attach-shot').check()
  await composer.locator('textarea').press('Enter')
  await expect(composer).toBeHidden({ timeout: 10_000 })
  await page.keyboard.press('Escape')

  await page.keyboard.press('Alt+Shift+D')
  await dock().getByTestId('send').click()
  await expect.poll(() => doorbells.at(-1)).toMatch(/ready, 1 comment\./)
  const { jpeg } = await batchWithScreenshot()
  for (const channel of await pixelOf(jpeg, 4, 4)) expect(channel).toBeLessThan(20)
})

test('marks of a comment in the stack move with their element when the dock pushes the page', async () => {
  await page.goto(appUrl)
  if (await dock().isVisible()) await dock().getByRole('button', { name: 'Close' }).click()
  // Centred cards move when the page gets narrower; left-aligned ones would not show it.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.plans')!.style.justifyContent = 'center'
  })
  const card = page.locator('.plan').first()
  const drawnOn = (await card.boundingBox())!
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('dib-overlay .tools').getByRole('button', { name: 'Draw a box' }).click()
  await drag({ x: drawnOn.x + 12, y: drawnOn.y + 50 }, { x: drawnOn.x + drawnOn.width - 12, y: drawnOn.y + 120 })
  const composer = page.locator('dib-overlay .composer')
  await composer.locator('textarea').fill('Less padding in this card')
  await composer.locator('textarea').press('Enter')
  await expect(composer).toBeHidden()
  await page.keyboard.press('Escape')

  const mark = page.locator('dib-overlay .ink rect.mark.saved')
  const offsetFromCard = async () => {
    const markBox = (await mark.boundingBox())!
    const cardBox = (await card.boundingBox())!
    return { x: Math.round(markBox.x - cardBox.x), y: Math.round(markBox.y - cardBox.y) }
  }
  const drawnAt = await offsetFromCard()
  await page.keyboard.press('Alt+Shift+D')
  await expect(dock()).toBeVisible()
  expect((await card.boundingBox())!.x).toBeLessThan(drawnOn.x - 100)
  await expect.poll(offsetFromCard).toEqual(drawnAt)
})
