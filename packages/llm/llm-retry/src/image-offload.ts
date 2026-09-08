/**
 * Image offload recovery: replace the surface nodes carrying the oldest
 * retained image occurrences with copies that mark them `offloaded`, so the
 * retried request sends placeholder text for exactly the occurrences an
 * adapter's `IMAGE_OFFLOAD_REQUIRED` failure named. The replacement is a
 * durable surface fact: it never reverts, and every later request and
 * measurement reads it from the log.
 *
 * @module @deepseek-ai/dsh-llm-retry/image-offload
 */

import type { ContentBlock, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

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

/** Append the marked copy of one surface node in place of the original. */
function replaceNode(session: Session, event: ImageNode, content: readonly ContentBlock[]): void {
  const options = {
    surfaceOp: { op: 'replace' as const, start: event.seq, end: event.seq },
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
 * @param session - the session whose derived surface the retried request reads.
 * @param count - how many more oldest retained occurrences the adapter needs offloaded.
 * @returns whether any occurrence remained to offload.
 */
export function offloadOldestImages(session: Session, count: number): boolean {
  const remaining = { count }
  let replaced = false
  for (const seq of [...session.surface.nodes]) {
    if (remaining.count === 0) break
    // oxlint-disable-next-line typescript/no-non-null-assertion -- surface nodes index the durable log
    const event = session.eventAt(seq)!
    if (event.type !== 'user/message' && event.type !== 'tool/result') continue
    const original = event.type === 'user/message' ? event.data.content : event.data.message.content
    const content = markOldestImages(original, remaining)
    if (content === original) continue
    replaceNode(session, event, content)
    replaced = true
  }
  return replaced
}
