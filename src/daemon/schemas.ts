import { z } from 'zod'
import type { DraftComment } from '../shared/protocol.ts'

const shownVersion = z.object({
  group: z.string().max(100),
  index: z.number().int().min(0).max(10),
  label: z.string().max(200),
  tweaks: z
    .array(z.object({ id: z.string().max(60), label: z.string().max(100), value: z.union([z.boolean(), z.number(), z.string().max(200)]) }))
    .max(12),
})

const point = z.object({ x: z.number(), y: z.number() })

const mark = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('box'), x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  z.object({ kind: z.literal('arrow'), from: point, to: point }),
  z.object({ kind: z.literal('pen'), points: z.array(point).max(2000) }),
])

/** A cropped screenshot, as a JPEG data URL. 8 MB of base64 is far more than a crop of one window needs. */
export const SCREENSHOT_PREFIX = 'data:image/jpeg;base64,'
const screenshot = z.string().startsWith(SCREENSHOT_PREFIX).max(8_000_000)

const rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })

const elementRef = z.object({
  selector: z.string().max(2000),
  tag: z.string().max(100),
  id: z.string().max(500).nullable(),
  classes: z.array(z.string().max(500)).max(100),
  text: z.string().max(500),
  html: z.string().max(10_000),
  rect,
  styles: z.record(z.string(), z.string().max(500)),
  ancestors: z.array(z.string().max(300)).max(10),
  // Comments saved before source locations existed have none.
  sources: z.array(z.string().max(500)).max(5).default([]),
  clickOffset: z.object({ x: z.number(), y: z.number() }).optional(),
})

// Annotated so a change to DraftComment that this schema misses is a type error.
export const draftCommentSchema: z.ZodType<DraftComment> = z.object({
  id: z.string().max(100),
  text: z.string().min(1).max(5000),
  page: z.object({
    url: z.string().max(2000),
    title: z.string().max(500),
    viewport: z.object({ width: z.number(), height: z.number() }),
  }),
  element: elementRef.nullable(),
  intent: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('alternatives'), count: z.number().int().min(1).max(4) }),
      shownVersion.extend({ kind: z.literal('choose-variant') }),
    ])
    .optional(),
  variant: shownVersion.optional(),
  marks: z.array(mark).max(50).optional(),
  screenshot: screenshot.optional(),
  inReplyTo: z
    .object({
      batchId: z.string().max(20),
      commentId: z.string().max(100),
      comment: z.string().max(5000),
      question: z.string().max(5000),
    })
    .nullable(),
  createdAt: z.string().max(100),
})
