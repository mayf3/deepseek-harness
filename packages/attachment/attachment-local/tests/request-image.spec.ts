import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompressionLimiter } from '../src/compression-limiter.ts'
import LocalAttachmentStore, { previewCropToMaster, requestImageDimensions } from '../src/index.ts'

const homes: string[] = []

async function store(): Promise<LocalAttachmentStore> {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-request-image-'))
  homes.push(dshHome)
  return new LocalAttachmentStore(new Context(), { dshHome })
}

async function image(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(await sharp({
    create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } },
  }).png().toBuffer())
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

describe('request image dimensions', () => {
  it.each([
    [4096, 4096, 800, 800],
    [4096, 2048, 1130, 565],
    [3840, 2160, 1066, 600],
    [320, 240, 320, 240],
  ])('projects %sx%s under 640,000 pixels as %sx%s', (width, height, expectedWidth, expectedHeight) => {
    const projected = requestImageDimensions(width, height, 640_000)
    expect(projected).toEqual({
      width: expectedWidth,
      height: expectedHeight,
    })
    expect(projected.width * projected.height).toBeLessThanOrEqual(640_000)
  })
})

describe('local request-image cache', () => {
  it('derives stable square and wide previews and separates route budgets in the cache key', async () => {
    const attachments = await store()
    const square = (await attachments.saveImage({
      data: await image(2048, 2048), mediaType: 'image/png', name: 'square.png',
    })).ref
    const wide = (await attachments.saveImage({
      data: await image(2048, 1024), mediaType: 'image/png', name: 'wide.png',
    })).ref

    const squareRequest = await attachments.readImageRequest(square, { maxPixels: 640_000, maxBytes: 1024 * 1024 })
    const wideRequest = await attachments.readImageRequest(wide, { maxPixels: 640_000, maxBytes: 1024 * 1024 })
    const repeated = await attachments.readImageRequest(wide, { maxPixels: 640_000, maxBytes: 1024 * 1024 })
    const low = await attachments.readImageRequest(wide, { maxPixels: 512 * 512, maxBytes: 1024 * 1024 })

    expect(squareRequest).toMatchObject({ width: 800, height: 800 })
    expect(wideRequest).toMatchObject({ width: 1130, height: 565 })
    expect(repeated.variantId).toBe(wideRequest.variantId)
    expect(repeated.data).toEqual(wideRequest.data)
    expect(Buffer.from(repeated.data).toString('base64')).toBe(Buffer.from(wideRequest.data).toString('base64'))
    expect(low.variantId).not.toBe(wideRequest.variantId)
    expect(low.width * low.height).toBeLessThanOrEqual(512 * 512 + low.width)
  })

  it('maps preview coordinates to the 2048px master and crops the master instead of the preview', async () => {
    const attachments = await store()
    const pixels = Buffer.alloc(2048 * 1024 * 3)
    for (let y = 0; y < 1024; y += 1) {
      for (let x = 0; x < 2048; x += 1) {
        const offset = (y * 2048 + x) * 3
        pixels[offset] = x < 1024 ? 255 : 0
        pixels[offset + 1] = x < 1024 ? 0 : 255
        pixels[offset + 2] = 0
      }
    }
    const source = new Uint8Array(await sharp(pixels, { raw: { width: 2048, height: 1024, channels: 3 } }).png().toBuffer())
    const master = (await attachments.saveImage({ data: source, mediaType: 'image/png', name: 'halves.png' })).ref
    const preview = await attachments.readImageRequest(master, { maxPixels: 640_000, maxBytes: 1024 * 1024 })
    const previewCrop = {
      previewWidth: preview.width,
      previewHeight: preview.height,
      x: Math.floor(preview.width / 2),
      y: 0,
      width: preview.width - Math.floor(preview.width / 2),
      height: preview.height,
    }
    const mapped = previewCropToMaster(master.width, master.height, previewCrop)

    const cropped = await attachments.cropImage(master, previewCrop)
    const stored = await attachments.readImage(cropped.ref)
    const pixel = await sharp(stored.data).resize(1, 1).removeAlpha().raw().toBuffer()

    expect(mapped).toEqual({ x: 1024, y: 0, width: 1024, height: 1024 })
    expect(cropped.ref.width).toBe(mapped.width)
    expect(cropped.ref.height).toBe(mapped.height)
    expect(pixel[1]).toBeGreaterThan(pixel[0] ?? 0)
  })

  it('classifies opaque PNG pixels and preserves alpha while enforcing the request budget', async () => {
    const attachments = await store()
    const side = 256
    const photoPixels = new Uint8Array(side * side * 3)
    const alphaPixels = new Uint8Array(side * side * 4)
    let state = 0x2545f491
    for (let pixel = 0; pixel < side * side; pixel += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      const photo = pixel * 3
      const alpha = pixel * 4
      photoPixels[photo] = state & 0xff
      photoPixels[photo + 1] = state >> 8 & 0xff
      photoPixels[photo + 2] = state >> 16 & 0xff
      alphaPixels[alpha] = photoPixels[photo] ?? 0
      alphaPixels[alpha + 1] = photoPixels[photo + 1] ?? 0
      alphaPixels[alpha + 2] = photoPixels[photo + 2] ?? 0
      alphaPixels[alpha + 3] = pixel & 0xff
    }
    const photoSource = new Uint8Array(await sharp(photoPixels, {
      raw: { width: side, height: side, channels: 3 },
    }).png().toBuffer())
    const alphaSource = new Uint8Array(await sharp(alphaPixels, {
      raw: { width: side, height: side, channels: 4 },
    }).png().toBuffer())
    const photo = (await attachments.saveImage({ data: photoSource, mediaType: 'image/png' })).ref
    const alpha = (await attachments.saveImage({ data: alphaSource, mediaType: 'image/png' })).ref

    const photoRequest = await attachments.readImageRequest(photo, { maxPixels: 128 * 128, maxBytes: 1024 * 1024 })
    const alphaRequest = await attachments.readImageRequest(alpha, { maxPixels: 128 * 128, maxBytes: 4_096 })

    expect(photoRequest.mediaType).toBe('image/jpeg')
    expect(alphaRequest.bytes).toBeLessThanOrEqual(4_096)
    expect(alphaRequest.width).toBeLessThan(128)
    await expect(sharp(alphaRequest.data).metadata()).resolves.toMatchObject({ hasAlpha: true, depth: 'uchar', space: 'srgb' })
  })

  it.each([3, 4] as const)('projects a 16-bit %s-channel PNG as a bounded 8-bit request image', async (channels) => {
    const attachments = await store()
    const source = new Uint8Array(await sharp({
      create: { width: 64, height: 32, channels, background: { r: 12, g: 34, b: 56, alpha: 0.5 } },
    }).toColourspace('rgb16').png().toBuffer())
    const master = (await attachments.saveImage({ data: source, mediaType: 'image/png' })).ref

    const request = await attachments.readImageRequest(master, { maxPixels: 16 * 16, maxBytes: 1024 * 1024 })

    expect(request.bytes).toBeLessThanOrEqual(1024 * 1024)
    expect(request.width * request.height).toBeLessThanOrEqual(16 * 16)
    await expect(sharp(request.data).metadata()).resolves.toMatchObject({
      depth: 'uchar', space: 'srgb', hasAlpha: channels === 4,
    })
  })

  it('retains an all-opaque alpha channel in a resized request version', async () => {
    const attachments = await store()
    const source = new Uint8Array(await sharp({
      create: { width: 64, height: 32, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } },
    }).png().toBuffer())
    const master = (await attachments.saveImage({ data: source, mediaType: 'image/png' })).ref

    const request = await attachments.readImageRequest(master, { maxPixels: 16 * 16, maxBytes: 1024 * 1024 })

    await expect(sharp(request.data).metadata()).resolves.toMatchObject({ hasAlpha: true })
  })

  it('keeps a complex 640,000-pixel request version below 1 MiB', async () => {
    const attachments = await store()
    const side = 1024
    const pixels = new Uint8Array(side * side * 3)
    let state = 0x6d2b79f5
    for (let index = 0; index < pixels.length; index += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      pixels[index] = state & 0xff
    }
    const source = new Uint8Array(await sharp(pixels, {
      raw: { width: side, height: side, channels: 3 },
    }).png().toBuffer())
    const master = (await attachments.saveImage({ data: source, mediaType: 'image/png' })).ref

    const request = await attachments.readImageRequest(master, { maxPixels: 640_000, maxBytes: 1024 * 1024 })

    expect(request).toMatchObject({ width: 800, height: 800 })
    expect(request.bytes).toBeLessThanOrEqual(1024 * 1024)
  })

  it('shares one request transform between concurrent callers without sharing cancellation', async () => {
    const attachments = await store()
    const master = (await attachments.saveImage({
      data: await image(2048, 1024), mediaType: 'image/png', name: 'shared.png',
    })).ref
    const run = vi.spyOn(CompressionLimiter.prototype, 'run')
    const controller = new AbortController()
    const policy = { maxPixels: 640_000, maxBytes: 1024 * 1024 }

    const cancelled = attachments.readImageRequest(master, policy, controller.signal)
    const completed = attachments.readImageRequest(master, policy)
    const reason = new Error('cancel one waiter')
    controller.abort(reason)

    await expect(cancelled).rejects.toBe(reason)
    await expect(completed).resolves.toMatchObject({ width: 1130, height: 565 })
    expect(run).toHaveBeenCalledTimes(1)
    run.mockRestore()
  })
})
