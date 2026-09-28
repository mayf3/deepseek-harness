/**
 * The session header's agent-preset label.
 *
 * Read-only by construction: a session's composition is fixed once its
 * conversation starts, and a header is only worth reading after that. Offering
 * a selection control here would promise a switch the host refuses. Its
 * read-only details explain the mode, and the choice itself lives on the
 * new-session screen ({@link AgentPresetSeat}).
 */

import { useEffect, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconAgentPresetOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only: pulls the ui-conversation SlotMap merge (the header actions).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { AgentPresetSettingsState } from './settings-store.ts'
import { isBuiltInPreset, presetDisplayText } from './locales.ts'
import { PresetGuideDialog, presetGuide } from './PresetGuideDialog.tsx'
import css from './AgentPresetLabel.module.css'

/** Registration-side business face for the header label. */
export interface AgentPresetLabelInjected {
  hooks: {
    /** Roster snapshot bound by the renderer as useAgentPresets. */
    agentPresets: SnapshotStore<AgentPresetSettingsState>
  }
  /** Read the roster, so the label can show a name rather than an id. */
  load: () => Promise<void>
}

/** Full component props. */
export type AgentPresetLabelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'settings.agentPreset'>
  & InjectFace<AgentPresetLabelInjected>

/**
 * Render this session's agent-preset name beside its title.
 * @param props - composed slot props.
 * @returns the label, or null when the session records no preset.
 */
export function AgentPresetLabel({
  sessionId, useSessions, useAgentPresets, load, t,
}: AgentPresetLabelProps) {
  const preset = useSessions((state) => {
    const value = state.byId[sessionId]?.projectionValues?.agentPreset
    return typeof value === 'string' ? value : undefined
  })
  const options = useAgentPresets(state => state.options)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const option = options.find(entry => entry.id === preset)

  useEffect(() => { setDetailsOpen(false) }, [sessionId, preset, option?.id])

  useEffect(() => {
    // Deployments that compose no presets never label anything, so the roster
    // is only worth a request once a session reports one.
    if (preset !== undefined) void load()
  }, [preset, load])

  if (preset === undefined) return null

  const text = option === undefined ? undefined : presetDisplayText(option, t)
  const label = text?.name ?? preset
  const guide = option === undefined ? undefined : presetGuide(option.id, isBuiltInPreset(option) ? 'system' : 'user')
  if (option === undefined) return (
    <span className={css.label} title={t('headerHint')}>
      <IconAgentPresetOutlineRegular size={14} className={css.icon} />
      <span className={css.name}>{label}</span>
    </span>
  )
  return (
    <>
      <button type="button" className={`${css.label} ${css.details}`} title={text?.description ?? t('headerHint')}
        aria-label={`${t('modeExplanation')}: ${label}`} aria-haspopup="dialog" onClick={() => { setDetailsOpen(true) }}>
        <IconAgentPresetOutlineRegular size={14} className={css.icon} />
        <span className={css.name}>{label}</span>
      </button>
      {!detailsOpen ? null : guide === undefined ? (
        <Modal open title={label} description={option.description ?? t('noDescription')}
          closeLabel={t('close')} onClose={() => { setDetailsOpen(false) }} />
      ) : (
        <PresetGuideDialog guide={guide} initialPage="explanation" t={t} onClose={() => { setDetailsOpen(false) }} />
      )}
    </>
  )
}
