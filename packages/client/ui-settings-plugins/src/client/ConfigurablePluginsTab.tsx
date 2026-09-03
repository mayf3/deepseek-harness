/**
 * Configurable Host plugins contributed to the shared Plugins section.
 *
 * The tab enumerates settings namespaces but never interprets one — a card
 * arrives through `settings.plugin.item` keyed by the namespace it edits, so a
 * plugin that ships a browser half owns its own card and this tab only decides
 * which keys to dispatch. Above the cards, one switch chooses the scope every
 * card edits: the values shared by all agent presets, or one preset's own.
 */

import { Fragment, useEffect, useState } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slot-contract.ts'
import type { ConfigurablePluginsTabFace } from './tab-store.ts'
import { PRESET_SCOPE_PREFIX, type PresetScopeRow, type ScopeSwitcherFace } from './scope-switcher.ts'
import css from './PluginsSettingsSection.module.css'

/** Menu id of the global instance; a scope id never collides with it, as every scope carries a `/`. */
const GLOBAL_OPTION = 'global'

/** Props the renderer binds for the configurable tab. */
export type ConfigurablePluginsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.plugins'>
  & PropsRenderSlots<'settings.plugin.item'>
  & InjectFace<ConfigurablePluginsTabFace & ScopeSwitcherFace>

/**
 * Render the scope switch and the cards registered by plugins that expose
 * editable settings.
 * @param props - locale copy, slot rendering, the namespaces to dispatch, and the scope switch.
 * @returns the switch and card list, or the empty line once the Host has answered.
 */
export function ConfigurablePluginsTab(props: ConfigurablePluginsTabProps) {
  const { t, renderSlot, ensureScopes, selectScope, presetName } = props
  const { loaded, namespaces } = props.useConfigurablePlugins(snapshot => snapshot)
  const switcher = props.useScopeSwitcher(snapshot => snapshot)
  const [open, setOpen] = useState(false)
  useEffect(() => { ensureScopes() }, [ensureScopes])

  const presetLabel = (preset: PresetScopeRow): string => {
    const name = presetName(preset)
    if (preset.broken !== undefined) return t('scopePresetBroken', { name })
    if (preset.isDefault) return t('scopePresetDefault', { name })
    return name
  }
  const items = [
    { id: GLOBAL_OPTION, label: t('scopeGlobal') },
    ...switcher.presets.map(preset => ({ id: `${PRESET_SCOPE_PREFIX}${preset.id}`, label: presetLabel(preset) })),
    ...switcher.extraScopes.map(scope => ({ id: scope, label: scope })),
  ]
  const selectedId = switcher.scope ?? GLOBAL_OPTION
  const selected = items.find(item => item.id === selectedId)
  // A selected scope the options no longer list keeps its raw id visible.
  const selectedLabel = selected?.label ?? selectedId

  return (
    <div className={css.configurable}>
      <div className={css.scopeRow}>
        <span className={css.scopeLabel}>{t('scopeLabel')}</span>
        <Menu
          open={open}
          onClose={() => { setOpen(false) }}
          items={items}
          selectedId={selectedId}
          onSelect={(id) => {
            setOpen(false)
            selectScope(id === GLOBAL_OPTION ? null : id)
          }}
          align="end"
          portal
          anchor={(
            <button
              type="button"
              className={css.scopeSwitcher}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={t('scopeSwitcherLabel')}
              data-settings-scope={switcher.scope ?? 'global'}
              onClick={() => { setOpen(value => !value) }}
            >
              <span className={css.scopeSwitcherLabel}>{selectedLabel}</span>
              <IconChevronDownOutline14 className={css.scopeChevron} aria-hidden="true" />
            </button>
          )}
        />
      </div>
      <p className={css.scopeHint}>
        {switcher.status === 'error' ? t('scopeRosterFailed') : t(switcher.scope === undefined ? 'scopeHintGlobal' : 'scopeHintPreset')}
      </p>
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
