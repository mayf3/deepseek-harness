/**
 * The image offload replacement: mark the oldest retained image occurrences
 * on the surface `offloaded` by replacing each carrying node with a marked
 * copy, priced through the shared `compaction/prune` shadow-price protocol.
 * A replacement never reverts, so every later request and measurement reads
 * the offloaded set from the log.
 *
 * @module @deepseek-ai/dsh-compaction-image-offload/image-offload
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, Message, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-token-meter'

/** Mark the first `remaining.count` retained occurrences, keeping unchanged blocks by identity. */
function markOldestImages(blocks: readonly ContentBlock[], remaining: { count: number }): readonly ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (remaining.count > 0 && block.type === 'image' && block.offloaded !== true) {
      remaining.count -= 1
      next ??= blocks.slice(0, index)
      next.push({ ...block, offloaded: true })
      continue
    }
    if (remaining.count > 0 && block.type === 'tool-result') {
      const content = markOldestImages(block.content, remaining)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content: content as ContentBlock[] })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks
}

/** The surface node types that carry model input images. */
type ImageNode = SessionEvent<'user/message'> | SessionEvent<'tool/result'>

/** The message one image node derives. */
function messageOf(event: ImageNode): Message {
  return event.type === 'user/message' ? event.data : event.data.message
}

/**
 * Append the shadow price of one node and then its marked copy in place of
 * the original, following the `compaction/prune` protocol so pure consumers
 * subtract the replaced node's heuristic price without per-node state.
 */
function replaceNode(ctx: Context, session: Session, event: ImageNode, content: readonly ContentBlock[]): void {
  session.append('compaction/prune', {
    shadowedRange: { start: event.seq, end: event.seq },
    shadowedSeqs: [event.seq],
    shadowedTokenCount: ctx.tokenMeter.estimateMessage(messageOf(event)),
  })
  const options = {
    surfaceOp: { op: 'replace' as const, startSeq: event.seq, endSeq: event.seq },
    sourceEventSeqs: [event.seq],
  }
  if (event.type === 'user/message') {
    session.append('user/message', { ...event.data, content: content as ContentBlock[] }, options)
  } else {
    session.append('tool/result', {
      ...event.data,
      message: { ...event.data.message, content: content as ToolResultMessage['content'] },
    }, options)
  }
}

/**
 * Offload the `count` oldest retained image occurrences, in model request
 * order, by replacing each surface node that carries one with a copy whose
 * occurrences are marked `offloaded`. Assistant nodes carry model output, not
 * input images, and are skipped.
 * @param ctx - the plugin context, for the token meter's heuristic price.
 * @param session - the session whose surface the retried request reads.
 * @param count - how many more oldest retained occurrences the adapter needs offloaded.
 * @returns whether any occurrence remained to offload.
 */
export function offloadOldestImages(ctx: Context, session: Session, count: number): boolean {
  const remaining = { count }
  let replaced = false
  for (const seq of [...session.surface.nodes]) {
    if (remaining.count === 0) break
    // oxlint-disable-next-line typescript/no-non-null-assertion -- surface nodes index the durable log
    const event = session.eventAt(seq)!
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue
    const original = messageOf(event).content
    const content = markOldestImages(original, remaining)
    if (content === original) continue
    replaceNode(ctx, session, event, content)
    replaced = true
  }
  return replaced
}
