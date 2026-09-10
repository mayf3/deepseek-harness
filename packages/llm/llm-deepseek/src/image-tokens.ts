/**
 * DeepSeek vision-token accounting: the provider's published image-token
 * calculator (api-docs.deepseek.com, Token & Token Usage) in its current
 * `v41` configuration. The provider scales an image below 544×544 total
 * pixels up, then projects it onto the token grid shared with request
 * projection, iterating to a fixpoint. The count is exact: this configuration
 * has no alignment pad and no aspect-ratio clamp. Actual usage remains
 * authoritative.
 *
 * @module dsh-llm-deepseek/image-tokens
 */

import { tokenGridProjection } from '@deepseek-ai/dsh-attachment'
import type { ImageRequestProjection, TokenGridProjection } from '@deepseek-ai/dsh-attachment'

/** Published DeepSeek vision grid: 14px patches, 3:1 per-axis downsampling, at most 1024 tokens per image. */
export const DEEPSEEK_IMAGE_TOKEN_GRID = {
  kind: 'token-grid',
  patchSize: 14,
  downsampleRatio: 3,
  maxTokens: 1024,
} as const satisfies ImageRequestProjection

/** Total-pixel floor; smaller images are scaled up before grid projection. */
const MIN_PIXELS = 544 * 544

/** One scale-up-then-project pass; the caller iterates it to a fixpoint. */
function resizeOnce(width: number, height: number): TokenGridProjection {
  const pixels = width * height
  if (pixels >= MIN_PIXELS) return tokenGridProjection(width, height, DEEPSEEK_IMAGE_TOKEN_GRID)
  const scale = Math.sqrt(MIN_PIXELS / pixels)
  return tokenGridProjection(Math.trunc(width * scale), Math.trunc(height * scale), DEEPSEEK_IMAGE_TOKEN_GRID)
}

function sameResize(a: TokenGridProjection, b: TokenGridProjection): boolean {
  return a.width === b.width && a.height === b.height && a.tokens === b.tokens
}

/**
 * Vision tokens DeepSeek charges for one request image of the given
 * dimensions.
 * @param width - positive integer request-image width in pixels.
 * @param height - positive integer request-image height in pixels.
 * @returns the provider vision-token price, at most 1024.
 */
export function deepSeekImageTokens(width: number, height: number): number {
  let result = resizeOnce(width, height)
  for (let iteration = 1; iteration < 10; iteration += 1) {
    const next = resizeOnce(result.width, result.height)
    if (sameResize(next, result)) return result.tokens
    result = next
  }
  /* v8 ignore next 2 -- the published solver's non-convergence guard; every
     pass is a projection, so a second identical pass is a fixpoint. */
  throw new Error(`deepseek image tokens: resize did not converge for ${width}x${height}`)
}
