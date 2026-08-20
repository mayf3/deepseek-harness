/**
 * Deterministic canonical image encoding. Admission stores this encoding, so
 * the same source bytes always publish the same content address on one
 * runtime: encoder parameters are fixed here, never configurable, because a
 * parameter change would silently split the content-addressed space. The
 * deployment chooses only the canonical budget (long edge and byte target).
 */

import sharp, { type Sharp } from 'sharp'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { DetectedImage } from './image.ts'

/** Deployment-resolved canonical encoding budget. */
export interface CanonicalImagePolicy {
  /** Long-edge target in pixels; a larger source is downscaled proportionally. */
  maxDimension: number
  /** Encoded-byte target; a larger encoding falls down the fixed quality ladder. */
  maxBytes: number
}

/** Canonical bytes beside the facts a durable reference records about them. */
export interface CanonicalImage {
  data: Uint8Array
  mediaType: ImageMediaType
  width: number
  height: number
}

/** JPEG quality ladder tried in order once the preferred encoding exceeds the byte target. */
const JPEG_QUALITIES = [85, 75, 60, 45] as const

/** Encode one prepared pipeline and report the exact output facts. */
async function encode(pipeline: Sharp, mediaType: 'image/png' | 'image/jpeg'): Promise<CanonicalImage> {
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), mediaType, width: info.width, height: info.height }
}

/**
 * Whether stored bytes may be the submitted bytes unchanged. Byte-identical
 * passthrough is preferred whenever the source already fits the budget: it
 * keeps re-submissions of the same original deduplicating to the same object
 * and never re-encodes what no policy requires changing. GIF is excluded —
 * only its first frame is model-visible, so admission pins that meaning into
 * the stored object instead of letting each provider drop frames differently.
 * @param detected - verified source format and dimensions.
 * @param bytes - submitted encoded byte length.
 * @param policy - resolved canonical budget.
 * @returns whether the submitted encoding already is canonical.
 */
export function isCanonical(detected: DetectedImage, bytes: number, policy: CanonicalImagePolicy): boolean {
  return detected.mediaType !== 'image/gif'
    && bytes <= policy.maxBytes
    && Math.max(detected.width, detected.height) <= policy.maxDimension
}

/**
 * Produce the canonical encoding of one fully validated source raster.
 * Passthrough returns the submitted array; every re-encode bakes EXIF
 * orientation into pixels, strips metadata, downscales to the policy's long
 * edge, and encodes with fixed parameters: PNG (palette) for sources that
 * carry alpha or were PNG/GIF, JPEG for photographic sources, falling down
 * one fixed JPEG quality ladder until the byte target holds.
 * @param data - submitted encoded bytes, already fully decoded by admission.
 * @param detected - verified source format and dimensions.
 * @param policy - resolved canonical budget.
 * @returns canonical bytes and their reference facts.
 * @throws AttachmentError `IMAGE_TOO_LARGE` when the smallest ladder step still exceeds the byte target.
 */
export async function canonicalizeImage(
  data: Uint8Array,
  detected: DetectedImage,
  policy: CanonicalImagePolicy,
): Promise<CanonicalImage> {
  if (isCanonical(detected, data.byteLength, policy)) {
    return { data, mediaType: detected.mediaType, width: detected.width, height: detected.height }
  }
  try {
    const source = sharp(data, { failOn: 'error', limitInputPixels: false })
    const { hasAlpha } = await source.metadata()
    const prepared = source.rotate().resize({
      width: policy.maxDimension,
      height: policy.maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    const preferPng = hasAlpha || detected.mediaType === 'image/png' || detected.mediaType === 'image/gif'
    if (preferPng) {
      const png = await encode(prepared.clone().png({ compressionLevel: 9, palette: true }), 'image/png')
      if (png.data.byteLength <= policy.maxBytes) return png
    }
    for (const quality of JPEG_QUALITIES) {
      const jpeg = await encode(
        prepared.clone().flatten({ background: '#ffffff' }).jpeg({ quality }),
        'image/jpeg',
      )
      if (jpeg.data.byteLength <= policy.maxBytes) return jpeg
    }
  } catch (error) {
    throw new AttachmentError('Unable to canonicalize image attachment.', 'ATTACHMENT_WRITE_FAILED', { cause: error })
  }
  throw new AttachmentError('Image cannot be encoded within the configured canonical byte target.', 'IMAGE_TOO_LARGE')
}
