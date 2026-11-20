// Building the comments the page sends. Every comment gets its id and time here, and an answer always
// carries the question it answers, so a batch reads on its own.
import type { Batch, BatchComment, DraftComment, InReplyTo, Intent } from '../shared/protocol.ts'

type Fields = Pick<DraftComment, 'text' | 'page' | 'element'> & Partial<Pick<DraftComment, 'inReplyTo' | 'intent' | 'variant'>>

export function newComment(fields: Fields): DraftComment {
  const { inReplyTo = null, intent, variant, ...rest } = fields
  return {
    id: crypto.randomUUID(),
    ...rest,
    inReplyTo,
    ...(intent ? { intent } : {}),
    ...(variant ? { variant } : {}),
    createdAt: new Date().toISOString(),
  }
}

/** What an answer to the agent's question on `comment` points back to. */
export function answering(batch: Batch, comment: BatchComment): InReplyTo {
  return { batchId: batch.id, commentId: comment.id, comment: comment.text, question: comment.reply ?? '' }
}

type PickIntent = Extract<Intent, { kind: 'choose-variant' }>

/** A pick of one version of a `<Variants>` group. The switcher shows it, so it gets no pin. */
export function isPick<T extends { intent?: Intent }>(comment: T): comment is T & { intent: PickIntent } {
  return comment.intent?.kind === 'choose-variant'
}

/** Ids of the agent's questions that already have an answer, sent or still in the stack. */
export function answeredIds(draft: DraftComment[], batches: Batch[]): Set<string> {
  const ids = new Set<string>()
  for (const comment of [...draft, ...batches.flatMap((batch) => batch.comments)])
    if (comment.inReplyTo) ids.add(comment.inReplyTo.commentId)
  return ids
}

/** The pick of a `<Variants>` group, sent or still in the stack: once there is one, its alternatives are settled. */
export function pickOf(group: string, draft: DraftComment[], batches: Batch[]): PickIntent | null {
  for (const comment of [...draft, ...batches.flatMap((batch) => batch.comments)])
    if (isPick(comment) && comment.intent.group === group) return comment.intent
  return null
}

/**
 * The agent's question or note no longer waits on the user: answered, dismissed, or (for alternatives) picked. The
 * comment keeps its reply in the dock but loses its pin on the page.
 */
export function settled(comment: BatchComment, state: { draft: DraftComment[]; batches: Batch[]; dismissed: string[] }): boolean {
  if (comment.status === 'done' || comment.status === 'skipped') return true
  if (state.dismissed.includes(comment.id)) return true
  if (comment.status === 'variants') return comment.group !== undefined && pickOf(comment.group, state.draft, state.batches) !== null
  return false
}
