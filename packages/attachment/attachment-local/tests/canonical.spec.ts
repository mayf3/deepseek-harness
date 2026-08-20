import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { hasLowColourCount, isMasterImage, prepareMasterImage } from '../src/canonical.ts'
import type { MasterImagePolicy } from '../src/canonical.ts'
import { detectImage } from '../src/image.ts'

const POLICY: MasterImagePolicy = { maxDimension: 2048, maxBytes: 4 * 1024 * 1024 }

/** Deterministic pseudo-random RGB noise; PNG cannot compress it below raw size. */
function noisePixels(width: number, height: number): Uint8Array {
  const pixels = new Uint8Array(width * height * 3)
  let state = 0x2545f491
  for (let index = 0; index < pixels.length; index += 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
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

describe('isMasterImage', () => {
  it('accepts an in-budget clean PNG/JPEG/WebP and refuses GIF, animation, metadata, oversized edges, and oversized bytes', () => {
    const clean = { animated: false, carriesMetadata: false, depth: 'uchar', space: 'srgb', hasAlpha: false }
    expect(isMasterImage({ mediaType: 'image/png', width: 2048, height: 4, ...clean }, 100, POLICY)).toBe(true)
    expect(isMasterImage({ mediaType: 'image/gif', width: 4, height: 4, ...clean }, 100, POLICY)).toBe(false)
    expect(isMasterImage({ mediaType: 'image/webp', width: 4, height: 4, animated: true, carriesMetadata: false, depth: 'uchar', space: 'srgb', hasAlpha: false }, 100, POLICY)).toBe(false)
    expect(isMasterImage({ mediaType: 'image/jpeg', width: 4, height: 4, animated: false, carriesMetadata: true, depth: 'uchar', space: 'srgb', hasAlpha: false }, 100, POLICY)).toBe(false)
    expect(isMasterImage({ mediaType: 'image/png', width: 4, height: 4, ...clean, depth: 'ushort' }, 100, POLICY)).toBe(false)
    expect(isMasterImage({ mediaType: 'image/png', width: 4, height: 4, ...clean, space: 'rgb16' }, 100, POLICY)).toBe(false)
    expect(isMasterImage({ mediaType: 'image/jpeg', width: 2049, height: 4, ...clean }, 100, POLICY)).toBe(false)
    expect(isMasterImage({ mediaType: 'image/webp', width: 4, height: 4, ...clean }, POLICY.maxBytes + 1, POLICY)).toBe(false)
  })
})

describe('prepareMasterImage', () => {
  it('passes an already-canonical source through byte-identically', async () => {
    const data = await flatImage(6, 4, 'webp')
    const detected = await detectImage(data)

    const canonical = await prepareMasterImage(data, detected, POLICY)

    expect(canonical.data).toBe(data)
    expect(canonical).toMatchObject({ mediaType: 'image/webp', width: 6, height: 4 })
  })

  it.each([3, 4] as const)('converts a 16-bit %s-channel PNG to 8-bit sRGB without passthrough', async (channels) => {
    const data = new Uint8Array(await sharp({
      create: { width: 7, height: 5, channels, background: { r: 12, g: 34, b: 56, alpha: 0.5 } },
    }).toColourspace('rgb16').png().toBuffer())
    const detected = await detectImage(data)
    expect(detected).toMatchObject({ depth: 'ushort', space: 'rgb16', hasAlpha: channels === 4 })

    const canonical = await prepareMasterImage(data, detected, POLICY)

    expect(canonical.data).not.toBe(data)
    expect(canonical.data).not.toEqual(data)
    await expect(detectImage(canonical.data)).resolves.toMatchObject({
      depth: 'uchar', space: 'srgb', hasAlpha: channels === 4, width: 7, height: 5,
    })
  })

  it('downscales an oversized PNG to the long-edge target and stays PNG', async () => {
    const data = await flatImage(10, 6, 'png')
    const detected = await detectImage(data)

    const canonical = await prepareMasterImage(data, detected, { maxDimension: 5, maxBytes: POLICY.maxBytes })

    expect(canonical).toMatchObject({ mediaType: 'image/png', width: 5, height: 3 })
    await expect(detectImage(canonical.data)).resolves.toMatchObject({ mediaType: 'image/png', width: 5, height: 3, animated: false, carriesMetadata: false, depth: 'uchar', space: 'srgb' })
    const again = await prepareMasterImage(data, detected, { maxDimension: 5, maxBytes: POLICY.maxBytes })
    expect(again.data).toEqual(canonical.data)
  })

  it('re-encodes the canonical output of a resize into itself (idempotence)', async () => {
    const data = await flatImage(10, 6, 'png')
    const first = await prepareMasterImage(data, await detectImage(data), { maxDimension: 5, maxBytes: POLICY.maxBytes })

    const second = await prepareMasterImage(first.data, await detectImage(first.data), { maxDimension: 5, maxBytes: POLICY.maxBytes })

    expect(second.data).toBe(first.data)
  })

  it('always re-encodes GIF to the PNG of its first frame', async () => {
    const data = await flatImage(6, 4, 'gif')
    const detected = await detectImage(data)

    const canonical = await prepareMasterImage(data, detected, POLICY)

    expect(canonical.mediaType).toBe('image/png')
    await expect(detectImage(canonical.data)).resolves.toMatchObject({ mediaType: 'image/png', width: 6, height: 4, animated: false, carriesMetadata: false, depth: 'uchar', space: 'srgb' })
  })

  it('keeps a low-colour alpha source on PNG when the budget holds', async () => {
    const data = await flatImage(9, 5, 'webp', true)
    const detected = await detectImage(data)

    const canonical = await prepareMasterImage(data, detected, { maxDimension: 4, maxBytes: POLICY.maxBytes })

    expect(canonical).toMatchObject({ mediaType: 'image/png', width: 4, height: 2 })
  })

  it('retains an all-opaque alpha channel while converting a low-colour image', async () => {
    const data = new Uint8Array(await sharp({
      create: { width: 10, height: 6, channels: 4, background: { r: 12, g: 200, b: 64, alpha: 1 } },
    }).png().toBuffer())

    const canonical = await prepareMasterImage(data, await detectImage(data), {
      maxDimension: 5,
      maxBytes: POLICY.maxBytes,
    })

    expect(canonical).toMatchObject({ mediaType: 'image/png', width: 5, height: 3 })
    await expect(detectImage(canonical.data)).resolves.toMatchObject({ hasAlpha: true })
  })

  it('keeps transparency when the byte cap requires another encoding and smaller dimensions', async () => {
    const side = 128
    const pixels = new Uint8Array(side * side * 4)
    const noise = noisePixels(side, side)
    for (let pixel = 0; pixel < side * side; pixel += 1) {
      const target = pixel * 4
      const source = pixel * 3
      pixels[target] = noise[source] ?? 0
      pixels[target + 1] = noise[source + 1] ?? 0
      pixels[target + 2] = noise[source + 2] ?? 0
      pixels[target + 3] = pixel & 0xff
    }
    const data = new Uint8Array(await sharp(pixels, { raw: { width: side, height: side, channels: 4 } }).png().toBuffer())

    const canonical = await prepareMasterImage(data, await detectImage(data), { maxDimension: side, maxBytes: 1_024 })

    expect(canonical.data.byteLength).toBeLessThanOrEqual(1_024)
    expect(canonical.width).toBeLessThan(side)
    await expect(detectImage(canonical.data)).resolves.toMatchObject({ hasAlpha: true, depth: 'uchar', space: 'srgb' })
  })

  it('re-encodes an oversized photographic JPEG as JPEG', async () => {
    const data = await noiseImage(64, 32, 'jpeg')
    const detected = await detectImage(data)

    const canonical = await prepareMasterImage(data, detected, { maxDimension: 32, maxBytes: POLICY.maxBytes })

    expect(canonical).toMatchObject({ mediaType: 'image/jpeg', width: 32, height: 16 })
  })

  it('classifies a photographic PNG by pixels and uses an opaque photographic encoding', async () => {
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
    const budget = { maxDimension: 128, maxBytes: POLICY.maxBytes }

    const canonical = await prepareMasterImage(data, detected, budget)

    expect(canonical.mediaType).toBe('image/jpeg')
    expect(canonical).toMatchObject({ width: 128, height: 128 })
    expect(canonical.data.byteLength).toBeLessThanOrEqual(budget.maxBytes)
  })

  it('shrinks dimensions after the quality floor instead of refusing an oversized encoding', async () => {
    const data = await noiseImage(64, 64, 'png')

    const canonical = await prepareMasterImage(data, await detectImage(data), { maxDimension: 2048, maxBytes: 512 })

    expect(canonical.data.byteLength).toBeLessThanOrEqual(512)
    expect(canonical.width).toBeLessThan(64)
    expect(canonical.height).toBeLessThan(64)
  })

  it('re-encodes an in-budget oriented JPEG, baking rotation and stripping metadata', async () => {
    const data = new Uint8Array(await sharp({
      create: { width: 4, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer())
    const detected = await detectImage(data)
    // Orientation 6 rotates 90°: the perceived source is 2x4.
    expect(detected).toMatchObject({ width: 2, height: 4, carriesMetadata: true })

    const canonical = await prepareMasterImage(data, detected, POLICY)

    expect(canonical.data).not.toBe(data)
    expect(canonical).toMatchObject({ width: 2, height: 4 })
    await expect(detectImage(canonical.data)).resolves.toMatchObject({ width: 2, height: 4, carriesMetadata: false })
  })

  it('re-encodes an in-budget image with an ICC profile and strips the profile', async () => {
    const data = new Uint8Array(await sharp({
      create: { width: 4, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).png().withIccProfile('p3').toBuffer())
    const detected = await detectImage(data)
    expect(detected.carriesMetadata).toBe(true)

    const canonical = await prepareMasterImage(data, detected, POLICY)

    expect(canonical.data).not.toBe(data)
    await expect(detectImage(canonical.data)).resolves.toMatchObject({ carriesMetadata: false })
  })

  it('maps an encoder fault on undecodable bytes to a storage failure', async () => {
    const detected = {
      mediaType: 'image/png', width: 5000, height: 5000, animated: false, carriesMetadata: false,
      depth: 'ushort', space: 'rgb16', hasAlpha: true,
    } as const
    await expect(prepareMasterImage(Uint8Array.of(1, 2, 3), detected, POLICY))
      .rejects.toMatchObject({
        code: 'ATTACHMENT_WRITE_FAILED',
        message: 'The 16-bit PNG could not be converted to the canonical 8-bit sRGB form.',
      })
  })

  it.each([
    ['float PNG', { mediaType: 'image/png', depth: 'float' }],
    ['uchar JPEG', { mediaType: 'image/jpeg', depth: 'uchar' }],
  ] as const)('describes a failed %s conversion without exposing the encoder error', async (source, fields) => {
    const detected = {
      ...fields,
      width: 5000,
      height: 5000,
      animated: false,
      carriesMetadata: false,
      space: 'srgb',
      hasAlpha: false,
    } as const

    await expect(prepareMasterImage(Uint8Array.of(1, 2, 3), detected, POLICY))
      .rejects.toMatchObject({
        code: 'ATTACHMENT_WRITE_FAILED',
        message: `The ${source} could not be converted to the canonical 8-bit sRGB form.`,
      })
  })

  it('rejects a converted master whose verified alpha metadata disagrees with the source facts', async () => {
    const data = await flatImage(8, 8, 'png', true)
    const detected = await detectImage(data)

    await expect(prepareMasterImage(data, { ...detected, hasAlpha: false }, {
      maxDimension: 4,
      maxBytes: POLICY.maxBytes,
    })).rejects.toMatchObject({
      code: 'ATTACHMENT_WRITE_FAILED',
      message: 'Canonical image conversion did not produce a single-frame 8-bit sRGB image with matching metadata.',
    })
  })
})

describe('hasLowColourCount', () => {
  it('distinguishes photographic rasters from low-colour graphics without averaged sampling', async () => {
    const side = 512
    const highFrequency = sharp(noisePixels(side, side), { raw: { width: side, height: side, channels: 3 } })
    const gradientPixels = new Uint8Array(side * side * 3)
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const offset = (y * side + x) * 3
        gradientPixels[offset] = x & 0xff
        gradientPixels[offset + 1] = y & 0xff
        gradientPixels[offset + 2] = (x * 3 + y * 5) & 0xff
      }
    }
    const ordinaryPhoto = sharp(gradientPixels, { raw: { width: side, height: side, channels: 3 } })
    const solid = sharp({
      create: { width: side, height: side, channels: 3, background: { r: 12, g: 34, b: 56 } },
    })
    const text = sharp(Buffer.from(`
      <svg width="512" height="256" xmlns="http://www.w3.org/2000/svg">
        <rect width="512" height="256" fill="white"/>
        <text x="24" y="145" font-size="96" fill="#16324f">DeepSeek 16-bit</text>
      </svg>
    `))
    const transparentData = await sharp({
      create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{ input: Buffer.from(`
      <svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
        <circle cx="256" cy="256" r="180" fill="#0f8" fill-opacity="0.7"/>
      </svg>
    `) }]).png().toBuffer()
    const transparent = sharp(transparentData)

    await expect(hasLowColourCount(highFrequency)).resolves.toBe(false)
    await expect(hasLowColourCount(ordinaryPhoto)).resolves.toBe(false)
    await expect(hasLowColourCount(solid)).resolves.toBe(true)
    await expect(hasLowColourCount(text)).resolves.toBe(true)
    await expect(hasLowColourCount(transparent)).resolves.toBe(true)
  })

  it('reads grayscale-alpha samples without treating alpha or the next pixel as RGB', async () => {
    const symbols: number[] = []
    for (let first = 0; first < 32; first += 1) {
      for (let second = 0; second < 32; second += 1) symbols.push(first, second)
    }
    const pixels = new Uint8Array(symbols.length * 2)
    for (const [index, symbol] of symbols.entries()) {
      pixels[index * 2] = symbol * 8
      pixels[index * 2 + 1] = symbol * 8
    }
    const grayscaleAlpha = sharp(pixels, {
      raw: { width: 128, height: 16, channels: 2 },
    })

    await expect(hasLowColourCount(grayscaleAlpha)).resolves.toBe(true)
  })

  it('reads one-channel grayscale samples as equal RGB values', async () => {
    const pixels = new Uint8Array(128 * 16)
    for (let index = 0; index < pixels.length; index += 1) pixels[index] = index & 0xff

    await expect(hasLowColourCount(sharp(pixels, {
      raw: { width: 128, height: 16, channels: 1 },
    }))).resolves.toBe(true)
  })

  it('keeps an antialiased text screenshot readable on the low-colour PNG path', async () => {
    const source = new Uint8Array(await sharp(Buffer.from(`
      <svg width="1024" height="512" xmlns="http://www.w3.org/2000/svg">
        <rect width="1024" height="512" fill="white"/>
        <text x="48" y="290" font-size="170" fill="#112f4d">Readable text</text>
      </svg>
    `)).removeAlpha().png().toBuffer())

    const master = await prepareMasterImage(source, await detectImage(source), {
      maxDimension: 512,
      maxBytes: POLICY.maxBytes,
    })
    const stats = await sharp(master.data).greyscale().stats()

    expect(master).toMatchObject({ mediaType: 'image/png', width: 512, height: 256 })
    expect(stats.channels[0]?.min).toBeLessThan(80)
    expect(stats.channels[0]?.max).toBeGreaterThan(240)
  })
})
