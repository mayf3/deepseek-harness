/**
 * Provider-side request-image pricing for DeepSeek routes: prices every
 * retained surface occurrence at its per-model pixel-budget projection with
 * the published v4 vision-token accounting, and every occurrence the surface
 * marks offloaded as its placeholder text. Consumed synchronously by the
 * token meter through `LlmAdapter.imageRequestPricing`; provider usage
 * remains the authoritative anchor for completed requests.
 *
 * @module dsh-llm-deepseek/request-pricing
 */

import { offloadedImageText, requestImageHandleText, textOnlyImageText } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentAccessResolver, ImageBlock, LlmImageRequestPrice, LlmImageRequestPricing } from '@deepseek-ai/dsh-llm'
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { ImageRequestPolicy } from '@deepseek-ai/dsh-attachment'
import { deepSeekImageTokens } from './image-tokens.ts'
import type { DeepSeekCatalogModel, DeepSeekConnectionOptions } from './adapter.ts'

/** Default bound on accumulated file-referenced image bytes per request. */
export const DEFAULT_MAX_REQUEST_FILES_BYTES = 128 * 1024 * 1024
/** Provider request image-count limit. */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 600
/** Total-pixel budget matching DeepSeek's normal vision projection. */
export const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 640_000
/** Total-pixel budget matching provider low-detail image input. */
export const DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET = 512 * 512
/** Encoded-byte target for one deterministic model-request image; the smallest quality-ladder output is used when no quality fits. */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024

/**
 * Resolve the request-image budgets owned by one DeepSeek model route.
 * @param model - Advertised model route and its optional image overrides.
 * @returns Complete pixel and encoded-byte budgets.
 * @internal
 */
export function resolveRequestImagePolicy(model: DeepSeekCatalogModel): ImageRequestPolicy {
  const maxPixels = model.imagePixelBudget === 'low'
    ? DEFAULT_LOW_DETAIL_IMAGE_PIXEL_BUDGET
    : model.imagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET
  return {
    maxPixels,
    maxBytes: model.imageMaxBytes === undefined
      ? DEFAULT_REQUEST_IMAGE_MAX_BYTES
      : model.imageMaxBytes,
  }
}

/**
 * Price one occurrence a text-only route substitutes with deterministic text,
 * reproducing the `projectImagesForTextModel` substitution `LlmRuntime`
 * applies before dispatching to a route without the `image` modality.
 */
function textOnlyPrice(block: ImageBlock): LlmImageRequestPrice {
  return { visualTokens: 0, text: textOnlyImageText(block.attachment) }
}

/**
 * Build the request-image pricing for one DeepSeek route from a validated
 * connection snapshot. Uncatalogued and text-only models price every
 * occurrence as its deterministic text substitution; image-capable models
 * price an offloaded occurrence as its placeholder text and a retained one by
 * its projected request dimensions, with each occurrence's handle or
 * placeholder text built through the same access resolution the serializer
 * uses. Access paths resolve at pricing time, so a path that changes before
 * the request only shifts the text price by its own length.
 * @param connection - validated connection facts of the pricing resolution.
 * @param model - exact model id named by the request header.
 * @param resolveAccess - current execution-world access resolution shared with request serialization.
 * @returns synchronous per-occurrence pricing for the route.
 */
export function deepSeekImageRequestPricing(
  connection: DeepSeekConnectionOptions,
  model: string,
  resolveAccess?: ImageAttachmentAccessResolver,
): LlmImageRequestPricing {
  const catalogModel = connection.models.find(entry => entry.id === model)
  if (catalogModel?.inputModalities?.includes('image') !== true) {
    return { priceImages: images => images.map(textOnlyPrice) }
  }
  const policy = resolveRequestImagePolicy(catalogModel)
  return {
    priceImages: images => images.map(({ attachment: ref, offloaded }) => {
      if (offloaded === true) {
        return { visualTokens: 0, text: offloadedImageText(ref, resolveAccess?.(ref)) }
      }
      const dimensions = requestImageDimensions(ref.width, ref.height, policy.maxPixels)
      return {
        visualTokens: deepSeekImageTokens(dimensions.width, dimensions.height),
        text: requestImageHandleText(ref, dimensions, resolveAccess?.(ref)),
      }
    }),
  }
}
