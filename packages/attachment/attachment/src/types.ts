/** Durable attachment vocabulary. @module @deepseek-ai/dsh-attachment/types */

import type { AttachmentId, ImageVariantId } from './brand.ts'

export type { AttachmentId } from './brand.ts'

/** Raster image formats accepted by the version-one attachment path. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Durable, serializable metadata for one immutable image object. */
export interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
  /** Perceived source width before master-version downscaling; present only when it differs from {@link width}. */
  sourceWidth?: number
  /** Perceived source height before master-version downscaling; present only when it differs from {@link height}. */
  sourceHeight?: number
}

/** Deployment-resolved limits used by upload admission and request buffering. */
export interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  /** Maximum intrinsic width and maximum intrinsic height in pixels for one image. */
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}

/** Base64-encoded image upload accompanying one wire request. */
export interface EncodedImageAttachment {
  /** Declared media type, verified against the decoded bytes during admission. */
  mediaType: ImageMediaType
  /** Canonical base64 encoding of the image bytes. */
  data: string
  /** Optional display name; it is never interpreted as a path. */
  name?: string
}

/** Request to validate and durably commit one image. */
export interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}

/** Stored image bytes returned after reference and digest verification. */
export interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}

/** Deterministic request-image policy selected by one exact model route. */
export interface ImageRequestPolicy {
  /** Maximum width multiplied by height after aspect-preserving projection. */
  maxPixels: number
  /** Encoded-byte cap before base64 expansion or Files API upload. */
  maxBytes: number
}

/** Cached request version derived from one provider-independent master attachment. */
export interface RequestImageAttachment {
  /** Cache and upload-index key over the master id, policy, and fixed encoder parameters. */
  variantId: ImageVariantId
  /** Durable master reference from which this request version was derived. */
  master: ImageAttachmentRef
  /** Encoded request bytes. */
  data: Uint8Array
  mediaType: ImageMediaType
  bytes: number
  width: number
  height: number
  /** Provider-compatible sample depth proven after request encoding. */
  depth: 'uchar'
  /** Provider-compatible color space proven after request encoding. */
  space: 'srgb'
  /** Whether the encoded request version retains an alpha channel. */
  hasAlpha: boolean
}

/** Intrinsic facts of the submitted source raster, before master-version preparation. */
export interface SourceImageInfo {
  /** Media type verified from the submitted bytes. */
  mediaType: ImageMediaType
  /** Exact submitted encoded byte length. */
  bytes: number
  /** Perceived source width in pixels, with any EXIF orientation applied, so it shares axes with the stored raster. */
  width: number
  /** Perceived source height in pixels, with any EXIF orientation applied, so it shares axes with the stored raster. */
  height: number
}

/** Commit result pairing the durable reference with the submitted source raster it was derived from. */
export interface SavedImageAttachment {
  /** Durable reference describing the stored bytes. */
  ref: ImageAttachmentRef
  /** Submitted source raster facts; equals the `ref` fields when the store kept the submitted bytes. */
  source: SourceImageInfo
}
