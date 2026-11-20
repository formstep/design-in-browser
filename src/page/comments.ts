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

/** Ids of the agent's questions that already have an answer. */
export function answeredIds(batches: Batch[]): Set<string> {
  const ids = new Set<string>()
  for (const comment of batches.flatMap((batch) => batch.comments)) if (comment.inReplyTo) ids.add(comment.inReplyTo.commentId)
  return ids
}

/** The pick of a `<Variants>` group: once there is one, its alternatives are settled. */
export function pickOf(group: string, batches: Batch[]): PickIntent | null {
  for (const comment of batches.flatMap((batch) => batch.comments))
    if (isPick(comment) && comment.intent.group === group) return comment.intent
  return null
}

/**
 * The agent's question or note no longer waits on the user: answered, dismissed, or (for alternatives) picked. The
 * comment keeps its reply in the dock but loses its pin on the page.
 */
export function settled(comment: BatchComment, state: { batches: Batch[]; dismissed: string[] }): boolean {
  if (comment.status === 'done' || comment.status === 'skipped') return true
  if (state.dismissed.includes(comment.id)) return true
  if (comment.status === 'variants') return comment.group !== undefined && pickOf(comment.group, state.batches) !== null
  return false
}

export type Sent = { batch: Batch; comment: BatchComment }

/**
 * The batches' comments as threads: an answer (`inReplyTo`) joins the thread of the comment it answers. Each thread
 * starts at its earliest comment still in view (starting over, or the 30 newest batches, can leave out the first).
 */
export function threads(batches: Batch[]): Sent[][] {
  const all = batches.flatMap((batch) => batch.comments.map((comment) => ({ batch, comment })))
  const byId = new Map(all.map((sent) => [sent.comment.id, sent]))
  const rootOf = (sent: Sent): string => {
    const seen = new Set<string>()
    let at = sent
    for (
      let up = byId.get(at.comment.inReplyTo?.commentId ?? '');
      up && !seen.has(up.comment.id);
      up = byId.get(up.comment.inReplyTo?.commentId ?? '')
    ) {
      seen.add(up.comment.id)
      at = up
    }
    return at.comment.id
  }
  const grouped = new Map<string, Sent[]>()
  for (const sent of all) grouped.set(rootOf(sent), [...(grouped.get(rootOf(sent)) ?? []), sent])
  return [...grouped.values()].map((thread) => thread.sort((a, b) => a.comment.createdAt.localeCompare(b.comment.createdAt)))
}

/** How many of the agent's questions wait for the user: neither answered nor dismissed. */
export function openQuestions(state: { batches: Batch[]; dismissed: string[] }): number {
  const answered = answeredIds(state.batches)
  return state.batches
    .flatMap((batch) => batch.comments)
    .filter((comment) => comment.status === 'question' && !answered.has(comment.id) && !state.dismissed.includes(comment.id)).length
}
