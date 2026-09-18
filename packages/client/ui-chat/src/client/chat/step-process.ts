/** Localized titles for projected step-process activity. */
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ProcessActivitySummary } from '../contract/step-process.ts'

/**
 * Compose localized abstract status or the top three completed categories without counts.
 * @param summary - ranked work and phase evidence for this range.
 * @param closed - whether a following reply or turn boundary closed the range.
 * @param t - Chat namespace translator.
 * @returns the secondary disclosure title.
 */
export function processTitle(
  summary: ProcessActivitySummary,
  closed: boolean,
  t: ChatViewSlotProps['t'],
): string {
  if (!closed) return t(`message.stepProcess.${summary.running ?? 'thinking'}`)
  const labels = summary.counts.slice(0, 3).map(({ kind }) => t(`message.stepProcess.done.${kind}`))
  const first = labels[0]
  if (first === undefined) return t('message.stepProcess.done.thinking')
  const continuation = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1)
  const second = labels[1]
  if (second === undefined) return first
  if (labels.length === 2) {
    const prefix = t('message.stepProcess.sharedPrefix')
    const shared = prefix !== '' && first.startsWith(prefix) && second.startsWith(prefix)
    return t('message.stepProcess.joinTwo', { first, second: continuation(shared ? second.slice(prefix.length) : second) })
  }
  const title = [first, ...labels.slice(1).map(continuation)].join(t('message.stepProcess.comma'))
  return summary.counts.length > 3 ? t('message.stepProcess.more', { title }) : title
}
