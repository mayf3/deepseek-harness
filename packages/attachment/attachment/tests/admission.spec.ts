import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { AttachmentError, admitEncodedImages } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment/types'

/** One-pixel valid payloads are irrelevant here: the store below accepts any decoded bytes. */
const PNG = 'AAAA' // canonical base64, 3 bytes

function refOf(input: SaveImageAttachment, ordinal: number): ImageAttachmentRef {
  return {
    attachmentId: `att-${ordinal}` as ImageAttachmentRef['attachmentId'],
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    width: 1,
    height: 1,
    ...input.name === undefined ? {} : { name: input.name },
  }
}

/** In-memory store double recording call order; limits are per-test. */
function storeOf(limits?: Partial<AttachmentStore['imageLimits']>) {
  const calls: string[] = []
  let saved = 0
  const store = {
    imageLimits: {
      maxImageBytes: 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 1024,
      maxImagePixels: 1_000_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      ...limits,
    },
    validateImage: vi.fn((input: SaveImageAttachment) => {
      calls.push(`validate:${input.name ?? input.mediaType}`)
      return Promise.resolve()
    }),
    saveImage: vi.fn((input: SaveImageAttachment) => {
      calls.push(`save:${input.name ?? input.mediaType}`)
      saved += 1
      return Promise.resolve(refOf(input, saved))
    }),
  }
  return { store: store as unknown as AttachmentStore, calls, mocks: store }
}

describe('admitEncodedImages', () => {
  it('validates the whole batch before saving any member and returns refs in caller order', async () => {
    const { store, calls } = storeOf()
    const refs = await admitEncodedImages(store, [
      { mediaType: 'image/png', data: PNG, name: 'first.png' },
      { mediaType: 'image/jpeg', data: PNG, name: 'second.jpg' },
    ])
    expect(calls).toEqual(['validate:first.png', 'validate:second.jpg', 'save:first.png', 'save:second.jpg'])
    expect(refs.map(ref => ref.name)).toEqual(['first.png', 'second.jpg'])
    expect(refs.map(ref => ref.attachmentId)).toEqual(['att-1', 'att-2'])
  })

  it('omits the name from store inputs when the upload has none', async () => {
    const { store, mocks } = storeOf()
    const refs = await admitEncodedImages(store, [{ mediaType: 'image/webp', data: PNG }])
    expect(mocks.saveImage).toHaveBeenCalledWith({ data: expect.any(Uint8Array) as unknown, mediaType: 'image/webp' })
    expect(refs[0]?.name).toBeUndefined()
  })

  it('admits an empty batch without touching the store', async () => {
    const { store, mocks } = storeOf()
    await expect(admitEncodedImages(store, [])).resolves.toEqual([])
    expect(mocks.validateImage).not.toHaveBeenCalled()
    expect(mocks.saveImage).not.toHaveBeenCalled()
  })

  it('rejects a batch above the image-count limit before decoding', async () => {
    const { store, mocks } = storeOf({ maxImagesPerMessage: 1 })
    const batch = [
      { mediaType: 'image/png' as const, data: PNG },
      { mediaType: 'image/png' as const, data: 'not base64!!' },
    ]
    await expect(admitEncodedImages(store, batch)).rejects.toMatchObject({
      name: 'AttachmentError',
      code: 'TOO_MANY_IMAGES',
    })
    expect(mocks.saveImage).not.toHaveBeenCalled()
  })

  it('rejects a batch above the aggregate byte limit without saving', async () => {
    const { store, mocks } = storeOf({ maxMessageImageBytes: 5 })
    await expect(admitEncodedImages(store, [
      { mediaType: 'image/png', data: PNG },
      { mediaType: 'image/png', data: PNG },
    ])).rejects.toMatchObject({ code: 'IMAGES_TOO_LARGE' })
    expect(mocks.saveImage).not.toHaveBeenCalled()
  })

  it('admits a batch exactly at both limits', async () => {
    const { store } = storeOf({ maxImagesPerMessage: 2, maxMessageImageBytes: 6 })
    await expect(admitEncodedImages(store, [
      { mediaType: 'image/png', data: PNG },
      { mediaType: 'image/png', data: PNG },
    ])).resolves.toHaveLength(2)
  })

  it('rejects non-canonical and empty base64 payloads', async () => {
    const { store, mocks } = storeOf()
    for (const data of ['', 'AAA', '!!!!']) {
      await expect(admitEncodedImages(store, [{ mediaType: 'image/png', data }]))
        .rejects.toMatchObject({ code: 'INVALID_IMAGE_BASE64' })
    }
    expect(mocks.saveImage).not.toHaveBeenCalled()
  })

  it('propagates a store validation failure without saving any member', async () => {
    const { store, mocks } = storeOf()
    mocks.validateImage.mockRejectedValueOnce(new AttachmentError('too many pixels', 'IMAGE_TOO_MANY_PIXELS'))
    await expect(admitEncodedImages(store, [
      { mediaType: 'image/png', data: PNG },
      { mediaType: 'image/png', data: PNG },
    ])).rejects.toMatchObject({ code: 'IMAGE_TOO_MANY_PIXELS' })
    expect(mocks.saveImage).not.toHaveBeenCalled()
  })
})
