/** Localized Markdown controls shared by question and plan-review bodies. */
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { QuestionComposerProps } from './contract/slots.ts'

/**
 * Localize source controls and footnotes for the question domain.
 * @param t - The question composer's locale translator.
 * @returns Labels accepted by the shared Markdown renderer.
 */
export function createMarkdownLabels(t: QuestionComposerProps['t']): MarkdownLabels {
  return {
    code: {
      copyLabel: t('copy'), copiedLabel: t('copied'), sourceLabel: t('markdown.code.source'),
      lineNumbersLabel: t('markdown.code.lineNumbers'),
    },
    footnotes: t('markdown.footnotes'),
  }
}
