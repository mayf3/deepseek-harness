/**
 * Durable image offload watermark: the `image/offload` fold, its append-time
 * validation, and the per-node projection that marks image occurrences at or
 * before the watermark as offloaded.
 *
 * @module @deepseek-ai/dsh-session/image-offload
 */

import type { ContentBlock, ImageBlockPath, Message } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from './surface.ts'
import type { ImageOccurrencePosition, SessionEvent, SessionSeq } from './types.ts'

/** Compare two nested block paths in message order. */
function compareImageBlockPaths(a: ImageBlockPath, b: ImageBlockPath): number {
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is below both lengths
    const delta = a[index]! - b[index]!
    if (delta !== 0) return delta
  }
  return a.length - b.length
}

/** Return whether a non-empty nested block path identifies an image occurrence. */
function pathIdentifiesImage(
  content: readonly ContentBlock[],
  [index, ...rest]: readonly [number, ...number[]],
): boolean {
  const block = content[index]
  if (block === undefined) return false
  if (rest.length === 0) return block.type === 'image'
  if (block.type !== 'tool-result') return false
  return pathIdentifiesImage(block.content, rest as [number, ...number[]])
}

/** Mark matching image occurrences while preserving unchanged durable content by identity. */
function markOffloadedImages(
  content: readonly ContentBlock[],
  offloaded: (path: ImageBlockPath) => boolean,
  prefix: ImageBlockPath = [],
): readonly ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of content.entries()) {
    const path = [...prefix, index]
    if (block.type === 'image' && block.offloaded !== true && offloaded(path)) {
      next ??= content.slice(0, index)
      next.push({ ...block, offloaded: true })
      continue
    }
    if (block.type === 'tool-result') {
      const inner = markOffloadedImages(block.content, offloaded, path)
      if (inner !== block.content) {
        next ??= content.slice(0, index)
        next.push({ ...block, content: inner as ContentBlock[] })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? content
}

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
 * position must name an image occurrence on the current surface and lie
 * strictly after the watermark in force.
 * @param data - the event payload as materialized JSON.
 * @param log - events already accepted.
 * @param surfaceNodes - current model-visible surface event sequences.
 * @param prior - watermark in force before this event.
 * @param location - append or seed location named by the diagnostic.
 * @throws when the payload is malformed or does not advance the watermark.
 */
export function assertImageOffloadAdvance(
  data: unknown,
  log: readonly SessionEvent[],
  surfaceNodes: readonly SessionSeq[],
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
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0 || seq >= log.length
    || !Array.isArray(path) || path.length === 0
    || path.some(index => typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)) {
    throw new Error(`${location} names an invalid image offload watermark`)
  }
  const positionValue = { seq: seq as SessionSeq, path: path as number[] }
  if (prior !== undefined
    && compareImagePositions(positionValue, prior) <= 0) {
    throw new Error(`${location} does not advance the image offload watermark`)
  }
  // oxlint-disable-next-line typescript/no-non-null-assertion -- accepted logs are contiguous and seq is range-checked
  const message = deriveEventMessage(log[seq]!)
  if (!surfaceNodes.includes(positionValue.seq)
    || message === null
    || !pathIdentifiesImage(message.content, positionValue.path as [number, ...number[]])) {
    throw new Error(`${location} watermark does not identify an image on the current surface`)
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
