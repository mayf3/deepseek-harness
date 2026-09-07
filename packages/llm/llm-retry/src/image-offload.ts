/**
 * Durable image offload recovery: advance the session's `image/offload`
 * watermark past the oldest retained image occurrences an adapter's
 * `IMAGE_OFFLOAD_REQUIRED` failure names, so the retried step derives the
 * offloaded set the log records.
 *
 * @module @deepseek-ai/dsh-llm-retry/image-offload
 */

import { visitImageBlocks } from '@deepseek-ai/dsh-llm'
import { compareImagePositions } from '@deepseek-ai/dsh-session'
import type { ImageOccurrencePosition, Session } from '@deepseek-ai/dsh-session'

/**
 * Append one `image/offload` advance covering the `count` oldest image
 * occurrences the surface still sends, in model request order. A surface
 * replacement can place a newer event before older ones, so the advance
 * names the greatest durable position in that prefix; it may offload
 * additional occurrences but always covers the prefix.
 * @param session - the session whose derived surface the retried request reads.
 * @param turn - the open turn.
 * @param step - the step being retried.
 * @param count - how many more oldest retained occurrences the adapter needs offloaded.
 * @returns whether any occurrence remained to offload.
 */
export function advanceImageOffload(session: Session, turn: number, step: number, count: number): boolean {
  let remaining = count
  let watermark: ImageOccurrencePosition | undefined
  for (const seq of session.surface.nodes) {
    if (remaining === 0) break
    // oxlint-disable-next-line typescript/no-non-null-assertion -- surface nodes index the durable log
    const message = session.deriveEventMessage(session.eventAt(seq)!)
    if (message === null) continue
    visitImageBlocks(message.content, (block, path) => {
      if (remaining === 0 || block.offloaded === true) return
      remaining -= 1
      const position = { seq, path: [...path] }
      if (watermark === undefined || compareImagePositions(position, watermark) > 0) watermark = position
    })
  }
  if (watermark === undefined) return false
  session.append('image/offload', { turn, step, watermark })
  return true
}
