import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AttachmentRailLabels } from '../AttachmentRail.tsx'
import type { DropOverlayLabels } from '../DropOverlay.tsx'
import type { ImageLightboxLabels } from '../ImageLightbox.tsx'
import type { MessageImageLabels } from '../MessageImage.tsx'

/** Resolve original-image lightbox strings from the conversation namespace. */
export function lightboxLabels(t: TranslateNS<'conversation'>): ImageLightboxLabels {
  return { dialog: t('image.preview'), close: t('image.closePreview') }
}

/** Resolve historical message-image strings from the conversation namespace. */
export function messageImageLabels(t: TranslateNS<'conversation'>): MessageImageLabels {
  return {
    image: t('image.label'),
    open: t('image.openOriginal'),
    openNamed: label => t('image.openOriginalLabel', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: lightboxLabels(t),
  }
}

/** Resolve the document-level drop invitation and its optional limits line. */
export function dropOverlayLabels(
  t: TranslateNS<'conversation'>,
  accepting: boolean,
  limits?: { readonly count: number; readonly size: string },
): DropOverlayLabels {
  if (!accepting) return { title: t('image.dropBlocked') }
  return {
    title: t('image.dropTitle'),
    desc: limits === undefined ? undefined : t('image.dropDesc', limits),
  }
}

/** Resolve draft-image rail strings from the conversation namespace. */
export function attachmentRailLabels(t: TranslateNS<'conversation'>): AttachmentRailLabels {
  return {
    group: t('image.pending'),
    open: t('image.openOriginal'),
    scrollLeft: t('image.scrollLeft'),
    scrollRight: t('image.scrollRight'),
  }
}
