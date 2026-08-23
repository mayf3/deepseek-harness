/** Localized copy adapters for Cordis-free Markdown primitives. */

import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from './contract/slots.ts'

/**
 * Build the complete Markdown chrome copy for one locale revision.
 * @param t - Chat locale seat.
 * @returns Labels for code fences and footnotes.
 */
export function markdownLabels(t: ChatViewSlotProps['t']): MarkdownLabels {
  return {
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('markdown.footnotes'),
  }
}

/**
 * Format the truncation footer for a JSON Markdown block.
 * @param t - Chat locale seat.
 * @param total - Full serialized character count.
 * @returns Localized truncation footer.
 */
export function jsonTruncatedLabel(t: ChatViewSlotProps['t'], total: number): string {
  return t('markdown.truncatedCharacters', { total })
}
