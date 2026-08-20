/** Local durable attachment backend rooted below `DSH_HOME`. @module @deepseek-ai/dsh-attachment-local */

import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  ImageRequestPolicy,
  PreviewImageCrop,
  RequestImageAttachment,
  SaveImageAttachment,
  SavedImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { MasterImagePolicy } from './canonical.ts'
import { CompressionLimiter } from './compression-limiter.ts'
import { commitPreparedImageFile, prepareImageFile, readImageFile, validateImageFile } from './store.ts'
import { previewCropToMaster, readRequestImageFile, requestImageVariantId } from './request-image.ts'

export { isMasterImage, prepareMasterImage } from './canonical.ts'
export type { MasterImage, MasterImagePolicy } from './canonical.ts'
export { commitPreparedImageFile, prepareImageFile, readImageFile, saveImageFile, validateImageFile } from './store.ts'
export type { PreparedImageFile } from './store.ts'
export { previewCropToMaster, readRequestImageFile, requestImageDimensions, requestImageVariantId } from './request-image.ts'

/** Default maximum encoded bytes for one submitted image; oversized sources are refused, not shrunk. */
export const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024
/** Default maximum images in one prompt. */
export const DEFAULT_MAX_IMAGES_PER_MESSAGE = 20
/** Default maximum aggregate image bytes in one prompt. */
export const DEFAULT_MAX_MESSAGE_IMAGE_BYTES = 100 * 1024 * 1024
/** Default maximum intrinsic pixels for one submitted image. */
export const DEFAULT_MAX_IMAGE_PIXELS = 100_000_000
/** Default per-side pixel cap for one submitted image. */
export const DEFAULT_MAX_IMAGE_DIMENSION = 16384
/**
 * Default long-edge target of the stored image master. A larger source
 * is admitted and downscaled to this edge, so admission bounds what rides
 * every later model request without refusing ordinary large sources.
 */
export const DEFAULT_MASTER_MAX_DIMENSION = 2048
/** Default independent safety cap for one stored master version. */
export const DEFAULT_MASTER_MAX_BYTES = 4 * 1024 * 1024
/** Conservative default number of simultaneous native image transformations per store. */
export const DEFAULT_IMAGE_COMPRESSION_CONCURRENCY = 2
/** Maximum configurable native image transformations per store. */
export const MAX_IMAGE_COMPRESSION_CONCURRENCY = 8

/** Local attachment backend configuration. */
export interface Config {
  /** Explicit harness home; omitted follows `DSH_HOME`, then `~/.dsh`. */
  dshHome?: string
  /** Maximum encoded bytes accepted for one submitted image. */
  maxImageBytes?: number
  /** Maximum image count accepted in one submitted message. */
  maxImagesPerMessage?: number
  /** Maximum aggregate encoded image bytes accepted in one submitted message. */
  maxMessageImageBytes?: number
  /** Maximum intrinsic width multiplied by height accepted for one submitted image. */
  maxImagePixels?: number
  /** Maximum intrinsic width and maximum intrinsic height accepted for one submitted image. */
  maxImageDimension?: number
  /** Long-edge pixel cap of the stored provider-independent master version. */
  masterMaxDimension?: number
  /** Encoded-byte safety cap of the stored provider-independent master version. */
  masterMaxBytes?: number
  /** Maximum simultaneous master or request-image transformations in this service instance. */
  imageCompressionConcurrency?: number
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error
    ? reason
    : new Error('Attachment request cancelled with a non-Error reason.', { cause: reason })
}

class SharedRequest<T> {
  readonly controller = new AbortController()
  readonly promise: Promise<T>
  private settled = false
  private waiters = 0

  constructor(start: (signal: AbortSignal) => Promise<T>) {
    this.promise = start(this.controller.signal).finally(() => {
      this.settled = true
    })
  }

  wait(signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    this.waiters += 1
    if (signal === undefined) return this.promise.finally(() => this.release(false))
    let released = false
    const release = (cancelled: boolean): void => {
      if (released) return
      released = true
      this.release(cancelled, signal)
    }
    return new Promise<T>((resolve, reject) => {
      const abort = (): void => {
        release(true)
        reject(abortReason(signal))
      }
      signal.addEventListener('abort', abort, { once: true })
      void this.promise.then((value) => {
        signal.removeEventListener('abort', abort)
        release(false)
        resolve(value)
      }, (error: unknown) => {
        signal.removeEventListener('abort', abort)
        release(false)
        reject(error)
      })
    })
  }

  private release(cancelled: boolean, signal?: AbortSignal): void {
    this.waiters -= 1
    if (cancelled && this.waiters === 0 && !this.settled && signal !== undefined) {
      this.controller.abort(abortReason(signal))
    }
  }
}

/** Persistent content-addressed local attachment store. */
export class LocalAttachmentStore extends AttachmentStore {
  static Config: z<Config> = z.object({
    dshHome: z.string(),
    maxImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_BYTES),
    maxImagesPerMessage: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGES_PER_MESSAGE),
    maxMessageImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_IMAGE_BYTES),
    maxImagePixels: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_PIXELS),
    maxImageDimension: z.number().step(1).min(1).default(DEFAULT_MAX_IMAGE_DIMENSION),
    masterMaxDimension: z.number().step(1).min(1).default(DEFAULT_MASTER_MAX_DIMENSION),
    masterMaxBytes: z.number().step(1).min(1).default(DEFAULT_MASTER_MAX_BYTES),
    imageCompressionConcurrency: z.number().step(1).min(1).max(MAX_IMAGE_COMPRESSION_CONCURRENCY)
      .default(DEFAULT_IMAGE_COMPRESSION_CONCURRENCY),
  })

  /** Absolute versioned storage root. */
  readonly root: string
  readonly imageLimits: ImageAttachmentLimits
  /** Resolved provider-independent master-version storage policy. */
  readonly masterPolicy: Readonly<MasterImagePolicy>
  /** Resolved instance-level compression limit. */
  readonly imageCompressionConcurrency: number
  private readonly compression: CompressionLimiter
  private readonly requestInflight = new Map<string, SharedRequest<RequestImageAttachment>>()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = resolve(join(resolveDshHome(config.dshHome), 'attachments', 'v1'))
    this.imageLimits = Object.freeze({
      maxImageBytes: config.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES,
      maxImagesPerMessage: config.maxImagesPerMessage ?? DEFAULT_MAX_IMAGES_PER_MESSAGE,
      maxMessageImageBytes: config.maxMessageImageBytes ?? DEFAULT_MAX_MESSAGE_IMAGE_BYTES,
      maxImagePixels: config.maxImagePixels ?? DEFAULT_MAX_IMAGE_PIXELS,
      maxImageDimension: config.maxImageDimension ?? DEFAULT_MAX_IMAGE_DIMENSION,
      mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    })
    this.masterPolicy = Object.freeze({
      maxDimension: config.masterMaxDimension ?? DEFAULT_MASTER_MAX_DIMENSION,
      maxBytes: config.masterMaxBytes ?? DEFAULT_MASTER_MAX_BYTES,
    })
    const compressionConcurrency = config.imageCompressionConcurrency ?? DEFAULT_IMAGE_COMPRESSION_CONCURRENCY
    if (!Number.isSafeInteger(compressionConcurrency)
      || compressionConcurrency < 1
      || compressionConcurrency > MAX_IMAGE_COMPRESSION_CONCURRENCY) {
      throw new Error(
        `attachment-local: imageCompressionConcurrency must be an integer from 1 through ${MAX_IMAGE_COMPRESSION_CONCURRENCY}`,
      )
    }
    this.imageCompressionConcurrency = compressionConcurrency
    this.compression = new CompressionLimiter(compressionConcurrency)
  }

  async validateImage(input: SaveImageAttachment): Promise<void> {
    await this.compression.run(() => validateImageFile(input, this.imageLimits, this.masterPolicy))
  }

  override async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]> {
    this.validateImageBatch(inputs)
    const prepared = await Promise.all(inputs.map(input => this.compression.run(
      () => prepareImageFile(input, this.imageLimits, this.masterPolicy),
    )))
    const refs: ImageAttachmentRef[] = []
    for (const image of prepared) refs.push((await commitPreparedImageFile(this.root, image)).ref)
    return refs
  }

  async saveImage(input: SaveImageAttachment): Promise<SavedImageAttachment> {
    const prepared = await this.compression.run(
      () => prepareImageFile(input, this.imageLimits, this.masterPolicy),
    )
    return commitPreparedImageFile(this.root, prepared)
  }

  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment> {
    return readImageFile(this.root, ref, signal)
  }

  override async readImageRequest(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<RequestImageAttachment> {
    return this.requestVersion(ref, policy, undefined, signal)
  }

  override async readImageRequests(
    refs: readonly ImageAttachmentRef[],
    policy: ImageRequestPolicy,
    signal?: AbortSignal,
  ): Promise<readonly RequestImageAttachment[]> {
    return Promise.all(refs.map(ref => this.requestVersion(ref, policy, undefined, signal)))
  }

  private requestVersion(
    ref: ImageAttachmentRef,
    policy: ImageRequestPolicy,
    master: StoredImageAttachment | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RequestImageAttachment> {
    signal?.throwIfAborted()
    const variantId = requestImageVariantId(ref, policy)
    const key = String(variantId)
    let operation = this.requestInflight.get(key)
    if (operation?.controller.signal.aborted) {
      this.requestInflight.delete(key)
      operation = undefined
    }
    if (operation === undefined) {
      const shared = new SharedRequest<RequestImageAttachment>(sharedSignal => this.compression.run(async () => readRequestImageFile(
        this.root,
        master ?? await this.readImage(ref, sharedSignal),
        policy,
        sharedSignal,
      )))
      operation = shared
      this.requestInflight.set(key, shared)
      void shared.promise.finally(() => {
        if (this.requestInflight.get(key) === shared) this.requestInflight.delete(key)
      }).catch(() => {})
    }
    return operation.wait(signal)
  }

  override async cropImage(
    ref: ImageAttachmentRef,
    crop: PreviewImageCrop,
    signal?: AbortSignal,
  ): Promise<SavedImageAttachment> {
    const master = await this.readImage(ref, signal)
    const region = previewCropToMaster(ref.width, ref.height, crop)
    const version = await this.requestVersion(ref, {
      maxPixels: region.width * region.height,
      maxBytes: this.masterPolicy.maxBytes,
      crop: region,
    }, master, signal)
    signal?.throwIfAborted()
    const stem = ref.name?.replace(/\.[^.]+$/u, '') ?? String(ref.attachmentId).slice(0, 15)
    return this.saveImage({
      data: version.data,
      mediaType: version.mediaType,
      name: `${stem}-crop.${version.mediaType.slice('image/'.length).replace('jpeg', 'jpg')}`,
    })
  }
}

export default LocalAttachmentStore
