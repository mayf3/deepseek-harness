import { describe, expect, it } from 'vitest'
import { requestImageDimensions, tokenGridProjection } from '../src/index.ts'
import type { ImageRequestProjection } from '../src/index.ts'

const PIXEL_BUDGET: ImageRequestProjection = { kind: 'pixel-budget', maxPixels: 640_000 }
const TOKEN_GRID = { kind: 'token-grid', patchSize: 14, downsampleRatio: 3, maxTokens: 1024 } as const

describe('pixel-budget projection', () => {
  it.each([
    [4096, 4096, 800, 800],
    [4096, 2048, 1130, 565],
    [3840, 2160, 1066, 600],
    [320, 240, 320, 240],
  ])('projects %sx%s under 640,000 pixels as %sx%s', (width, height, expectedWidth, expectedHeight) => {
    const projected = requestImageDimensions(width, height, { projection: PIXEL_BUDGET })
    expect(projected).toEqual({
      width: expectedWidth,
      height: expectedHeight,
    })
    expect(projected.width * projected.height).toBeLessThanOrEqual(640_000)
  })

  it('projects a portrait within the same total-pixel budget', () => {
    const projected = requestImageDimensions(2160, 3840, { projection: PIXEL_BUDGET })

    expect(projected).toEqual({ width: 600, height: 1066 })
    expect(projected.width * projected.height).toBeLessThanOrEqual(640_000)
  })

  it('rounds a portrait inward when integer aspect rounding crosses the pixel cap', () => {
    expect(requestImageDimensions(2, 4, { projection: { kind: 'pixel-budget', maxPixels: 5 } })).toEqual({ width: 1, height: 2 })
  })
})

describe('token-grid projection', () => {
  it('keeps the patch-padded source when its grid fits the token cap', () => {
    expect(tokenGridProjection(800, 800, TOKEN_GRID)).toEqual({ width: 812, height: 812, tokens: 422, unscaled: true })
    expect(tokenGridProjection(1302, 1302, TOKEN_GRID)).toEqual({ width: 1302, height: 1302, tokens: 994, unscaled: true })
  })

  it.each([
    [1303, 1303, 1302, 1302, 994],
    [4096, 4096, 1302, 1302, 994],
    [3840, 2160, 1708, 966, 968],
    [2160, 3840, 966, 1708, 986],
    [4000, 1000, 2520, 630, 917],
  ])('solves %sx%s onto the largest in-cap grid %sx%s', (width, height, expectedWidth, expectedHeight, tokens) => {
    expect(tokenGridProjection(width, height, TOKEN_GRID)).toEqual({
      width: expectedWidth,
      height: expectedHeight,
      tokens,
      unscaled: false,
    })
    expect(expectedWidth % TOKEN_GRID.patchSize).toBe(0)
    expect(expectedHeight % TOKEN_GRID.patchSize).toBe(0)
  })

  it('solves one-row and one-column grids for extreme aspect ratios', () => {
    expect(tokenGridProjection(100_000, 1, TOKEN_GRID)).toEqual({ width: 42_882, height: 42, tokens: 1024, unscaled: false })
    expect(tokenGridProjection(1, 100_000, TOKEN_GRID)).toEqual({ width: 42, height: 21_462, tokens: 1024, unscaled: false })
  })

  it('sends a fitting source at its own dimensions and a larger source at the solved grid', () => {
    expect(requestImageDimensions(800, 800, { projection: TOKEN_GRID })).toEqual({ width: 800, height: 800 })
    expect(requestImageDimensions(8192, 78, { projection: TOKEN_GRID })).toEqual({ width: 8192, height: 78 })
    expect(requestImageDimensions(2048, 1024, { projection: TOKEN_GRID })).toEqual({ width: 1848, height: 924 })
  })

  it('keeps the solved long edge and rounds the short edge to the source aspect ratio', () => {
    expect(requestImageDimensions(3840, 2160, { projection: TOKEN_GRID })).toEqual({ width: 1708, height: 961 })
    expect(requestImageDimensions(1080, 2400, { projection: TOKEN_GRID })).toEqual({ width: 838, height: 1862 })
  })
})

describe('per-side cap', () => {
  it('scales the projected image down to the cap on its long edge', () => {
    expect(requestImageDimensions(8192, 78, { projection: TOKEN_GRID, maxDimension: 4096 })).toEqual({ width: 4096, height: 39 })
    expect(requestImageDimensions(1, 8192, { projection: TOKEN_GRID, maxDimension: 4096 })).toEqual({ width: 1, height: 4096 })
    expect(requestImageDimensions(10_000, 100, { projection: PIXEL_BUDGET, maxDimension: 4096 })).toEqual({ width: 4096, height: 41 })
  })

  it('leaves an image within the cap untouched', () => {
    expect(requestImageDimensions(2048, 2048, { projection: TOKEN_GRID, maxDimension: 4096 })).toEqual({ width: 1302, height: 1302 })
  })
})
