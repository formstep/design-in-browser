// The journal is the durable record: one folder per project, inside the project itself.
//   <projectRoot>/.design-in-browser/
//     .gitignore        "*", so the folder never shows up in git
//     batches/001.json  one file per batch, rewritten on every change
//     journal.jsonl     append-only event log
//     screenshots/      cropped screenshots sent with comments, one JPEG per comment
import fs from 'node:fs'
import path from 'node:path'
import type { Batch } from '../shared/protocol.ts'
import { FALLBACK_AGENT, PRODUCT_NAME } from '../shared/protocol.ts'

export const journalDir = (projectRoot: string) => path.join(projectRoot, `.${PRODUCT_NAME}`)
const batchesDir = (projectRoot: string) => path.join(journalDir(projectRoot), 'batches')
const batchPath = (projectRoot: string, batchId: string) => path.join(batchesDir(projectRoot), `${batchId}.json`)

export function ensureJournal(projectRoot: string): string {
  const dir = journalDir(projectRoot)
  fs.mkdirSync(batchesDir(projectRoot), { recursive: true })
  const gitignore = path.join(dir, '.gitignore')
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n')
  return dir
}

/** Writes a comment's screenshot (a JPEG data URL) to the journal, and returns its path inside the journal folder. */
export function writeScreenshot(projectRoot: string, commentId: string, dataUrl: string): string {
  const file = `screenshots/${commentId.replace(/[^\w-]/g, '')}.jpg`
  fs.mkdirSync(path.join(journalDir(projectRoot), 'screenshots'), { recursive: true })
  fs.writeFileSync(path.join(journalDir(projectRoot), file), Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
  return file
}

export function appendEvent(projectRoot: string, event: Record<string, unknown>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event })
  fs.appendFileSync(path.join(journalDir(projectRoot), 'journal.jsonl'), line + '\n')
}

export function nextBatchId(projectRoot: string): string {
  const numbers = fs
    .readdirSync(batchesDir(projectRoot))
    .map((name) => /^(\d+)\.json$/.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
  const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1
  return String(next).padStart(3, '0')
}

export function writeBatch(batch: Batch): void {
  const file = batchPath(batch.projectRoot, batch.id)
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(batch, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

export function readBatches(projectRoot: string): Batch[] {
  const dir = batchesDir(projectRoot)
  if (!fs.existsSync(dir)) return []
  return (
    fs
      .readdirSync(dir)
      .filter((name) => /^\d+\.json$/.test(name))
      .sort()
      // Batches written before agents were named have no `agent`, and before agent notes no `from`.
      .map((name) => ({
        agent: FALLBACK_AGENT,
        from: 'user' as const,
        ...(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Omit<Batch, 'agent' | 'from'>),
      }))
  )
}
