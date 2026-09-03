/**
 * Durable image offload watermark: the `image/offload` fold, its append-time
 * validation, and the per-node projection that marks image occurrences at or
 * before the watermark as offloaded.
 *
 * @module @deepseek-ai/dsh-session/image-offload
 */

import { compareImageBlockPaths, markOffloadedImages } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { ImageOccurrencePosition, SessionEvent, SessionSeq } from './types.ts'

/**
 * Compare two image occurrence positions in log order: by event seq, then by
 * block path inside the event's content.
 * @param a - first position.
 * @param b - second position.
 * @returns negative, zero, or positive as `a` lies before, at, or after `b`.
 */
export function compareImagePositions(a: ImageOccurrencePosition, b: ImageOccurrencePosition): number {
  return a.seq === b.seq ? compareImageBlockPaths(a.path, b.path) : a.seq - b.seq
}

/**
 * Select the watermark in force after a run of events: the last
 * `image/offload` event's position, or the prior watermark when the run
 * carries none.
 * @param events - events in seq order.
 * @param prior - watermark folded from the events before `events`.
 * @returns the latest watermark, or undefined when no event has set one.
 */
export function foldImageOffloadWatermark(
  events: readonly SessionEvent[],
  prior?: ImageOccurrencePosition,
): ImageOccurrencePosition | undefined {
  let watermark = prior
  for (const event of events) {
    if (event.type === 'image/offload') watermark = event.data.watermark
  }
  return watermark
}

/**
 * Validate one `image/offload` payload at the append or seed boundary: the
 * position must name an event already in the log, carry a block path of
 * non-negative integers, and lie strictly after the watermark in force.
 * @param data - the event payload as materialized JSON.
 * @param logLength - number of events already accepted.
 * @param prior - watermark in force before this event.
 * @param location - append or seed location named by the diagnostic.
 * @throws when the payload is malformed or does not advance the watermark.
 */
export function assertImageOffloadAdvance(
  data: unknown,
  logLength: number,
  prior: ImageOccurrencePosition | undefined,
  location: string,
): void {
  const record = data !== null && typeof data === 'object' && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined
  const watermark = record?.['watermark']
  const position = watermark !== null && typeof watermark === 'object' && !Array.isArray(watermark)
    ? watermark as Record<string, unknown>
    : undefined
  const seq = position?.['seq']
  const path = position?.['path']
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seq >= logLength
    || !Array.isArray(path) || path.length === 0
    || path.some(index => typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)) {
    throw new Error(`${location} names an invalid image offload watermark`)
  }
  if (prior !== undefined
    && compareImagePositions({ seq: seq as SessionSeq, path: path as number[] }, prior) <= 0) {
    throw new Error(`${location} does not advance the image offload watermark`)
  }
}

/**
 * Project one derived surface message under the watermark: every image
 * occurrence positioned at or before it carries `offloaded: true`.
 * @param message - the node's derived message.
 * @param seq - the node's event seq.
 * @param watermark - watermark in force, or undefined when nothing is offloaded.
 * @returns the same message when nothing changes, otherwise a shallow copy with marked content.
 */
export function markImageOffload(
  message: Message,
  seq: SessionSeq,
  watermark: ImageOccurrencePosition | undefined,
): Message {
  if (watermark === undefined || seq > watermark.seq) return message
  const content = markOffloadedImages(
    message.content,
    path => seq < watermark.seq || compareImageBlockPaths(path, watermark.path) <= 0,
  )
  return content === message.content ? message : { ...message, content: content as Message['content'] }
}
