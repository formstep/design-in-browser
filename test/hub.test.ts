// The Vite plugin's hub keeps the comment stack and the user's choices in .design-in-browser/page-state.<app>.json.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Batch } from '../src/shared/protocol.ts'
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

test('each app sees the batches made on its own dev server, and starting over clears all but those in progress', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dib-hub-'))
  const hub = new Hub(project, project, () => {})
  // Read through a function: an assertion on the field would narrow it to null for the rest of the test.
  const cleared = () => hub.state.cleared
  assert.equal(cleared(), null)
  // Stands in for start(port) without connecting to a daemon.
  hub['port'] = '3000'
  const batch = (id: string, port: number, status: Batch['status'], createdAt: string): Batch =>
    ({
      id,
      projectRoot: project,
      sessionId: 's-1',
      agent: 'Claude',
      from: 'user',
      status,
      createdAt,
      comments: [
        {
          id: `c-${id}`,
          text: 'x',
          page: { url: `http://localhost:${port}/`, title: '' },
          element: null,
          inReplyTo: null,
          createdAt,
          status: 'done',
          reply: null,
        },
      ],
    }) as unknown as Batch
  hub['handle']({
    type: 'state',
    sessions: [],
    batches: [
      batch('001', 3000, 'done', '2026-01-01T00:00:00Z'),
      batch('002', 3002, 'done', '2026-01-02T00:00:00Z'),
      batch('003', 3000, 'fetched', '2026-01-03T00:00:00Z'),
    ],
  })
  assert.deepEqual(
    hub.state.batches.map((entry) => entry.id),
    ['003', '001']
  )

  assert.equal(hub.apply({ type: 'start-over' }), null)
  assert.deepEqual(
    hub.state.batches.map((entry) => entry.id),
    ['003']
  )
  assert.deepEqual(cleared()?.keep, ['003'])
  assert.deepEqual(new Hub(project, project, () => {}).state.cleared?.keep, ['003'])
})
