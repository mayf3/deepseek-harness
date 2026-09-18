/** Original model-facing content retained by non-human Turn notices. */
import type { ReactNode } from 'react'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ContextMessageNode } from '../contract/snapshot.ts'
import css from './ContextBody.module.css'

/** Model-facing text stays bounded at the disclosure, not at the producer. */
const MAX_CHARS = 20_000

type Translate = ChatViewSlotProps['t']

/** One run of the model-facing content: adjacent text, or one unknown block. */
type ContentRun = { text: string } | { block: unknown }

/** Join adjacent text while preserving unknown blocks in their original order. */
function contentRuns(content: ContextMessageNode['content']): ContentRun[] {
  const runs: ContentRun[] = []
  for (const block of content) {
    if (block.type !== 'text') {
      runs.push({ block })
      continue
    }
    const last = runs[runs.length - 1]
    if (last !== undefined && 'text' in last) last.text += block.text
    else runs.push({ text: block.text })
  }
  return runs
}

/** The model-facing text, truncated to the display bound. */
function boundedText(text: string, t: Translate): string {
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n${t('json.truncated', { total: text.length })}`
    : text
}

/**
 * Render the recorded content of a Turn trigger, including unknown blocks.
 * @param props - durable content and the locale seat.
 * @returns bounded text and JSON fallbacks in their original order.
 */
export function ContextContentBody({ content, t }: {
  content: ContextMessageNode['content']
  t: Translate
}): ReactNode {
  return (
    <>
      {contentRuns(content).map((run, index) => ('text' in run
        ? run.text !== '' && (
          <pre key={index} className={css.text} data-context-text>{boundedText(run.text, t)}</pre>
        )
        : (
          <JsonBlock
            key={index}
            label={t('message.unknownBlock')}
            payload={run.block}
            truncatedLabel={total => t('json.truncated', { total })}
          />
        )))}
    </>
  )
}
