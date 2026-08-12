/**
 * Plugin configuration section: the shell around the per-plugin cards. It
 * enumerates settings namespaces but never interprets one — a card arrives
 * through the `settings.plugin.item` slot keyed by the namespace it edits, so
 * a plugin that ships a browser half owns its own card and this section only
 * decides which keys to dispatch.
 */

import { Fragment } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import type { PluginConfigSectionFace } from './section-store.ts'
import type { PluginConfigKey } from './locales.ts'
import css from './PluginConfigSection.module.css'

/** Props the renderer binds for the section. */
export type PluginConfigSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.pluginConfig'>
  & PropsRenderSlots<'settings.plugin.item'>
  & InjectFace<PluginConfigSectionFace>

/**
 * Render the plugin configuration section.
 * @param props - runtime slot rendering, locale copy, and the namespaces to dispatch.
 * @returns the section.
 */
export function PluginConfigSection(props: PluginConfigSectionProps) {
  const { t, renderSlot } = props
  const { loaded, namespaces } = props.usePluginConfigSection(snapshot => snapshot)
  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {namespaces.length > 0
        ? (
          <ul className={css.cards}>
            {namespaces.map(ns => (
              // One dispatch per namespace, so the list identity is the
              // namespace rather than a position that shifts as cards arrive.
              <Fragment key={ns}>{renderSlot('settings.plugin.item', {}, { entryKey: ns })}</Fragment>
            ))}
          </ul>
        )
        : loaded ? <p className={css.empty}>{t('empty')}</p> : null}
    </div>
  )
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin configuration section and card copy. */
    'settings.pluginConfig': PluginConfigKey
  }
}
