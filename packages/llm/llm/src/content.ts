/** Content-block structure helpers. @module @deepseek-ai/dsh-llm/content */

import type { ContentBlock, ImageBlock, LlmImageRequestBudget } from './types.ts'
import type { Message } from './message.ts'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Execution-world path that model tools can use to read one normalized attachment. */
export interface ImageAttachmentAccess {
  /** Absolute path to immutable normalized bytes; callers must treat it as read-only. */
  readonlyPath: string
}

/**
 * Resolve current execution-world access for one durable image reference.
 * @param ref - durable normalized attachment reference.
 * @returns a read-only execution-world path, or undefined when unavailable.
 */
export type ImageAttachmentAccessResolver = (ref: ImageAttachmentRef) => ImageAttachmentAccess | undefined

/**
 * Bridge one attachment provider's host object location into the mounted
 * tool execution world. The consumer supplies the current filesystem
 * provider's mapping without making attachment or LLM definitions depend on it.
 * @param attachments - provider that owns the normalized attachment object.
 * @param mapHostPath - map one absolute host path into the current tool execution world.
 * @param ref - durable normalized attachment reference.
 * @returns a read-only execution-world path, or undefined when either provider exposes no mapping.
 * @throws an attachment error when the durable reference is invalid.
 */
export function resolveImageAttachmentAccess(
  attachments: AttachmentStore,
  mapHostPath: (hostPath: string) => string | undefined,
  ref: ImageAttachmentRef,
): ImageAttachmentAccess | undefined {
  const hostPath = attachments.imageHostPath(ref)
  if (hostPath === undefined) return undefined
  const readonlyPath = mapHostPath(hostPath)
  return readonlyPath === undefined ? undefined : { readonlyPath }
}

function quoted(value: string): string {
  return JSON.stringify(value)
}

function imageIdentity(ref: ImageAttachmentRef): string {
  return ref.name === undefined
    ? String(ref.attachmentId)
    : `${quoted(ref.name)} (${ref.attachmentId})`
}

function extension(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return '.png'
    case 'image/jpeg': return '.jpg'
    case 'image/webp': return '.webp'
    case 'image/gif': return '.gif'
    default: return assertNever(mediaType, 'image extension')
  }
}

function normalizedAccessText(ref: ImageAttachmentRef, access: ImageAttachmentAccess): string {
  return ` Normalized copy (read-only; may be resized or re-encoded): ${quoted(access.readonlyPath)} (${ref.width}x${ref.height}px, ${ref.mediaType}).`
    + ' Source dimensions, format, and byte size may differ.'
    + ` Copy to a writable path ending in ${extension(ref.mediaType)} before editing.`
}

/**
 * Stable text shown to a model that cannot accept one durable image reference.
 * @param ref - durable normalized attachment omitted from the request.
 * @returns deterministic text-only placeholder.
 */
export function textOnlyImageText(ref: ImageAttachmentRef): string {
  const digest = String(ref.attachmentId).slice('sha256:'.length, 'sha256:'.length + 8)
  return `[image omitted because this model accepts text only; attachment sha256:${digest}]`
}

/**
 * Stable model-facing handle for one exact request image. Identity comes from
 * the occurrence's own durable reference: request versions are prepared per
 * attachment id, so one shared version may serve occurrences whose display
 * names differ.
 * @param ref - the occurrence's durable normalized attachment.
 * @param version - exact request-image dimensions shown beside the text.
 * @param access - optional path resolved for the current tool execution world.
 * @returns attachment handle and request-image dimensions.
 */
export function requestImageHandleText(
  ref: ImageAttachmentRef,
  version: Pick<RequestImageAttachment, 'width' | 'height'>,
  access?: ImageAttachmentAccess,
): string {
  const preview = `Image ${imageIdentity(ref)}; request preview ${version.width}x${version.height}px.`
  return access === undefined
    ? `${preview} It may be resized or re-encoded; source dimensions, format, and byte size may differ.`
    : preview + normalizedAccessText(ref, access)
}

/**
 * Stable per-image placeholder for a request-limit omission.
 * @param ref - durable normalized attachment omitted from this request.
 * @param access - optional provider-resolved path for model tools.
 * @returns identity, normalized metadata, and the available recovery path.
 */
export function offloadedImageText(
  ref: ImageAttachmentRef,
  access?: ImageAttachmentAccess,
): string {
  const identity = `image omitted to fit request image limits; ${imageIdentity(ref)}.`
  if (access === undefined) {
    return `[${identity} No local normalized image path is available; ask the user to attach it again if needed.]`
  }
  return `[${identity}${normalizedAccessText(ref, access)}]`
}

/**
 * True when typed model content contains an image block, walking nested
 * tool-result content. This is the one recursive image walk shared by every
 * image policy (capability gating, text-only serialization, compaction
 * survey), so a consumer cannot silently diverge on nesting depth.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || (block.type === 'tool-result' && contentHasImage(block.content)))
}

/** Base64 length of raw image bytes, including padding. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * Block index path of one image occurrence inside message content: the
 * top-level block index alone, or that index followed by the position inside
 * a tool-result block's content. Paths compare lexicographically in message
 * order.
 */
export type ImageBlockPath = readonly number[]

/**
 * Compare two block paths in message order.
 * @param a - first path.
 * @param b - second path.
 * @returns negative, zero, or positive as `a` sorts before, at, or after `b`.
 */
export function compareImageBlockPaths(a: ImageBlockPath, b: ImageBlockPath): number {
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- index is below both lengths
    const delta = a[index]! - b[index]!
    if (delta !== 0) return delta
  }
  return a.length - b.length
}

/**
 * Visit every image occurrence of typed content in message order, including
 * nested tool-result content, with the block path that identifies it. This is
 * the one image walk shared by surface derivation, watermark planning, and
 * pricing, so no consumer can diverge on nesting depth or occurrence order.
 * @param content - typed model content blocks.
 * @param visit - called once per occurrence with the block and its path.
 */
export function visitImageBlocks(
  content: readonly ContentBlock[],
  visit: (block: ImageBlock, path: ImageBlockPath) => void,
): void {
  for (const [index, block] of content.entries()) {
    if (block.type === 'image') {
      visit(block, [index])
    } else if (block.type === 'tool-result') {
      for (const [nested, inner] of block.content.entries()) {
        if (inner.type === 'image') visit(inner, [index, nested])
      }
    }
  }
}

/**
 * Represented byte length of one image occurrence under a route budget: the
 * normalized byte count clamped to the route's request-version target, then
 * base64-expanded for an inline representation.
 * @param bytes - normalized attachment byte count.
 * @param budget - route representation and request-version target.
 * @returns the byte length the route's request accounting charges.
 */
export function representedImageBytes(
  bytes: number,
  budget: Pick<LlmImageRequestBudget, 'representation' | 'versionMaxBytes'>,
): number {
  const clamped = budget.versionMaxBytes === undefined ? bytes : Math.min(bytes, budget.versionMaxBytes)
  return budget.representation === 'base64' ? base64Length(clamped) : clamped
}

/**
 * Mark image occurrences as offloaded without mutating durable content.
 * @param content - typed model content blocks.
 * @param offloaded - whether the occurrence at `path` lies at or before the watermark.
 * @returns the original array when nothing changes, otherwise a copy whose marked blocks carry `offloaded: true`.
 */
export function markOffloadedImages(
  content: readonly ContentBlock[],
  offloaded: (path: ImageBlockPath) => boolean,
): readonly ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of content.entries()) {
    if (block.type === 'image') {
      if (block.offloaded !== true && offloaded([index])) {
        next ??= content.slice(0, index)
        next.push({ ...block, offloaded: true })
        continue
      }
    } else if (block.type === 'tool-result') {
      const inner = markOffloadedImages(
        block.content,
        path => offloaded([index, ...path]),
      )
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

/** Replace every offloaded occurrence, including nested tool results, with its placeholder. */
function replaceOffloadedImages(
  blocks: readonly ContentBlock[],
  placeholder: (ref: ImageAttachmentRef) => string,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image' && block.offloaded === true) {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: placeholder(block.attachment) })
      continue
    }
    if (block.type === 'tool-result') {
      const content = replaceOffloadedImages(block.content, placeholder)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Project the surface's offloaded occurrences into deterministic text for one
 * request. The offloaded set is a durable surface fact, so every route sends
 * the same set; only the placeholder text is route-owned.
 * @param messages - derived request history.
 * @param placeholder - build the model-visible replacement for one offloaded attachment.
 * @returns the original list when nothing is offloaded, otherwise shallow message copies with placeholders.
 */
export function projectOffloadedImages(
  messages: readonly Message[],
  placeholder: (ref: ImageAttachmentRef) => string,
): readonly Message[] {
  return messages.map((message) => {
    const content = replaceOffloadedImages(message.content, placeholder)
    return content === message.content ? message : { ...message, content }
  })
}

/**
 * Number of oldest retained image occurrences one route budget removes, in
 * whole count and byte quanta, once the budget is exceeded. The result depends
 * only on the represented lengths, so the agent loop plans the durable
 * watermark from logged facts and an adapter names the same count when its
 * exact accounting still overflows.
 * @param lengths - represented byte length of every retained occurrence, oldest first.
 * @param budget - count/byte budgets and removal quanta; unbounded when absent.
 * @returns how many leading occurrences to offload.
 */
export function offloadedImagePrefixCount(
  lengths: readonly number[],
  budget: Pick<LlmImageRequestBudget, 'maxImages' | 'maxBytes' | 'countQuantum' | 'byteQuantum'>,
): number {
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0)
  const excessCount = budget.maxImages === undefined ? 0 : Math.max(0, lengths.length - budget.maxImages)
  const excessBytes = budget.maxBytes === undefined ? 0 : Math.max(0, total - budget.maxBytes)
  if (excessCount === 0 && excessBytes === 0) return 0
  const countQuantum = budget.countQuantum ?? 1
  const byteQuantum = budget.byteQuantum ?? 1
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum
  let count = 0
  let removedBytes = 0
  for (const imageBytes of lengths) {
    const byteTargetMet = removeBytes === 0
      || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes)
    if (count >= removeCount && byteTargetMet) break
    removedBytes += imageBytes
    count += 1
  }
  return count
}

/** One retained image occurrence the watermark planner may offload. */
export interface RetainedImageOccurrence<Position> {
  /** Durable position of the occurrence, used as the watermark when it becomes the last offloaded one. */
  position: Position
  /** Normalized attachment byte count. */
  bytes: number
}

/**
 * Plan the next durable watermark for one route budget: with the retained
 * occurrences oldest first, the budget removes a whole-quantum prefix and the
 * last removed occurrence's position becomes the watermark. Under a 128 MiB
 * bound with a 64 MiB quantum, 129 retained one-megabyte images offload the
 * oldest 65 so 64 MiB remain, and the watermark then holds until the retained
 * total again exceeds the bound.
 * @param retained - retained occurrences in log order, oldest first.
 * @param budget - route representation, budgets, and removal quanta.
 * @returns the position of the last occurrence to offload, or undefined when the budget holds.
 */
export function planImageOffload<Position>(
  retained: readonly RetainedImageOccurrence<Position>[],
  budget: LlmImageRequestBudget,
): Position | undefined {
  const count = offloadedImagePrefixCount(
    retained.map(occurrence => representedImageBytes(occurrence.bytes, budget)),
    budget,
  )
  if (count === 0) return undefined
  // oxlint-disable-next-line typescript/no-non-null-assertion -- the prefix count never exceeds the retained length
  return retained[count - 1]!.position
}

/** Replace every image occurrence, including nested tool results, for a text-only model. */
function replaceImagesForTextModel(blocks: readonly ContentBlock[]): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image') {
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: textOnlyImageText(block.attachment) })
      continue
    }
    if (block.type === 'tool-result') {
      const content = replaceImagesForTextModel(block.content)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks as ContentBlock[]
}

/**
 * Project durable image history into deterministic text for an exact text-only model.
 * @param messages - complete request history.
 * @returns the original list without images, otherwise shallow message copies with stable placeholders.
 */
export function projectImagesForTextModel(messages: readonly Message[]): readonly Message[] {
  if (!messages.some(message => contentHasImage(message.content))) return messages
  return messages.map((message) => {
    const content = replaceImagesForTextModel(message.content)
    return content === message.content ? message : { ...message, content }
  })
}
