/**
 * The measurement service's positional surface fold: the per-node priced
 * surface `measure()` serves and compaction plans against. The projection
 * units deliberately do NOT share this fold — their state must stay O(1)
 * for the persisted checkpoint, so they ride `surface-projection.ts`'s
 * shadow-price protocol instead. Fully metered logs stay in agreement by
 * construction: both price through `estimate.ts`, and every logged shadow
 * price is derived from THIS fold's fixed-heuristic node prices by the
 * replace producer. A projection replacement without a claim deliberately
 * folds with zero delta.
 *
 * Nodes additionally carry their durable image occurrences and an image-free
 * heuristic price, so `measure()` can reprice image content under the routed
 * model's request-image pricing without replaying the log.
 *
 * @module @deepseek-ai/dsh-token-meter/surface-fold
 */

import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { SurfaceEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { estimateMessage, estimateStructuralBlock } from './estimate.ts'

/** One priced surface node with the image occurrences route pricing replaces. */
export interface MeterSurfaceNode {
  /** Durable sequence number of the surface event. */
  readonly seq: number
  /** Fixed-heuristic price of the node's exact message. */
  readonly heuristicTokens: number
  /** Fixed-heuristic price with every image occurrence's structural price removed. */
  readonly imageFreeTokens: number
  /** Durable image occurrences in message order; empty for image-free nodes. */
  readonly images: readonly ImageAttachmentRef[]
}

/** One surface event's placement and cost against the surface preceding it. */
export interface SurfaceTokenFold {
  /** Heuristic price of the event's own message; 0 when it derives none. */
  readonly tokens: number
  /** The surface after the event, detached from the input. */
  readonly nodes: MeterSurfaceNode[]
}

/** Collect image occurrences recursively and total their structural prices. */
function collectImages(blocks: readonly ContentBlock[], images: ImageAttachmentRef[]): number {
  let structuralTokens = 0
  for (const block of blocks) {
    if (block.type === 'image') {
      images.push(block.attachment)
      structuralTokens += estimateStructuralBlock(block)
    } else if (block.type === 'tool-result') {
      structuralTokens += collectImages(block.content, images)
    }
  }
  return structuralTokens
}

/** Build one priced node from a surface event's derived message. */
function analyzeNode(seq: number, message: Message | null): MeterSurfaceNode {
  if (message === null) return { seq, heuristicTokens: 0, imageFreeTokens: 0, images: [] }
  const heuristicTokens = estimateMessage(message)
  const images: ImageAttachmentRef[] = []
  const imageStructuralTokens = collectImages(message.content, images)
  return {
    seq,
    heuristicTokens,
    imageFreeTokens: heuristicTokens - imageStructuralTokens,
    images,
  }
}

/**
 * Fold one surface event onto a priced surface.
 *
 * Total and allocation-fresh: the caller assigns the result rather than
 * mutating in place, so a throw here leaves the caller's state untouched and
 * the same malformed event fails identically on every retry.
 * @param nodes - the priced surface preceding this event, in model-visible order.
 * @param event - the surface event to place.
 * @returns the event's price and the next surface.
 * @throws when a replacement names a range absent from `nodes` — committed
 *   logs are surface-validated at append time, so an unresolvable range is log
 *   corruption and must fail loud rather than skip the event.
 */
export function foldSurfaceTokens(
  nodes: readonly MeterSurfaceNode[],
  event: SurfaceEvent,
): SurfaceTokenFold {
  const node = analyzeNode(event.seq, deriveEventMessage(event))
  const op = event.surfaceOp
  if (op === 'append') {
    return { tokens: node.heuristicTokens, nodes: [...nodes, node] }
  }
  const startIdx = nodes.findIndex(existing => existing.seq === op.start)
  const endIdx = nodes.findIndex(existing => existing.seq === op.end)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new Error(
      `token surface: replace at seq ${event.seq} has invalid current range ${op.start}-${op.end}`,
    )
  }
  const next = [...nodes]
  next.splice(startIdx, endIdx - startIdx + 1, node)
  return { tokens: node.heuristicTokens, nodes: next }
}
