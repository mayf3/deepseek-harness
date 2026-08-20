import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { canonicalizeImage, isCanonical } from '../src/canonical.ts'
import type { CanonicalImagePolicy } from '../src/canonical.ts'
import { detectImage } from '../src/image.ts'

const POLICY: CanonicalImagePolicy = { maxDimension: 2048, maxBytes: 1024 * 1024 }

/** Deterministic pseudo-random RGB noise; PNG cannot compress it below raw size. */
function noisePixels(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 3)
  let state = 0x2545f491
  for (let index = 0; index < pixels.length; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    pixels[index] = state & 0xff
  }
  return pixels
}

async function noiseImage(width: number, height: number, format: 'png' | 'jpeg' | 'webp' | 'gif'): Promise<Uint8Array> {
  const image = sharp(noisePixels(width, height), { raw: { width, height, channels: 3 } })
  return new Uint8Array(await image.toFormat(format).toBuffer())
}

async function flatImage(width: number, height: number, format: 'png' | 'jpeg' | 'webp' | 'gif', alpha = false): Promise<Uint8Array> {
  const image = sharp({
    create: { width, height, channels: alpha ? 4 : 3, background: { r: 12, g: 200, b: 64, alpha: alpha ? 0.5 : 1 } },
  })
  return new Uint8Array(await image.toFormat(format, format === 'webp' && alpha ? { lossless: true } : {}).toBuffer())
}

describe('isCanonical', () => {
  it('accepts an in-budget PNG/JPEG/WebP and refuses GIF, oversized edges, and oversized bytes', () => {
    expect(isCanonical({ mediaType: 'image/png', width: 2048, height: 4 }, 100, POLICY)).toBe(true)
    expect(isCanonical({ mediaType: 'image/gif', width: 4, height: 4 }, 100, POLICY)).toBe(false)
    expect(isCanonical({ mediaType: 'image/jpeg', width: 2049, height: 4 }, 100, POLICY)).toBe(false)
    expect(isCanonical({ mediaType: 'image/webp', width: 4, height: 4 }, POLICY.maxBytes + 1, POLICY)).toBe(false)
  })
})

describe('canonicalizeImage', () => {
  it('passes an already-canonical source through byte-identically', async () => {
    const data = await flatImage(6, 4, 'webp')
    const detected = await detectImage(data)

    const canonical = await canonicalizeImage(data, detected, POLICY)

    expect(canonical.data).toBe(data)
    expect(canonical).toMatchObject({ mediaType: 'image/webp', width: 6, height: 4 })
  })

  it('downscales an oversized PNG to the long-edge target and stays PNG', async () => {
    const data = await flatImage(10, 6, 'png')
    const detected = await detectImage(data)

    const canonical = await canonicalizeImage(data, detected, { maxDimension: 5, maxBytes: POLICY.maxBytes })

    expect(canonical).toMatchObject({ mediaType: 'image/png', width: 5, height: 3 })
    await expect(detectImage(canonical.data)).resolves.toEqual({ mediaType: 'image/png', width: 5, height: 3 })
    const again = await canonicalizeImage(data, detected, { maxDimension: 5, maxBytes: POLICY.maxBytes })
    expect(again.data).toEqual(canonical.data)
  })

  it('re-encodes the canonical output of a resize into itself (idempotence)', async () => {
    const data = await flatImage(10, 6, 'png')
    const first = await canonicalizeImage(data, await detectImage(data), { maxDimension: 5, maxBytes: POLICY.maxBytes })

    const second = await canonicalizeImage(first.data, await detectImage(first.data), { maxDimension: 5, maxBytes: POLICY.maxBytes })

    expect(second.data).toBe(first.data)
  })

  it('always re-encodes GIF to the PNG of its first frame', async () => {
    const data = await flatImage(6, 4, 'gif')
    const detected = await detectImage(data)

    const canonical = await canonicalizeImage(data, detected, POLICY)

    expect(canonical.mediaType).toBe('image/png')
    await expect(detectImage(canonical.data)).resolves.toEqual({ mediaType: 'image/png', width: 6, height: 4 })
  })

  it('keeps alpha sources on PNG when the budget holds', async () => {
    const data = await flatImage(9, 5, 'webp', true)
    const detected = await detectImage(data)

    const canonical = await canonicalizeImage(data, detected, { maxDimension: 4, maxBytes: POLICY.maxBytes })

    expect(canonical).toMatchObject({ mediaType: 'image/png', width: 4, height: 2 })
  })

  it('re-encodes an oversized photographic JPEG as JPEG', async () => {
    const data = await noiseImage(64, 32, 'jpeg')
    const detected = await detectImage(data)

    const canonical = await canonicalizeImage(data, detected, { maxDimension: 32, maxBytes: POLICY.maxBytes })

    expect(canonical).toMatchObject({ mediaType: 'image/jpeg', width: 32, height: 16 })
  })

  it('falls from PNG to the JPEG ladder when palette PNG exceeds the byte target', async () => {
    // A smooth gradient: palette quantization dithers it into a sizable PNG
    // while JPEG at quality 85 stays far smaller, so the budget between the
    // two forces exactly one ladder hop.
    const side = 256
    const pixels = new Uint8Array(side * side * 3)
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const index = (y * side + x) * 3
        pixels[index] = x & 0xff
        pixels[index + 1] = y & 0xff
        pixels[index + 2] = (x + y) >> 1 & 0xff
      }
    }
    const data = new Uint8Array(await sharp(pixels, { raw: { width: side, height: side, channels: 3 } }).png().toBuffer())
    const detected = await detectImage(data)
    const paletteSize = (await sharp(data).png({ compressionLevel: 9, palette: true }).toBuffer()).byteLength
    const jpegSize = (await sharp(data).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer()).byteLength
    expect(jpegSize).toBeLessThan(paletteSize)
    const budget = { maxDimension: 2048, maxBytes: paletteSize - 1 }

    const canonical = await canonicalizeImage(data, detected, budget)

    expect(canonical.mediaType).toBe('image/jpeg')
    expect(canonical.data.byteLength).toBeLessThanOrEqual(budget.maxBytes)
  })

  it('refuses a source that no ladder step fits into the byte target', async () => {
    const data = await noiseImage(64, 64, 'png')

    await expect(canonicalizeImage(data, await detectImage(data), { maxDimension: 2048, maxBytes: 10 }))
      .rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' })
  })

  it('maps an encoder fault on undecodable bytes to a storage failure', async () => {
    await expect(canonicalizeImage(Uint8Array.of(1, 2, 3), { mediaType: 'image/png', width: 5000, height: 5000 }, POLICY))
      .rejects.toMatchObject({ code: 'ATTACHMENT_WRITE_FAILED' })
  })
})
