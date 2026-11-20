// Comments end to end: pick an element, stack comments, send them, and see the agent's replies on the page
// and in the dock, including answering its questions and the session the dock sends to.
import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Batch } from '../../src/shared/protocol.ts'
import {
  tmp,
  appUrl,
  shim,
  context,
  page,
  doorbells,
  stopAppServer,
  startAppServer,
  callTool,
  startShim,
  dock,
  comment,
  useHarness,
  armListener,
  killDaemon,
} from './harness.ts'

useHarness()

test('pick, comment, send, and see the reply on the page', async () => {
  await page.goto(appUrl)
  await expect(page.locator('dib-overlay')).toBeAttached()
  await page.locator('dib-dock .launcher').click()
  await expect(dock().getByTestId('status')).toContainText('Claude is listening')

  // Clicks while picking or commenting never reach the app.
  await page.locator('h1').hover()
  await page.keyboard.press('Alt+Shift+C')
  await expect(page.locator('dib-overlay .tools')).toBeVisible()
  await page.locator('h1').click()
  await expect(page.locator('dib-overlay .composer .target')).toContainText('h1 “Simple pricing”')
  await page.locator('[data-testid="starter-cta"]').click()
  await expect(page.locator('dib-overlay .composer .target')).toContainText('button “Start free”')
  await expect(page.locator('#clicks')).toHaveText('0')
  await page.keyboard.press('Escape')

  // Each comment goes to the agent on Enter, as its own batch.
  await comment('h1', 'Make the headline bolder and larger')
  await comment('[data-testid="starter-cta"]', 'Use the accent color for the free plan button')
  await page.keyboard.press('Escape')
  await expect(page.locator('dib-overlay .tools')).toBeHidden()
  const pins = page.locator('dib-overlay .pins .pin-wrap:not([hidden])')
  await expect
    .poll(() => pins.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.status)))
    .toEqual(['pending', 'pending'])
  await page.locator('[data-testid="starter-cta"]').click()
  await expect(page.locator('#clicks')).toHaveText('1')
  await expect.poll(() => doorbells.at(-1)).toBe('design-in-browser: batch 002 ready, 1 comment. Call live_get_batch.')

  const headline = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  const button = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  expect([...headline.comments, ...button.comments].map((c) => [c.element?.selector, c.text])).toEqual([
    ['h1', 'Make the headline bolder and larger'],
    ['button[data-testid="starter-cta"]', 'Use the accent color for the free plan button'],
  ])
  expect(button.comments[0]!.element!.ancestors).toEqual(['article.plan', 'div.plans', 'main', 'div#root'])
  // The plugin stamps where each element's JSX is written. The fixture's source sits outside this test's project
  // folder, so its path is absolute.
  expect(button.comments[0]!.element!.sources).toEqual([expect.stringMatching(/\/test\/e2e\/app\/src\/main\.tsx:16:\d+$/)])
  expect(button.comments[0]!.element!.html).not.toContain('data-dib-src')
  await expect(dock().getByTestId('sent')).toContainText('Working on it')
  await callTool(shim, 'live_reply', {
    batchId: headline.id,
    replies: [{ commentId: headline.comments[0]!.id, status: 'done', message: 'Headline is now 40px, weight 800.' }],
  })
  await callTool(shim, 'live_reply', {
    batchId: button.id,
    replies: [{ commentId: button.comments[0]!.id, status: 'question', message: 'Accent purple or the green from the logo?' }],
  })
  await expect(dock().getByTestId('sent')).toContainText('Headline is now 40px, weight 800.')
  // A done comment drops its pin; the question keeps one, to answer from the page.
  await expect.poll(() => pins.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.status))).toEqual(['question'])
})

test('answer a question from the dock and from a pin: one pin carries the thread', async () => {
  const pins = page.locator('dib-overlay .pins .pin-wrap:not([hidden])')
  const field = dock().getByTestId('answer-field')
  await field.fill('Accent')
  await dock().getByTestId('message').fill('A note in progress')
  await page.waitForTimeout(2000)
  await expect(field).toHaveValue('Accent')
  await expect(dock().getByTestId('message')).toHaveValue('A note in progress')
  await dock().getByTestId('message').fill('')
  // The answer goes to the agent on Enter.
  await field.fill('Accent purple')
  await field.press('Enter')
  await expect.poll(() => doorbells.at(-1)).toBe('design-in-browser: batch 003 ready, 1 comment. Call live_get_batch.')
  const answer = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  expect(answer.comments[0]!.inReplyTo?.batchId).toBe('002')
  await expect(dock().getByTestId('sent')).toContainText('You answered at')
  // The answer joins the question's pin: still one pin, now waiting on the agent.
  await expect.poll(() => pins.evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.status))).toEqual(['pending'])

  await callTool(shim, 'live_reply', {
    batchId: answer.id,
    replies: [{ commentId: answer.comments[0]!.id, status: 'question', message: 'Which shade, 500 or 600?' }],
  })
  const asking = page.locator('dib-overlay .pin-wrap[data-status="question"]')
  await expect(asking).toHaveCount(1)
  await asking.locator('.pin').click()
  // The whole exchange, in order, in the one pin.
  await expect(asking.locator('.thread .entry-text')).toHaveText([
    'Use the accent color for the free plan button',
    'Accent purple or the green from the logo?',
    'Accent purple',
    'Which shade, 500 or 600?',
  ])
  // On a short window the card still opens fully on screen.
  await page.setViewportSize({ width: 1100, height: 420 })
  await page.waitForTimeout(1000)
  const box = (await asking.locator('.thread').boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(8)
  expect(box.y + box.height).toBeLessThanOrEqual(420 - 8)
  await page.setViewportSize({ width: 1100, height: 720 })
  await page.waitForTimeout(1000)
  await asking.getByRole('textbox', { name: 'Answer Claude' }).fill('600')
  await asking.getByRole('textbox', { name: 'Answer Claude' }).press('Enter')
  await expect.poll(() => doorbells.at(-1)).toBe('design-in-browser: batch 004 ready, 1 comment. Call live_get_batch.')
  const shade = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  expect(shade.comments[0]!.inReplyTo?.commentId).toBe(answer.comments[0]!.id)

  // The agent acts on the answers and closes the thread: the pin leaves the page, the dock keeps the replies.
  await callTool(shim, 'live_reply', {
    batchId: shade.id,
    replies: [{ commentId: shade.comments[0]!.id, status: 'done', message: 'The free plan button is accent purple 600 now.' }],
  })
  await expect(pins).toHaveCount(0)
  await expect(dock().getByTestId('sent')).toContainText('The free plan button is accent purple 600 now.')
})

test('the Ask bar, a comment and a dock message each reach the agent on their own', async () => {
  // "Ask Claude" in the tool pill sends a note about the whole page.
  const before = doorbells.length
  await page.keyboard.press('Alt+Shift+C')
  await page.locator('dib-overlay .tool.ask').click()
  await page.locator('dib-overlay .askbar input').fill('Less crowded overall')
  await page.locator('dib-overlay .askbar input').press('Enter')
  await expect(page.locator('dib-overlay .askbar')).toBeHidden()
  await expect.poll(() => doorbells.length).toBe(before + 1)
  const asked = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  expect(asked.comments.map((c) => [c.element, c.text])).toEqual([[null, 'Less crowded overall']])

  // A comment on an element: no box to tick, Enter sends it.
  await page.locator('.lede').click()
  const composer = page.locator('dib-overlay .composer')
  await expect(composer.locator('.hint')).toHaveText('Enter to send')
  await composer.locator('textarea').fill('Shorter subtitle')
  await composer.locator('textarea').press('Enter')
  await page.keyboard.press('Escape')
  await expect.poll(() => doorbells.length).toBe(before + 2)
  const commented = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  expect(commented.comments.map((c) => [c.element?.tag ?? null, c.text])).toEqual([['p', 'Shorter subtitle']])

  // A message typed in the dock goes as a page note on Enter, and the field empties once it's sent.
  await dock().getByTestId('message').fill('Just a note')
  await dock().getByTestId('message').press('Enter')
  await expect.poll(() => doorbells.length).toBe(before + 3)
  const note = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  expect(note.comments.map((c) => [c.element, c.text])).toEqual([[null, 'Just a note']])
  await expect(dock().getByTestId('message')).toHaveValue('')
  for (const batch of [asked, commented, note])
    await callTool(shim, 'live_reply', {
      batchId: batch.id,
      replies: [{ commentId: batch.comments[0]!.id, status: 'done', message: 'Done.' }],
    })
})

test('a thread survives a reload and a dev-server restart, and every tab shows it', async () => {
  await page.keyboard.press('Alt+Shift+C')
  await comment('.lede', 'Tighter subtitle')
  await page.keyboard.press('Escape')
  const pin = page.locator('dib-overlay .pins .pin-wrap[data-status="pending"]:not([hidden])')
  await expect(pin).toHaveCount(1)

  const other = await context.newPage()
  await other.goto(appUrl)
  await expect(other.locator('dib-overlay .pins .pin-wrap[data-status="pending"]:not([hidden])')).toHaveCount(1)

  await page.reload()
  await expect(pin).toHaveCount(1)

  // Vite reloads open pages when its server comes back.
  await stopAppServer()
  await startAppServer()
  await page.waitForTimeout(1500)
  await page.goto(appUrl)
  await expect(pin).toHaveCount(1)
  await expect(dock().getByTestId('sent')).toContainText('Tighter subtitle')
  const batch = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  await callTool(shim, 'live_reply', {
    batchId: batch.id,
    replies: [{ commentId: batch.comments[0]!.id, status: 'done', message: 'Tighter.' }],
  })
  await expect(pin).toHaveCount(0)
  await other.close()
})

test('the dock picks the session working on this project and keeps a manual pick', async () => {
  const elsewhere = path.join(tmp, 'elsewhere')
  fs.mkdirSync(elsewhere)
  const second = await startShim('opencode', elsewhere)
  try {
    const select = dock().getByTestId('session')
    await expect(select.locator('option')).toHaveCount(2)
    // The session on this project is chosen; the other is only an option.
    await expect(dock().locator('.picker-text')).toHaveText('project · Claude')
    const secondId = (JSON.parse(await callTool(second, 'live_status')) as { sessionId: string }).sessionId
    await select.selectOption(secondId)
    await page.waitForTimeout(2000)
    await expect(dock().locator('.picker-text')).toHaveText('elsewhere · OpenCode')
    await dock().getByTestId('message').fill('For the other agent')
    await dock().getByTestId('message').press('Enter')
    await expect.poll(async () => JSON.parse(await callTool(second, 'live_status')).unfetched.length).toBe(1)
    expect(await callTool(shim, 'live_get_batch')).toBe('No unfetched batch.')
  } finally {
    await second.close()
  }
  // With the picked session gone, the dock falls back to the session on this project.
  await expect(dock().locator('.project')).toHaveText('project')
})

test('the agent leaves notes on the page, and a note that asks takes an answer from its pin', async () => {
  await page.goto(appUrl)
  const lede = await page.locator('.lede').getAttribute('data-dib-src')
  expect(lede).toBeTruthy()
  await callTool(shim, 'live_note', {
    url: appUrl,
    notes: [
      { selector: 'h1', note: 'The headline is 40px now.' },
      { source: lede, note: 'Should the subtitle be shorter?', question: true },
    ],
  })

  // Each note is a pin on its element, found by selector or by source location, with the agent's words alone.
  const note = page.locator('dib-overlay .pins .pin-wrap[data-status="note"]:not([hidden])')
  await expect(note).toHaveCount(1)
  await note.locator('.pin').click()
  await expect(note.locator('.thread')).toContainText('The headline is 40px now.')
  await expect(note.locator('.entry')).toHaveCount(1)
  // Starting to comment puts the card away, though the mouse is still on the pin: it would cover what you pick.
  await page.keyboard.press('Alt+Shift+C')
  await expect(note.locator('.thread')).toBeHidden()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')

  // The dock shows the notes as the agent's own turn.
  await expect(dock().locator('article[data-from="agent"]')).toContainText('Should the subtitle be shorter?')

  const asking = page
    .locator('dib-overlay .pins .pin-wrap[data-status="question"]:not([hidden])')
    .filter({ hasText: 'Should the subtitle be shorter?' })
  await asking.locator('.pin').click()
  await asking.getByRole('textbox', { name: 'Answer Claude' }).fill('Yes, cut it to five words')
  await asking.getByRole('textbox', { name: 'Answer Claude' }).press('Enter')
  await expect.poll(() => doorbells.at(-1)).toMatch(/ready, 1 comment/)
  const answer = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  expect(answer.comments[0]!.inReplyTo?.question).toBe('Should the subtitle be shorter?')
  expect(answer.comments[0]!.element?.text).toBe('One plan for every team.')
})

test('on a phone-width window the dock covers it, the overlay steps back, and the toolbar fits', async () => {
  await page.setViewportSize({ width: 390, height: 844 })
  try {
    await page.goto(appUrl)
    if (await page.locator('dib-dock .launcher').isVisible()) await page.locator('dib-dock .launcher').click()
    await dock().evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)))
    const dockBox = (await dock().boundingBox())!
    expect(dockBox.x).toBe(0)
    expect(dockBox.width).toBe(390)
    await expect(page.locator('dib-overlay')).toHaveCSS('visibility', 'hidden')

    await page.locator('dib-dock .close').click()
    await expect(page.locator('dib-overlay')).toHaveCSS('visibility', 'visible')
    await page.keyboard.press('Alt+Shift+C')
    const tools = (await page.locator('dib-overlay .tools').boundingBox())!
    const launcher = (await page.locator('dib-dock .launcher').boundingBox())!
    expect(tools.x).toBeGreaterThanOrEqual(0)
    expect(tools.x + tools.width).toBeLessThanOrEqual(390)
    // Above the launcher, not under it.
    expect(tools.y + tools.height).toBeLessThanOrEqual(launcher.y)
    await page.keyboard.press('Escape')
  } finally {
    await page.setViewportSize({ width: 1100, height: 720 })
  }
})

test('when the daemon crashes, the dock says so, and comes back with the session on its own', async () => {
  await page.goto(appUrl)
  if (await page.locator('dib-dock .launcher').isVisible()) await page.locator('dib-dock .launcher').click()
  await expect(dock().getByTestId('status')).toHaveText('Claude is listening')
  await killDaemon()
  await expect(dock().getByTestId('status')).not.toHaveText('Claude is listening')
  // The MCP server starts a daemon and registers again by itself; the page's plugin reconnects to it.
  await expect(dock().getByTestId('status')).toHaveText('Not listening', { timeout: 15_000 })
  // The Monitor re-arms on the same URL, as the skill says after a close.
  await expect
    .poll(
      () =>
        armListener().then(
          () => true,
          () => false
        ),
      { timeout: 10_000 }
    )
    .toBe(true)
  await expect(dock().getByTestId('status')).toHaveText('Claude is listening')
  const rung = doorbells.length
  await dock().getByTestId('message').fill('Still here after a crash')
  await dock().getByTestId('message').press('Enter')
  await expect.poll(() => doorbells.length).toBeGreaterThan(rung)
  expect(doorbells.at(-1)).toMatch(/ready, 1 comment/)
  const batch = JSON.parse(await callTool(shim, 'live_get_batch')) as Batch
  expect(batch.comments[0]!.text).toBe('Still here after a crash')
})
