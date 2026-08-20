/**
 * The model-facing image tools: `read_image` commits a PNG/JPEG/WebP/GIF file,
 * while `read_image_region` crops a session-authorized durable attachment by
 * coordinates measured on the exact preview shown to the model.
 *
 * The route gate is deliberately stricter than the host upload preflight. An
 * image-reading tool is useful only when the exact calling route can inspect
 * its result, so unknown capability refuses instead of relying on an adapter
 * failure after filesystem and attachment work.
 * @module @deepseek-ai/dsh-tool-fs/src/read-image
 */

import { basename, extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType, PreviewImageCrop } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { resolveRegularReadTarget } from './read-target.ts'

/** Extensions `read_image` accepts; magic-byte validation at the attachment service stays authoritative. */
const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** The structured outcome declared by the `read_image` output schema. */
export interface ImageReadValue {
  path: string
  image: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
    /** Intrinsic width of the file on disk; present only when storage downscaled it. */
    sourceWidth?: number
    /** Intrinsic height of the file on disk; present only when storage downscaled it. */
    sourceHeight?: number
  }
}

/** Structured result of cropping a session-authorized image attachment. */
export interface ImageRegionReadValue {
  sourceAttachmentId: string
  preview: { width: number; height: number }
  crop: { x: number; y: number; width: number; height: number }
  image: ImageReadValue['image']
}

/**
 * Map a model-supplied path to its declared image media type by extension.
 * @param filePath - the raw `file_path` argument (not yet resolved).
 * @returns the declared media type, or undefined when the path does not claim an image.
 */
export function imageMediaTypeForPath(filePath: string): ImageMediaType | undefined {
  return IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]
}

/**
 * Enforce the strict image-capability gate for the calling route. Resolves the
 * session's latest routed provider/model (request header config, then agent
 * options) and requires the exact resolved route to declare `image` input explicitly.
 * @param ctx - the plugin context used to resolve the optional `llm` service.
 * @param exec - the tool-execution context supplying the calling agent.
 * @param requestedPath - the raw, not-yet-resolved path rendered in refusal messages.
 */
export async function assertImageCapableRoute(ctx: Context, exec: ToolExecution, requestedPath: string): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error(`cannot read "${requestedPath}" as an image: the current model route could not be resolved`)
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`cannot read "${requestedPath}" as an image: model "${model}" does not declare image input; switch to an image-capable model to read images`)
  }
}

/**
 * Re-brand a structured image outcome into the durable attachment reference an
 * `ImageBlock` carries.
 * @param image - the image metadata from the output schema.
 * @returns the branded attachment reference.
 */
export function imageRefFromValue(image: ImageReadValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
    ...image.sourceWidth === undefined ? {} : { sourceWidth: image.sourceWidth },
    ...image.sourceHeight === undefined ? {} : { sourceHeight: image.sourceHeight },
  }
}

function findImageRef(
  content: readonly ContentBlock[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const block of content) {
    if (block.type === 'image' && block.attachment.attachmentId === attachmentId) return block.attachment
    if (block.type === 'tool-result') {
      const nested = findImageRef(block.content, attachmentId)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function sessionImageRef(exec: ToolExecution, attachmentId: string): ImageAttachmentRef {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new Error('read_image_region requires an active agent session')
  }
  for (const message of session.deriveMessages()) {
    const ref = findImageRef(message.content, attachmentId)
    if (ref !== undefined) return ref
  }
  throw new Error(`attachment "${attachmentId}" is not referenced by the current session`)
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function regionReadContent(value: ImageRegionReadValue): ContentBlock[] {
  return [
    {
      type: 'text',
      text: `<attachment>${value.sourceAttachmentId}</attachment>\n<type>image-region</type>\n<content>\n`
        + `preview ${value.preview.width}x${value.preview.height} px; crop `
        + `x=${value.crop.x}, y=${value.crop.y}, width=${value.crop.width}, height=${value.crop.height}; `
        + `result ${value.image.width}x${value.image.height} px\n</content>`,
    },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}

/**
 * Format an image read as the model-facing envelope beside its image block.
 * A downscaled read names the on-disk dimensions and the multiplier that maps
 * coordinates measured on the attached image back onto the original file.
 * @param displayPath - the backend-resolved path rendered in the envelope's `<path>` element.
 * @param image - the image metadata to summarize.
 * @returns the model-facing envelope; the image itself rides the adjacent image block.
 */
export function formatImageReadOutput(displayPath: string, image: ImageReadValue['image']): string {
  let scaled = ''
  if (image.sourceWidth !== undefined && image.sourceHeight !== undefined) {
    // Integer rounding can give the two axes slightly different ratios, so the
    // advice names one multiplier only when both round to the same value.
    const x = (image.sourceWidth / image.width).toFixed(2)
    const y = (image.sourceHeight / image.height).toFixed(2)
    const advice = x === y
      ? `multiply coordinates by ${x}`
      : `multiply x coordinates by ${x} and y coordinates by ${y}`
    scaled = ` (downscaled from ${image.sourceWidth}x${image.sourceHeight} px; ${advice} to locate features in the original file)`
  }
  return `<path>${displayPath}</path>
<type>image</type>
<content>
${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}
</content>`
}

/**
 * Project one structured image read into its model-facing envelope and image.
 * @param value - the image-read outcome.
 * @returns the two content blocks used by native and nested dispatches.
 */
function imageReadContent(value: ImageReadValue): ContentBlock[] {
  return [
    { type: 'text', text: formatImageReadOutput(value.path, value.image) },
    { type: 'image', attachment: imageRefFromValue(value.image) },
  ]
}

/**
 * Register the `read_image` tool into the given context. The composing plugin
 * owns the attachments gate: `src/index.ts` calls this inside
 * `ctx.inject(['attachments'], …)` so the tool exists only while a durable
 * store is mounted. Execution still re-checks `ctx.get('attachments')` for
 * direct callers and gates on the calling route's declared image input.
 * @param ctx - the registration scope; execution uses its `fs` service plus
 *   the optional `attachments`/`llm` services.
 */
export function applyReadImageTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'read_image',
    description: 'Read a PNG/JPEG/WebP/GIF file and return the image itself. Requires the current model to accept image input.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
              sourceWidth: { type: 'integer' },
              sourceHeight: { type: 'integer' },
            },
          },
        },
      },
      render: (_args, value) => imageReadContent(value),
    },
    // Content-addressed attachment writes are idempotent, so concurrent reads
    // of the same file cannot conflict.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')

      // Every gate runs before any filesystem I/O so a refusal never leaks
      // partial reads or attachment writes.
      const mediaType = imageMediaTypeForPath(args.file_path)
      if (mediaType === undefined) {
        throw new Error(`cannot read "${args.file_path}": read_image only accepts PNG/JPEG/WebP/GIF paths`)
      }
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error(`cannot read "${args.file_path}" as an image: no attachment service is mounted`)
      }
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`cannot read "${args.file_path}": ${mediaType} images are not accepted by this deployment`)
      }
      await assertImageCapableRoute(ctx, exec, args.file_path)

      const { target, info } = await resolveRegularReadTarget(ctx, exec, args.file_path)

      // The tool result is one message carrying one image, so the per-message
      // aggregate bound applies beside the per-image bound.
      const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const data = await ctx.fs.readBytes(target, exec.signal, byteCap)
      // Persist before returning: the image block must reference a durably
      // committed object by the time the tool/result event is appended.
      let ref: ImageAttachmentRef
      let source: { width: number; height: number }
      try {
        const saved = await attachments.saveImage({ data, mediaType, name: basename(target.displayPath) })
        ref = saved.ref
        source = saved.source
      } catch (error: unknown) {
        if (!(error instanceof AttachmentError)) throw error
        // Dimension refusals stay recoverable tool errors: an oversized image
        // must never enter durable history, where it would ride every later
        // model request past provider-side dimension rejections.
        if (error.code === 'IMAGE_DIMENSION_TOO_LARGE') {
          throw new Error(
            `cannot read "${target.displayPath}": at least one image side exceeds the ${attachments.imageLimits.maxImageDimension}px limit; downscale the image and read the smaller copy`,
            { cause: error },
          )
        }
        if (error.code === 'IMAGE_TOO_MANY_PIXELS') {
          throw new Error(
            `cannot read "${target.displayPath}": the image exceeds the ${attachments.imageLimits.maxImagePixels}-pixel decoded-size limit; downscale the image and read the smaller copy`,
            { cause: error },
          )
        }
        if (error.code === 'IMAGE_TOO_LARGE') {
          throw new Error(
            `cannot read "${target.displayPath}": the image cannot be stored within the deployment's byte limits; downscale the image and read the smaller copy`,
            { cause: error },
          )
        }
        if (error.code === 'ATTACHMENT_WRITE_FAILED' && /16-bit PNG/iu.test(error.message)) {
          throw new Error(
            `cannot read "${target.displayPath}": the 16-bit PNG could not be converted to the canonical 8-bit sRGB form; convert it to an 8-bit PNG/JPEG/WebP and retry`,
            { cause: error },
          )
        }
        if (error.code !== 'IMAGE_TYPE_MISMATCH') throw error
        const extension = extname(target.displayPath).toLowerCase()
        throw new Error(
          `cannot read "${target.displayPath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`,
          { cause: error },
        )
      }
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      const downscaled = source.width !== ref.width || source.height !== ref.height
      const value: ImageReadValue = {
        path: target.displayPath,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
          ...downscaled ? { sourceWidth: source.width, sourceHeight: source.height } : {},
        },
      }
      return value
    },
    // Pure display: a generic card in the read family with a follow-along
    // location on the image file.
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Read image ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'read_image_region',
    description: 'Crop a region from an image attachment already visible in this session. Coordinates use the preview dimensions supplied beside that image.',
    parameters: {
      attachment_id: { type: 'string', required: true, description: 'Complete attachment id shown beside the image.' },
      preview_width: { type: 'integer', required: true, description: 'Width of the preview shown to the model.' },
      preview_height: { type: 'integer', required: true, description: 'Height of the preview shown to the model.' },
      x: { type: 'integer', required: true, description: 'Left edge in preview pixels.' },
      y: { type: 'integer', required: true, description: 'Top edge in preview pixels.' },
      width: { type: 'integer', required: true, description: 'Crop width in preview pixels.' },
      height: { type: 'integer', required: true, description: 'Crop height in preview pixels.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourceAttachmentId: { type: 'string', required: true },
          preview: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
          crop: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              x: { type: 'integer', required: true },
              y: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
          image: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
              sourceWidth: { type: 'integer' },
              sourceHeight: { type: 'integer' },
            },
          },
        },
      },
      render: (_args, value) => regionReadContent(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const attachmentId = args.attachment_id.trim()
      if (attachmentId.length === 0) throw new Error('attachment_id must be a non-empty string')
      const ref = sessionImageRef(exec, attachmentId)
      await assertImageCapableRoute(ctx, exec, attachmentId)
      const crop: PreviewImageCrop = {
        previewWidth: positiveInteger(args.preview_width, 'preview_width'),
        previewHeight: positiveInteger(args.preview_height, 'preview_height'),
        x: nonNegativeInteger(args.x, 'x'),
        y: nonNegativeInteger(args.y, 'y'),
        width: positiveInteger(args.width, 'width'),
        height: positiveInteger(args.height, 'height'),
      }
      const saved = await ctx.attachments.cropImage(ref, crop, exec.signal)
      return {
        sourceAttachmentId: ref.attachmentId,
        preview: { width: crop.previewWidth, height: crop.previewHeight },
        crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
        image: {
          attachmentId: saved.ref.attachmentId,
          mediaType: saved.ref.mediaType,
          bytes: saved.ref.bytes,
          width: saved.ref.width,
          height: saved.ref.height,
          ...saved.ref.name === undefined ? {} : { name: saved.ref.name },
          ...saved.ref.sourceWidth === undefined ? {} : { sourceWidth: saved.ref.sourceWidth },
          ...saved.ref.sourceHeight === undefined ? {} : { sourceHeight: saved.ref.sourceHeight },
        },
      }
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Read image region ${args.attachment_id}`,
        kind: 'read',
      }
    },
  }))
}
