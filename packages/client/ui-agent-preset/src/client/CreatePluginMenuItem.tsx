/** Create a plugin through the existing Creator flow from the Add plugin menu. */
import { useEffect } from 'react'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { IconAgentPresetOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPresetSettingsState } from './settings-store.ts'
import css from './CreatePluginMenuItem.module.css'

/** Roster, preference, and navigation supplied by the preset plugin. */
export interface CreatePluginMenuItemInjected {
  hooks: {
    developerTools: ObservableSnapshot<boolean>
    agentPresets: SnapshotStore<AgentPresetSettingsState>
  }
  load: () => Promise<void>
  startCreatorDraft: () => void
}

type CreatePluginMenuItemProps = PropsRuntime<'plugins.add.actions'>
  & PropsLocale<'settings.agentPreset'> & InjectFace<CreatePluginMenuItemInjected>

/**
 * Close the Add plugin menu before opening Creator without sending a message.
 * @param props - locale, roster, preference, dismissal and navigation callbacks.
 * @returns a stable menu item that explains why Creator is unavailable.
 */
export function CreatePluginMenuItem({
  t, useDeveloperTools, useAgentPresets, load, onDismiss, startCreatorDraft,
}: CreatePluginMenuItemProps) {
  const developerTools = useDeveloperTools(value => value)
  const roster = useAgentPresets(state => state)
  const available = roster.status === 'ready' && roster.options.some(option => option.id === 'cordis')
  const enabled = developerTools && available
  useEffect(() => { void load() }, [load])

  let description = t('createPluginDescription')
  if (!developerTools) description = t('enableDevToolsToCreate')
  else if (roster.status === 'idle' || roster.status === 'loading') description = t('createPluginChecking')
  else if (roster.status === 'error' || roster.status === 'unavailable') description = t('createPluginUnavailable')
  else if (!available) description = t('createPluginMissing')

  return (
    <MenuItemButton icon={<IconAgentPresetOutlineRegular size={16} />} disabled={!enabled} onSelect={() => {
      if (!enabled) return
      onDismiss()
      startCreatorDraft()
    }}>
      <span className={css.copy}>
        <span>{t('createPlugin')}</span>
        <span className={css.description} title={description}>{description}</span>
      </span>
    </MenuItemButton>
  )
}
