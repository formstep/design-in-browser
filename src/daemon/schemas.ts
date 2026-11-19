import { z } from 'zod'
import type { DraftComment } from '../shared/protocol.ts'

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
      z.object({
        kind: z.literal('choose-variant'),
        group: z.string().max(100),
        index: z.number().int().min(0).max(10),
        label: z.string().max(200),
        tweaks: z.array(z.object({ id: z.string().max(60), label: z.string().max(100), value: z.union([z.boolean(), z.number(), z.string().max(200)]) })).max(12),
      }),
    ])
    .optional(),
  variant: z
    .object({
      group: z.string().max(100),
      index: z.number().int().min(0).max(10),
      label: z.string().max(200),
      tweaks: z.array(z.object({ id: z.string().max(60), label: z.string().max(100), value: z.union([z.boolean(), z.number(), z.string().max(200)]) })).max(12),
    })
    .optional(),
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
