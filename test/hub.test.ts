// The Vite plugin's hub keeps the comment stack and the user's choices in .design-in-browser/page-state.<app>.json.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Hub } from '../src/vite/hub.ts'

test('a page-state file from an older release loads, and a dismissal is kept in it', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dib-hub-'))
  const saved = path.join(project, '.design-in-browser', 'page-state.root.json')
  fs.mkdirSync(path.dirname(saved), { recursive: true })
  // As 0.5.0 wrote it: no list of dismissed comments.
  fs.writeFileSync(
    saved,
    JSON.stringify({ draft: [], pickedSessionId: null, sendOnAdd: true, variantChoices: { hero: 1 }, tweakValues: {} })
  )

  const hub = new Hub(project, project, () => {})
  assert.deepEqual(hub.state.dismissed, [])
  assert.equal(hub.state.sendOnAdd, true)
  assert.deepEqual(hub.state.variantChoices, { hero: 1 })

  assert.equal(hub.apply({ type: 'dismiss', commentId: 'c-1' }), null)
  assert.equal(hub.apply({ type: 'dismiss', commentId: 'c-1' }), null)
  assert.deepEqual(hub.state.dismissed, ['c-1'])
  assert.deepEqual(JSON.parse(fs.readFileSync(saved, 'utf8')).dismissed, ['c-1'])
  assert.deepEqual(new Hub(project, project, () => {}).state.dismissed, ['c-1'])
})
