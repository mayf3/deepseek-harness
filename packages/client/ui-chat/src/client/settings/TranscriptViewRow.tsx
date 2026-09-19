/** General Settings row for completed-Turn transcript presentation. */

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
  /** Change the completed-Turn transcript presentation. */
  setTranscriptView: (mode: TranscriptViewMode) => void
}

/** Full Settings-row props. */
export type TranscriptViewRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'chat'>
  & InjectFace<TranscriptViewRowInjected>

const OPTIONS: readonly { id: TranscriptViewMode; label: ChatKey }[] = [
  { id: 'normal', label: 'settings.transcript.normal' },
  { id: 'compact', label: 'settings.transcript.compact' },
]

/**
 * Render the completed-Turn transcript mode selector.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function TranscriptViewRow({ useTranscriptView, setTranscriptView, t }: TranscriptViewRowProps) {
  const mode = useTranscriptView(value => value)
  const selectedLabel = mode === 'normal'
    ? 'settings.transcript.normal'
    : 'settings.transcript.compact'
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
