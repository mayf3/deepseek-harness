/** General Settings row for work details presentation. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranscriptViewMode } from '../../chat-settings.ts'
import type { ChatKey } from '../locale.ts'
import { PreferenceRow } from './PreferenceRow.tsx'

/** Registration-side transcript preference face. */
export interface TranscriptViewRowInjected {
  hooks: {
    /** Persisted transcript preference bound as useTranscriptView. */
    transcriptView: SnapshotStore<TranscriptViewMode>
  }
  /** Change the work details presentation. */
  setTranscriptView: (mode: TranscriptViewMode) => void
}

/** Full Settings-row props. */
export type TranscriptViewRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'chat'>
  & InjectFace<TranscriptViewRowInjected>

const OPTIONS: readonly { id: TranscriptViewMode; label: ChatKey }[] = [
  { id: 'compact', label: 'settings.transcript.compact' },
  { id: 'detailed', label: 'settings.transcript.detailed' },
  { id: 'expanded', label: 'settings.transcript.expanded' },
]

/**
 * Render the completed-Turn transcript mode selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function TranscriptViewRow({ useTranscriptView, setTranscriptView, t }: TranscriptViewRowProps) {
  const mode = useTranscriptView(value => value)
  const selectedLabel = `settings.transcript.${mode}` as const
  return (
    <PreferenceRow
      title={t('settings.transcript.title')}
      description={t('settings.transcript.description')}
      value={mode}
      selectedLabel={t(selectedLabel)}
      options={OPTIONS.map(option => ({ id: option.id, label: t(option.label) }))}
      onSelect={(value) => { setTranscriptView(value as TranscriptViewMode) }}
    />
  )
}
