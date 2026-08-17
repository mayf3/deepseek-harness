/** Batch admission of base64-encoded image uploads. @module @deepseek-ai/dsh-attachment/admission */

import { Buffer } from 'node:buffer'
import { AttachmentError } from './error.ts'
import type { AttachmentStore } from './index.ts'
import type { EncodedImageAttachment, ImageAttachmentRef, SaveImageAttachment } from './types.ts'

/** Decode one upload payload while rejecting non-canonical base64 forms. */
function decodeBase64(data: string): Uint8Array {
  const decoded = Buffer.from(data, 'base64')
  if (data.length === 0 || decoded.toString('base64') !== data) {
    throw new AttachmentError('Image upload is not canonical base64.', 'INVALID_IMAGE_BASE64')
  }
  return new Uint8Array(decoded)
}

/** Store input for one decoded upload. */
function saveInput(image: EncodedImageAttachment, data: Uint8Array): SaveImageAttachment {
  return {
    data,
    mediaType: image.mediaType,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/**
 * Validate one wire image batch against the per-message limits and durably
 * commit every member. The whole batch is validated before any member is
 * saved, so a rejected batch publishes no durable object.
 * @param attachments - the deployment attachment store enforcing per-image policy.
 * @param images - base64-encoded uploads in caller order.
 * @returns durable references in the same order as `images`.
 * @throws AttachmentError on a non-canonical payload or an exceeded batch limit.
 */
export async function admitEncodedImages(
  attachments: AttachmentStore,
  images: readonly EncodedImageAttachment[],
): Promise<ImageAttachmentRef[]> {
  const limits = attachments.imageLimits
  if (images.length > limits.maxImagesPerMessage) {
    throw new AttachmentError('Upload exceeds the configured image-count limit.', 'TOO_MANY_IMAGES')
  }
  const decoded = images.map(image => ({ image, data: decodeBase64(image.data) }))
  const totalBytes = decoded.reduce((sum, item) => sum + item.data.byteLength, 0)
  if (totalBytes > limits.maxMessageImageBytes) {
    throw new AttachmentError('Upload exceeds the configured aggregate image-byte limit.', 'IMAGES_TOO_LARGE')
  }
  for (const item of decoded) {
    await attachments.validateImage(saveInput(item.image, item.data))
  }
  const refs: ImageAttachmentRef[] = []
  for (const item of decoded) {
    refs.push(await attachments.saveImage(saveInput(item.image, item.data)))
  }
  return refs
}
