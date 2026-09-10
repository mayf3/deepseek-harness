/**
 * Pure request-projection geometry shared by attachment providers and
 * provider-side request pricing. @module @deepseek-ai/dsh-attachment/request-projection
 */

import type { ImageRequestPolicy, ImageRequestProjection, TokenGridProjection } from './types.ts'

/** Integer width and height of one projected image. */
export interface ProjectedDimensions {
  width: number
  height: number
}

const intDiv = (value: number, divisor: number): number => Math.floor(value / divisor)
const ceilDiv = (value: number, divisor: number): number => Math.floor((value + divisor - 1) / divisor)

/** Aspect-preserving integer dimensions within a hard total-pixel budget; small images are not enlarged. */
function pixelBudgetDimensions(width: number, height: number, maxPixels: number): ProjectedDimensions {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale))
    let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale))
  let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  }
  return { width: projectedWidth, height: projectedHeight }
}

/** Token count of one grid: every row carries a separator, plus two framing tokens. */
function gridTokens(rows: number, columns: number): number {
  return rows * (columns + 1) + 2
}

/**
 * Project one image onto the token grid of a `token-grid` projection. The
 * provider pads each edge up to a whole patch, groups patches into token
 * cells, and keeps the padded source when its cell grid fits `maxTokens`;
 * otherwise it solves the largest aspect-preserving grid inside the cap, whose
 * edges are whole patches. The closed-form solve always lands inside the cap.
 * @param width - positive integer source width in pixels.
 * @param height - positive integer source height in pixels.
 * @param grid - patch size, per-axis downsampling ratio, and token cap.
 * @returns the dimensions the provider retains and the tokens it charges.
 */
export function tokenGridProjection(
  width: number,
  height: number,
  grid: Extract<ImageRequestProjection, { kind: 'token-grid' }>,
): TokenGridProjection {
  const { patchSize, downsampleRatio, maxTokens } = grid
  const cells = (paddedLength: number): number => ceilDiv(intDiv(paddedLength, patchSize), downsampleRatio)
  const paddedWidth = ceilDiv(width, patchSize) * patchSize
  const paddedHeight = ceilDiv(height, patchSize) * patchSize
  const directTokens = gridTokens(cells(paddedHeight), cells(paddedWidth))
  if (directTokens <= maxTokens) {
    return { width: paddedWidth, height: paddedHeight, tokens: directTokens, unscaled: true }
  }
  const cellSize = patchSize * downsampleRatio
  const aspect = height / width
  const idealColumns = Math.sqrt((maxTokens - 2) / aspect + 0.25) - 0.5
  const idealRows = idealColumns * aspect
  let bestWidth: number
  let bestHeight: number
  if (idealColumns < 1) {
    bestWidth = cellSize
    bestHeight = intDiv(maxTokens - 2, 2) * cellSize
  } else if (idealRows < 1) {
    bestWidth = (maxTokens - 3) * cellSize
    bestHeight = cellSize
  } else {
    const columns = Math.trunc(idealColumns)
    const rows = Math.trunc(idealRows)
    const scale = Math.min(columns * cellSize / width, rows * cellSize / height)
    bestWidth = Math.trunc(width * scale / patchSize) * patchSize
    bestHeight = Math.trunc(height * scale / patchSize) * patchSize
  }
  return {
    width: bestWidth,
    height: bestHeight,
    tokens: gridTokens(cells(bestHeight), cells(bestWidth)),
    unscaled: false,
  }
}

/** Aspect-preserving dimensions with an exact long edge; the short edge rounds to the nearest pixel. */
function fromLongEdge(width: number, height: number, longEdge: number): ProjectedDimensions {
  return width >= height
    ? { width: longEdge, height: Math.max(1, Math.round(longEdge * height / width)) }
    : { width: Math.max(1, Math.round(longEdge * width / height)), height: longEdge }
}

function projectDimensions(width: number, height: number, projection: ImageRequestProjection): ProjectedDimensions {
  switch (projection.kind) {
    case 'pixel-budget':
      return pixelBudgetDimensions(width, height, projection.maxPixels)
    case 'token-grid': {
      const fit = tokenGridProjection(width, height, projection)
      if (fit.unscaled) return { width, height }
      return fromLongEdge(width, height, width >= height ? fit.width : fit.height)
    }
    /* v8 ignore next 4 -- ImageRequestProjection is a closed union; this branch is only the static exhaustiveness guard. */
    default: {
      const unreachable: never = projection
      throw new Error(`unknown image request projection ${JSON.stringify(unreachable)}`)
    }
  }
}

/**
 * Compute the aspect-preserving integer dimensions of one request image:
 * the policy projection first, then the optional per-side cap. Small images
 * are never enlarged. A downscaled result keeps the source long edge exact
 * and rounds the short edge, matching a long-edge-only encoder resize.
 * @param width - positive source width.
 * @param height - positive source height.
 * @param policy - route projection rule and optional per-side cap.
 * @returns integer dimensions.
 */
export function requestImageDimensions(
  width: number,
  height: number,
  policy: Pick<ImageRequestPolicy, 'projection' | 'maxDimension'>,
): ProjectedDimensions {
  const projected = projectDimensions(width, height, policy.projection)
  const longEdge = Math.max(projected.width, projected.height)
  if (policy.maxDimension === undefined || longEdge <= policy.maxDimension) return projected
  return fromLongEdge(width, height, policy.maxDimension)
}
