/** Localized copy adapters for Cordis-free Markdown primitives. */

import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from './contract/slots.ts'

/**
 * Build the complete Markdown chrome copy for one locale revision.
 * @param t - Chat locale seat.
 * @returns Labels for code fences and footnotes.
 */
export function markdownLabels(t: ChatViewSlotProps['t']): MarkdownLabels {
  const status = { error: t('markdown.preview.error') }
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), sourceLabel: t('markdown.code.source'), lineNumbersLabel: t('markdown.code.lineNumbers') },
    footnotes: t('markdown.footnotes'),
    preview: {
      preview: t('markdown.preview.preview'),
      source: t('markdown.preview.source'),
      zoom: t('markdown.preview.zoom'),
      pending: t('markdown.preview.pending'),
      close: t('markdown.preview.close'),
      interaction: t('markdown.preview.interaction'),
      mermaid: {
        diagram: t('markdown.mermaid.diagram'),
        error: t('markdown.mermaid.error'),
      },
      graphviz: { ...status, diagram: t('markdown.preview.graphviz') },
      svg: { ...status, diagram: t('markdown.preview.svg') },
    },
  }
}
