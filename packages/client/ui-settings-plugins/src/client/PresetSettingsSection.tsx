/**
 * The settings section of one agent preset's detail page: the plugin cards
 * registered into `settings.agentPreset.plugin.item`, editing the preset's own
 * scope (`preset/<id>`). Contributed to the roster's `settings.agentPreset.detail`
 * slot. While the section is mounted the card scope selection names the
 * preset; unmounting returns every card to the global instance. The settings
 * shell mounts one section at a time, so this page and the configuration tab
 * never hold the selection together.
 */

import { Fragment, useLayoutEffect } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the detail slot's declaration, owned by the roster.
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import type {} from './slot-contract.ts'
import type { ConfigurablePluginsTabFace } from './tab-store.ts'
import css from './PluginsSettingsSection.module.css'

/** Scope id prefix the agent-preset roster names its standing scopes with. */
export const PRESET_SCOPE_PREFIX = 'preset/'

/** The registration-side face the section injects: the card directory plus the scope selection. */
export interface PresetSettingsFace extends ConfigurablePluginsTabFace {
  /** Select the scope every card edits; null selects the global instance. */
  selectScope: (scope: string | null) => void
}

/** Props the renderer binds for the section. */
export type PresetSettingsSectionProps =
  PropsRuntime<'settings.agentPreset.detail'>
  & PropsLocale<'settings.plugins'>
  & PropsRenderSlots<'settings.agentPreset.plugin.item'>
  & InjectFace<PresetSettingsFace>

/**
 * Render one preset's settings: the cards registered by plugins that expose
 * editable settings, under the preset's scope.
 * @param props - locale copy, slot rendering, the namespaces to dispatch, the preset, and the scope selection.
 * @returns the section, with the empty line once the Host has answered.
 */
export function PresetSettingsSection(props: PresetSettingsSectionProps) {
  const { t, renderSlot, presetId, selectScope } = props
  const { loaded, namespaces } = props.useConfigurablePlugins(snapshot => snapshot)
  const scope = `${PRESET_SCOPE_PREFIX}${presetId}`
  // Before paint, so the cards never show the global instance's values first.
  useLayoutEffect(() => {
    selectScope(scope)
    return () => { selectScope(null) }
  }, [scope, selectScope])

  return (
    <section className={css.presetSettings} data-settings-scope={scope}>
      <h3 className={css.presetSettingsTitle}>{t('presetSettingsTitle')}</h3>
      {namespaces.length > 0
        ? (
          <ul className={css.cards}>
            {namespaces.map(ns => (
              <Fragment key={ns}>{renderSlot('settings.agentPreset.plugin.item', {}, { entryKey: ns })}</Fragment>
            ))}
          </ul>
        )
        : loaded ? <p className={css.empty}>{t('empty')}</p> : null}
    </section>
  )
}
