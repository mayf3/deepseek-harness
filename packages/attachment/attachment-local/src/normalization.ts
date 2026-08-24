/** Deterministic provider-independent image normalization. */

import sharp, { type Sharp } from 'sharp'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { encodeFirstWithinLimit, isExhaustedEncoding } from './encoding.ts'
import { detectImage, encodedAlphaIsCompatible } from './image.ts'
import type { DetectedImage } from './image.ts'

/** Deployment-resolved policy for the persisted normalized attachment. */
export interface NormalizationPolicy {
  /** Long-edge cap in pixels; larger sources are downscaled proportionally. */
  maxDimension: number
  /** Encoded-byte target for the quality ladder; the smallest ladder output is kept when no quality fits. */
  maxBytes: number
}

/** Normalized bytes beside the facts recorded by a durable reference. */
export interface NormalizedImage {
  data: Uint8Array
  mediaType: ImageMediaType
  width: number
  height: number
}

/** Shared ladder for both encoders: spaced so each step buys a real size reduction. */
export const IMAGE_ENCODING_QUALITIES = [85, 75, 60] as const
/** Fixed lossy-WebP effort; deeper search costs 3-4x encode time for about 5% size. */
export const WEBP_ENCODING_EFFORT = 0

/** Encode one prepared pipeline and report exact output facts. */
async function encode(
  pipeline: Sharp,
  mediaType: 'image/jpeg' | 'image/webp',
  quality: number,
): Promise<NormalizedImage> {
  const encoded = mediaType === 'image/webp'
    ? pipeline.webp({ quality, effort: WEBP_ENCODING_EFFORT })
    : pipeline.jpeg({ quality })
  const { data, info } = await encoded.toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data), mediaType, width: info.width, height: info.height }
}

/**
 * Whether bytes already satisfy the normalization requirements.
 * @param detected - fully decoded source facts.
 * @param bytes - encoded source length.
 * @param policy - resolved normalization limits.
 * @returns whether the source can pass through byte-identically.
 */
export function canPassThroughNormalization(
  detected: DetectedImage,
  bytes: number,
  policy: NormalizationPolicy,
): boolean {
  return detected.mediaType !== 'image/gif'
    && !detected.animated
    && !detected.carriesMetadata
    && detected.depth === 'uchar'
    && detected.space === 'srgb'
    && bytes <= policy.maxBytes
    && Math.max(detected.width, detected.height) <= policy.maxDimension
}

/** Assert that a normalized output is an 8-bit sRGB/sRGBA single-frame image with matching facts. */
async function verifyNormalizedImage(
  image: NormalizedImage,
  expectedAlpha: boolean | undefined,
): Promise<NormalizedImage> {
  const detected = await detectImage(image.data)
  if (detected.mediaType !== image.mediaType
    || detected.width !== image.width
    || detected.height !== image.height
    || detected.animated
    || detected.carriesMetadata
    || detected.depth !== 'uchar'
    || detected.space !== 'srgb'
    || !encodedAlphaIsCompatible(expectedAlpha, detected)) {
    throw new AttachmentError(
      'Image normalization did not produce a single-frame 8-bit sRGB image with matching metadata.',
      'ATTACHMENT_WRITE_FAILED',
    )
  }
  return image
}

/** Build one fixed-size, oriented, metadata-free sRGB pipeline from submitted bytes. */
function preparedPipeline(data: Uint8Array, width: number, height: number): Sharp {
  return sharp(data, { failOn: 'error', limitInputPixels: false })
    .rotate()
    .toColourspace('srgb')
    .resize({ width, height, fit: 'inside', withoutEnlargement: true })
}

/** Dimensions after the long edge is capped without changing aspect ratio. */
function initialDimensions(detected: DetectedImage, maxDimension: number): { width: number; height: number } {
  const scale = Math.min(1, maxDimension / Math.max(detected.width, detected.height))
  return {
    width: Math.max(1, Math.round(detected.width * scale)),
    height: Math.max(1, Math.round(detected.height * scale)),
  }
}

/** Lazy quality ladder: WebP keeps a source alpha channel, everything else is JPEG. */
function encodingAttempts(
  data: Uint8Array,
  width: number,
  height: number,
  hasAlpha: boolean,
): Array<() => Promise<NormalizedImage>> {
  const prepared = preparedPipeline(data, width, height)
  const mediaType = hasAlpha ? 'image/webp' : 'image/jpeg'
  return IMAGE_ENCODING_QUALITIES.map(quality => (
    () => encode(prepared.clone(), mediaType, quality)
  ))
}

/**
 * Produce the persisted provider-independent normalized version of one fully decoded source.
 * The source is passed through only when it is already clean, single-frame, 8-bit sRGB/sRGBA,
 * and inside both normalization limits. Re-encoding never removes transparency. When every
 * ladder quality exceeds the byte target, the smallest ladder output is kept; provider byte
 * caps stay enforced at the route that transmits the bytes.
 * @param data - complete admitted source bytes.
 * @param detected - fully decoded source facts.
 * @param policy - resolved independent normalization limits.
 * @returns verified provider-independent normalized bytes and metadata.
 */
export async function normalizeImage(
  data: Uint8Array,
  detected: DetectedImage,
  policy: NormalizationPolicy,
): Promise<NormalizedImage> {
  if (canPassThroughNormalization(detected, data.byteLength, policy)) {
    return { data, mediaType: detected.mediaType, width: detected.width, height: detected.height }
  }
  try {
    const { width, height } = initialDimensions(detected, policy.maxDimension)
    const encoded = await encodeFirstWithinLimit(
      encodingAttempts(data, width, height, detected.hasAlpha),
      policy.maxBytes,
    )
    const chosen = isExhaustedEncoding(encoded) ? encoded.smallest : encoded
    return await verifyNormalizedImage(chosen, detected.mediaType === 'image/gif' ? undefined : detected.hasAlpha)
  } catch (error) {
    if (error instanceof AttachmentError) throw error
    const source = detected.mediaType === 'image/png' && detected.depth !== 'uchar'
      ? `${detected.depth === 'ushort' ? '16-bit' : detected.depth} PNG`
      : `${detected.depth} ${detected.mediaType.slice('image/'.length).toUpperCase()}`
    throw new AttachmentError(
      `The ${source} could not be converted to the normalized 8-bit sRGB form.`,
      'ATTACHMENT_WRITE_FAILED',
      { cause: error },
    )
  }
}
