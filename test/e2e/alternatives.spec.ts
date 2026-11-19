// Alternatives end to end: the switcher on <Variants> groups (Before/After and paging), tweaks, a pick sent
// to the agent, and asking for alternatives from the comment card.
import { expect, test } from '@playwright/test'
import type { Batch } from '../../src/shared/protocol.ts'
import { appUrl, shim, page, doorbells, callTool, dock, useHarness } from './harness.ts'

useHarness()

test('alternatives: page through them, peek at Before, keep the choice across reloads', async () => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(new URL('/variants.html', appUrl).href)
  const hero = page.locator('dib-overlay .variant[data-group="hero"]')
  // Two alternatives: Before, plus pages through the alternatives. Before any pick, the first alternative shows.
  await expect(hero.getByTestId('variant-count')).toHaveText('1 / 2')
  await expect(hero.locator('.variant-label .steady-shown')).toHaveText('Tinted card')
  await expect(page.locator('h1')).toHaveText('Pricing that grows with you')

  // An alternative with its own state: switching away and back never throws.
  await page.locator('.counter').click()
  await expect(page.locator('.counter')).toHaveText('Clicked 1')
  // The switcher is placed at its full width and holds still while in use: the arrow stays under the pointer
  // from rest, through hover, to the next version with its different label.
  await hero.evaluate((switcher) => Promise.all(switcher.getAnimations().map((animation) => animation.finished)))
  const next = await hero.getByRole('button', { name: 'Next alternative' }).boundingBox()
  await hero.getByRole('button', { name: 'Next alternative' }).click()
  await expect(hero.getByTestId('variant-count')).toHaveText('2 / 2')
  await expect(page.locator('h1')).toHaveText('Pricing')
  expect(await hero.getByRole('button', { name: 'Next alternative' }).boundingBox()).toEqual(next)
  await hero.getByRole('button', { name: 'Next alternative' }).click()
  await expect(hero.locator('.variant-label .steady-shown')).toHaveText('Tinted card')

  // Before is always one click away, and paging from it returns to the alternative you left.
  await hero.getByRole('button', { name: 'Before', exact: true }).click()
  await expect(page.locator('h1')).toHaveText('Simple pricing')
  await expect(hero.getByRole('button', { name: 'Before', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await hero.getByRole('button', { name: 'Previous alternative' }).click()
  await expect(page.locator('h1')).toHaveText('Pricing that grows with you')
  await hero.getByRole('button', { name: 'Next alternative' }).click()
  await expect(hero.locator('.variant-label .steady-shown')).toHaveText('Compact')
  // The alternative's own segment, beside Before, toggles back to it. Left alone on Before, the switcher moves to
  // the corner Before's shape leaves free, and holds still there while Before and the alternative are flipped.
  await hero.getByRole('button', { name: 'Before', exact: true }).click()
  await page.mouse.move(5, 700)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const spot = await hero.getByRole('button', { name: 'Before', exact: true }).boundingBox()
  await expect(hero.getByRole('button', { name: 'Compact', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await hero.getByRole('button', { name: 'Compact', exact: true }).click()
  await expect(page.locator('h1')).toHaveText('Pricing')
  expect(await hero.getByRole('button', { name: 'Before', exact: true }).boundingBox()).toEqual(spot)
  await hero.getByRole('button', { name: 'Before', exact: true }).click()
  await expect(page.locator('h1')).toHaveText('Simple pricing')
  expect(await hero.getByRole('button', { name: 'Before', exact: true }).boundingBox()).toEqual(spot)
  await hero.getByRole('button', { name: 'Compact', exact: true }).click()
  await expect(hero.getByRole('button', { name: 'Compact', exact: true })).toHaveAttribute('aria-pressed', 'true')

  // One alternative: a Before/After toggle. The same group rendered twice has one switcher; both copies follow it.
  const cta = page.locator('dib-overlay .variant[data-group="plan-cta"]')
  await expect(cta).toHaveCount(1)
  await expect(cta.getByRole('button', { name: 'After', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.cta-outline')).toHaveCount(2)
  await cta.getByRole('button', { name: 'Before', exact: true }).click()
  await expect(page.locator('.cta-outline')).toHaveCount(0)

  await page.waitForTimeout(500)
  await page.reload()
  await expect(page.locator('dib-overlay .variant[data-group="hero"] .variant-label .steady-shown')).toHaveText('Compact')
  await expect(page.locator('.cta-outline')).toHaveCount(0)
  expect(errors).toEqual([])
})

test('alternatives: tweaks change the version live and stay set', async () => {
  const hero = page.locator('dib-overlay .variant[data-group="hero"]')
  await hero.getByRole('button', { name: 'Previous alternative' }).click()
  await expect(hero.locator('.variant-label .steady-shown')).toHaveText('Tinted card')
  // Tweaks and the pick button join the bar on hover.
  await hero.hover()
  await hero.getByRole('button', { name: 'Tweaks' }).click()
  const card = hero.locator('.tweaks')
  await expect(card).toBeVisible()
  await expect(page.getByTestId('badge')).toBeVisible()
  // The card never hides what it tweaks: none of the badge's or the heading's text is under it.
  const cardBox = (await card.boundingBox())!
  for (const target of [page.getByTestId('badge'), page.locator('h1')]) {
    const box = await target.evaluate((element) => {
      const range = document.createRange()
      range.selectNodeContents(element)
      const { x, y, width, height } = range.getBoundingClientRect()
      return { x, y, width, height }
    })
    const apart = cardBox.x >= box.x + box.width || cardBox.x + cardBox.width <= box.x || cardBox.y >= box.y + box.height || cardBox.y + cardBox.height <= box.y
    expect(apart).toBe(true)
  }
  await card.locator('input[data-tweak="badge"]').uncheck()
  await expect(page.getByTestId('badge')).toHaveCount(0)
  await card.locator('input[data-tweak="padding"]').fill('80')
  await expect(page.getByTestId('hero')).toHaveCSS('padding-top', '80px')
  await expect(card.locator('.range-value')).toHaveText('80px')
  await card.getByRole('button', { name: 'center' }).click()
  await expect(page.getByTestId('hero')).toHaveCSS('text-align', 'center')

  // Versions without tweaks show no card; back on this one it opens again.
  await hero.getByRole('button', { name: 'Before', exact: true }).click()
  await expect(card).toHaveCount(0)
  await hero.getByRole('button', { name: 'Tinted card', exact: true }).click()
  await expect(card).toBeVisible()
  await hero.getByRole('button', { name: 'Next alternative' }).click()
  await expect(card).toHaveCount(0)
  await hero.getByRole('button', { name: 'Previous alternative' }).click()
  await expect(card).toBeVisible()

  // The bar is rebuilt on every switch; a keyboard user stays on the control they used.
  await hero.getByRole('button', { name: 'Next alternative' }).focus()
  await page.keyboard.press('Enter')
  await expect(hero.locator('.variant-label .steady-shown')).toHaveText('Compact')
  await expect(hero.getByRole('button', { name: 'Next alternative' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(hero.locator('.variant-label .steady-shown')).toHaveText('Tinted card')

  await page.waitForTimeout(600)
  await page.reload()
  await expect(page.getByTestId('hero')).toHaveCSS('padding-top', '80px')
  await expect(page.getByTestId('badge')).toHaveCount(0)
})

test('alternatives: a pick sends the version with every tweak value, and the switcher waits', async () => {
  const before = doorbells.length
  const hero = page.locator('dib-overlay .variant[data-group="hero"]')
  await hero.hover()
  await hero.getByRole('button', { name: 'Use Tinted card' }).click()
  await expect(hero.locator('.variant-picked')).toHaveText('Picked “Tinted card” · waiting for Claude')
  await expect.poll(() => doorbells.length).toBe(before + 1)
  const batch = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  const pick = batch.comments[0]!
  expect(pick.intent).toEqual({
    kind: 'choose-variant',
    group: 'hero',
    index: 1,
    label: 'Tinted card',
    tweaks: [
      { id: 'padding', label: 'Padding', value: 80 },
      { id: 'badge', label: 'New badge', value: false },
      { id: 'align', label: 'Align', value: 'center' },
    ],
  })
  expect(pick.text).toBe('Use “Tinted card” for hero (Padding 80px, New badge off, Align center)')
  // The agent applies it; here the wrapper stays (nothing edits the fixture), so the switcher comes back.
  await callTool(shim, 'live_reply', { batchId: batch.id, replies: [{ commentId: pick.id, status: 'done', message: 'Tinted card is in, with your values.' }] })
  await expect(hero.getByTestId('variant-count')).toHaveText('1 / 2')
})

test('alternatives: ask for them, comment on a version, and see the agent hand them over', async () => {
  // Ask for one alternative of an element.
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('.plan').first().click({ position: { x: 20, y: 20 } })
  const composer = page.locator('dib-overlay .composer')
  await composer.getByRole('tab', { name: 'Alternatives' }).click()
  await composer.getByRole('button', { name: '1', exact: true }).click()
  await composer.locator('textarea').press('Enter')

  // A comment made inside a group carries its version and tweak values.
  await page.locator('[data-testid="hero"] h1').click()
  await composer.locator('textarea').fill('Tighter line height on this one')
  await composer.locator('textarea').press('Enter')
  await page.keyboard.press('Escape')

  if (await page.locator('dib-dock .launcher').isVisible()) await page.locator('dib-dock .launcher').click()
  await dock().getByTestId('send').click()
  await expect.poll(() => doorbells.at(-1)).toMatch(/ready, 2 comments/)
  const batch = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  const [ask, onVersion] = batch.comments
  expect(ask!.intent).toEqual({ kind: 'alternatives', count: 1 })
  expect(ask!.text).toBe('An alternative for this')
  expect(onVersion!.variant).toEqual({
    group: 'hero',
    index: 1,
    label: 'Tinted card',
    tweaks: [
      { id: 'padding', label: 'Padding', value: 80 },
      { id: 'badge', label: 'New badge', value: false },
      { id: 'align', label: 'Align', value: 'center' },
    ],
  })

  // The agent puts alternatives in the page and names the group: the dock links to its switcher.
  await callTool(shim, 'live_reply', {
    batchId: batch.id,
    replies: [
      { commentId: ask!.id, status: 'variants', message: 'One alternative is up: a wider card.', group: 'plan-cta' },
      { commentId: onVersion!.id, status: 'done', message: 'Line height is 1.1 on the tinted card.' },
    ],
  })
  await expect(dock().getByTestId('sent')).toContainText('One alternative is up: a wider card.')
  await expect(dock().getByTestId('show-group')).toHaveCount(1)
  await expect(page.locator('dib-overlay .pins .pin-wrap[data-status="variants"]')).toHaveCount(1)
})
