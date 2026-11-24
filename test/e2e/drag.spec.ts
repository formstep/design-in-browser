// Moving what covers the page: the switcher, the comment card, a pin's thread and the dock's launcher drag aside
// and keep their spot, and Alt+Shift+H hides everything on the page until pressed again.
import { expect, test, type Locator } from '@playwright/test'
import { appUrl, comment, dock, page, useHarness } from './harness.ts'

useHarness()

/** Presses on `handle` and moves the pointer by (dx, dy) in steps, as a hand would. */
async function drag(handle: Locator, dx: number, dy: number): Promise<void> {
  const box = (await handle.boundingBox())!
  const x = box.x + Math.min(8, box.width / 2)
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 8 })
  await page.mouse.up()
}

const at = async (locator: Locator) => {
  const box = (await locator.boundingBox())!
  return { x: Math.round(box.x), y: Math.round(box.y) }
}

test('the switcher drags aside, keeps its spot from its group, and a double-click puts it back', async () => {
  await page.goto(new URL('/variants.html', appUrl).href)
  const hero = page.locator('dib-overlay .variant[data-group="hero"]')
  const bar = hero.locator('.variant-bar')
  await hero.evaluate((switcher) => Promise.all(switcher.getAnimations().map((animation) => animation.finished)))
  const placedAt = await at(bar)

  await drag(hero.locator('.variant-group'), 120, 160)
  const draggedTo = await at(bar)
  expect(draggedTo.x).toBe(placedAt.x + 120)
  expect(draggedTo.y).toBe(placedAt.y + 160)
  // The drag's release clicked nothing, and the spot holds once the pointer has left and the periodic render ran.
  await expect(hero.getByTestId('variant-count')).toHaveText('1 / 2')
  await page.mouse.move(5, 700)
  await page.waitForTimeout(1000)
  expect(await at(bar)).toEqual(draggedTo)

  // It follows its group as the page scrolls.
  const heading = page.locator('[data-testid="hero"] h1')
  const gap = async () => (await at(bar)).y - (await at(heading)).y
  const before = await gap()
  await page.evaluate(() => {
    document.body.style.minHeight = '3000px'
    window.scrollTo(0, 40)
  })
  await expect.poll(gap).toBe(before)
  await page.evaluate(() => window.scrollTo(0, 0))

  // With Tweaks open, a drag to the window's bottom edge brings the card along, and it stays inside the window.
  await hero.hover()
  await hero.getByRole('button', { name: 'Tweaks' }).click()
  const card = hero.locator('.tweaks')
  await expect(card).toBeVisible()
  await drag(hero.locator('.variant-group'), 0, 2000)
  await page.mouse.move(5, 5)
  await page.waitForTimeout(1000)
  const viewport = page.viewportSize()!
  const cardBox = (await card.boundingBox())!
  expect(cardBox.y).toBeGreaterThanOrEqual(0)
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(viewport.height)
  await hero.getByRole('button', { name: 'Tweaks' }).click()
  await expect(card).toHaveCount(0)

  // Its buttons still work, and a double-click on the bar outside them gives the spot back to placement.
  await hero.getByRole('button', { name: 'Next alternative' }).click()
  await expect(hero.getByTestId('variant-count')).toHaveText('2 / 2')
  await hero.getByRole('button', { name: 'Previous alternative' }).click()
  await hero.locator('.variant-group').dblclick()
  await page.mouse.move(5, 700)
  await expect.poll(() => at(bar)).toEqual(placedAt)
})

test('Alt+Shift+H hides the switchers, pins and drawings, and shows them again', async () => {
  // The layer is an empty box around fixed switchers: what shows is the switcher.
  const layer = page.locator('dib-overlay .variant[data-group="hero"]')
  const toggle = dock().getByTestId('markers')
  await expect(layer).toBeVisible()
  await page.keyboard.press('Alt+Shift+H')
  await expect(layer).toBeHidden()
  await expect(page.locator('dib-overlay .pins')).toHaveAttribute('hidden', '')
  // The version shown stays while its switcher is hidden.
  await expect(page.locator('[data-testid="hero"] h1')).toHaveText('Pricing that grows with you')
  await page.locator('dib-dock .launcher').click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAccessibleName('Show everything on the page')
  await page.keyboard.press('Alt+Shift+H')
  await expect(layer).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')

  // While picking, hiding steps out of it first, so clicks on the page aren't taken by a picker nobody sees.
  await page.keyboard.press('Alt+Shift+C')
  await expect(page.locator('dib-overlay .toolbar')).toBeVisible()
  await page.keyboard.press('Alt+Shift+H')
  await expect(page.locator('dib-overlay .toolbar')).toBeHidden()
  await expect(layer).toBeHidden()
  await toggle.click()
  await expect(layer).toBeVisible()
  await dock().getByRole('button', { name: 'Close' }).click()
})

test('the comment card drags off what it covers and keeps the text being typed', async () => {
  await page.keyboard.press('Alt+Shift+C')
  await page
    .locator('.plan')
    .first()
    .click({ position: { x: 20, y: 20 } })
  const composer = page.locator('dib-overlay .composer')
  await expect(composer).toBeVisible()
  await composer.locator('textarea').fill('Less padding')
  await composer.evaluate((card) => Promise.all(card.getAnimations().map((animation) => animation.finished)))
  const placedAt = await at(composer)
  await drag(composer.locator('.target'), -60, 90)
  expect(await at(composer)).toEqual({ x: placedAt.x - 60, y: placedAt.y + 90 })
  await expect(composer.locator('textarea')).toBeFocused()
  await page.keyboard.type(' here')
  await expect(composer.locator('textarea')).toHaveValue('Less padding here')
  await page.waitForTimeout(1000)
  expect(await at(composer)).toEqual({ x: placedAt.x - 60, y: placedAt.y + 90 })
  // Hiding everything puts the card away; showing it again brings it back with the text, where it was dragged.
  await page.keyboard.press('Alt+Shift+H')
  await expect(composer).toBeHidden()
  await expect(page.locator('dib-overlay .toolbar')).toBeHidden()
  await page.keyboard.press('Alt+Shift+H')
  await expect(composer).toBeVisible()
  await expect(composer.locator('textarea')).toHaveValue('Less padding here')
  await composer.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)))
  expect(await at(composer)).toEqual({ x: placedAt.x - 60, y: placedAt.y + 90 })
  // Dragged past the window's edge, it stops there, and dragging back moves it at once.
  const edge = await at(composer)
  await drag(composer.locator('.target'), -500, 0)
  expect((await at(composer)).x).toBe(8)
  await drag(composer.locator('.target'), 30, 0)
  expect((await at(composer)).x).toBe(38)
  expect(edge.x).toBeGreaterThan(8)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
})

test('a pin’s thread drags by its top edge, stays open there, and a double-click puts it back', async () => {
  await page.keyboard.press('Alt+Shift+C')
  await comment('.plan h2', 'Bigger plan names')
  await page.keyboard.press('Escape')
  const wrap = page.locator('dib-overlay .pins .pin-wrap').first()
  const thread = wrap.locator('.thread')
  await wrap.locator('.pin').click()
  await expect(thread).toBeVisible()
  await thread.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)))
  const placedAt = await at(thread)
  await drag(thread.locator('.entry-head').first(), 140, 60)
  expect(await at(thread)).toEqual({ x: placedAt.x + 140, y: placedAt.y + 60 })
  // Open after the pointer left the pin and the periodic render ran.
  await page.mouse.move(5, 700)
  await page.waitForTimeout(1000)
  await expect(thread).toBeVisible()
  expect(await at(thread)).toEqual({ x: placedAt.x + 140, y: placedAt.y + 60 })
  await thread.locator('.entry-head').first().dblclick()
  expect(await at(thread)).toEqual(placedAt)
})

test('the launcher drags out of the corner, opens nothing on the drag, and keeps its spot across reloads', async () => {
  const launcher = page.locator('dib-dock .launcher')
  await expect(dock()).toBeHidden()
  const placedAt = await at(launcher)
  await drag(launcher, -300, -200)
  const draggedTo = await at(launcher)
  expect(draggedTo).toEqual({ x: placedAt.x - 300, y: placedAt.y - 200 })
  await expect(dock()).toBeHidden()

  await page.reload()
  expect(await at(launcher)).toEqual(draggedTo)
  // Never past the window's edge, however far it is dragged.
  await drag(launcher, 2000, 2000)
  const viewport = page.viewportSize()!
  const box = (await launcher.boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 8)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 8)
  // A plain click still opens the dock.
  await launcher.click()
  await expect(dock()).toBeVisible()
  await dock().getByRole('button', { name: 'Close' }).click()
})
