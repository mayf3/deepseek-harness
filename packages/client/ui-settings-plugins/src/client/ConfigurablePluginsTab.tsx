/**
 * Configurable Host plugins contributed to the shared Plugins section.
 *
 * The tab enumerates settings namespaces but never interprets one — a card
 * arrives through `settings.plugin.item` keyed by the namespace it edits, so a
 * plugin that ships a browser half owns its own card and this tab only decides
 * which keys to dispatch. Every card edits the global instance of its
 * namespace here; a preset's own values are edited on the preset's detail page.
 */

import { Fragment } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import type { ConfigurablePluginsTabFace } from './tab-store.ts'
import css from './PluginsSettingsSection.module.css'

/** Props the renderer binds for the configurable tab. */
export type ConfigurablePluginsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & PropsRenderSlots<'settings.plugin.item'>
  & InjectFace<ConfigurablePluginsTabFace>

/**
 * Render the cards registered by plugins that expose editable settings.
 * @param props - locale copy, slot rendering, and the namespaces to dispatch.
 * @returns the card list, or the empty line once the Host has answered.
 */
export function ConfigurablePluginsTab(props: ConfigurablePluginsTabProps) {
  const { t, renderSlot } = props
  const { loaded, namespaces } = props.useConfigurablePlugins(snapshot => snapshot)

  return (
    <div className={css.configurable}>
      {namespaces.length > 0
        ? (
          <ul className={css.cards}>
            {namespaces.map(ns => (
              // One dispatch per namespace, so the list identity is the namespace
              // rather than a position that shifts as cards arrive.
              <Fragment key={ns}>{renderSlot('settings.plugin.item', {}, { entryKey: ns })}</Fragment>
            ))}
          </ul>
        )
        : loaded ? <p className={css.empty}>{t('empty')}</p> : null}
    </div>
  )
}
