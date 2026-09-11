/**
 * The capabilities section of one agent preset's detail page: the preset's
 * composition as cards with a switch each, a delete for rows the person
 * added, and an **Add** menu over the installed plugins the preset does not
 * carry yet. Contributed to the roster's `settings.agentPreset.detail` slot;
 * it reads the same store as the Manage plugins tab, so a change made on
 * either surface shows on the other at once.
 */

import { useEffect, useState, type ReactNode } from 'react'
import type { PluginPackageView } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconTrashOutline16, Menu, Switch, Tag, type MenuItem } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the detail slot's declaration, owned by the roster.
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import type { PluginManagerFace, PresetGroup, PresetRow } from './manager-store.ts'
import { rowKey } from './manager-store.ts'
import { NoticeLine } from './NoticeLine.tsx'
import { presetRowCopy, rowIdOf, shortName, type Translate } from './presentation.ts'
import css from './PluginManagerPage.module.css'

/** Full component props assembled by the slot renderer. */
export type PresetPluginsSectionProps =
  PropsRuntime<'settings.agentPreset.detail'>
  & PropsLocale<'pluginManager'>
  & InjectFace<PluginManagerFace>

/** One module the preset could still add, carried through the menu as its item id. */
interface AddChoice {
  readonly packageName: string
  readonly declaredName: string
}

/** The installed modules the preset does not carry yet, as menu items. */
function addChoices(packages: readonly PluginPackageView[], preset: PresetGroup, t: Translate): MenuItem[] {
  const carried = new Set(preset.rows.map(row => row.moduleName))
  const items: MenuItem[] = []
  for (const pkg of packages) {
    const title = pkg.title ?? shortName(pkg.name)
    for (const entry of pkg.addable) {
      if (carried.has(entry.moduleName)) continue
      items.push({
        id: JSON.stringify({ packageName: pkg.name, declaredName: entry.declaredName } satisfies AddChoice),
        label: entry.title ?? (entry.declaredName === '.' ? title : `${title} · ${entry.declaredName}`),
      })
    }
  }
  return items.length === 0 ? [{ id: 'none', label: t('capabilitiesAddEmpty'), disabled: true }] : items
}

/** One row of the preset's composition, as a card with its switch. */
function PresetCard({ preset, row, packages, t, busy, onSetDisabled, onRemove }: {
  readonly preset: PresetGroup
  readonly row: PresetRow
  readonly packages: readonly PluginPackageView[]
  readonly t: Translate
  readonly busy: boolean
  readonly onSetDisabled: (rowId: string, disabled: boolean) => void
  readonly onRemove: (rowId: string) => void
}): ReactNode {
  const id = rowIdOf(row.entryId)
  const copy = presetRowCopy(row, packages, t)
  const lockedOff = row.enabled === false && row.disabledBy === 'composition'
  return (
    <li className={css.card} data-preset-row={row.entryId ?? undefined} data-plugin-source={row.source}>
      <div className={css.cardHead}>
        <div className={css.cardMain}>
          <div className={css.titleRow}>
            <span className={css.cardTitle}>{copy.title}</span>
            {copy.local ? <Tag tone="info">{t('localTag')}</Tag> : null}
            {row.fiberPhase === 'failed' ? <Tag tone="danger">{t('rowStateFailed')}</Tag> : null}
          </div>
          {copy.description === undefined ? null : <span className={css.cardDesc}>{copy.description}</span>}
        </div>
        <div className={css.cardEnd}>
          {id === null
            ? <span className={css.rowNote} title={t('rowNoId')}>{t('rowNoId')}</span>
            : (
              <>
                {row.source === 'user'
                  ? (
                    <button
                      type="button"
                      className={css.deleteButton}
                      aria-label={t('rowRemoveLabel', { name: copy.title })}
                      title={t('rowRemove')}
                      disabled={busy}
                      onClick={() => { onRemove(id) }}
                    >
                      <IconTrashOutline16 />
                    </button>
                  )
                  : null}
                <Switch
                  checked={row.enabled !== false}
                  label={t('rowToggle', { name: copy.title })}
                  {...lockedOff ? { title: t('rowLockedByComposition') } : {}}
                  disabled={busy || preset.broken !== undefined || lockedOff}
                  onChange={() => { onSetDisabled(id, row.enabled !== false) }}
                />
              </>
            )}
        </div>
      </div>
    </li>
  )
}

/** Render one preset's capabilities: its rows, the add menu, and the last action's outcome. */
export function PresetPluginsSection(props: PresetPluginsSectionProps): ReactNode {
  const { t, presetId, presetName, ensure } = props
  const state = props.usePluginManager(snapshot => snapshot)
  const [addMenu, setAddMenu] = useState(false)
  useEffect(() => { ensure() }, [ensure])

  const target = { kind: 'preset', preset: presetId } as const
  const preset = state.presets.find(candidate => candidate.id === presetId)
  const loaded = state.status === 'ready' || state.status === 'error'
  return (
    <section className={css.group} data-plugin-scope="preset" data-preset-id={presetId}>
      <div className={css.groupTitleRow}>
        <h3 className={css.groupTitle}>{t('capabilitiesTitle')}</h3>
        {preset === undefined || preset.broken !== undefined
          ? null
          : (
            <Menu
              open={addMenu}
              onClose={() => { setAddMenu(false) }}
              items={addChoices(state.packages, preset, t)}
              onSelect={(id) => {
                setAddMenu(false)
                const choice = JSON.parse(id) as AddChoice
                props.addRow(choice.packageName, choice.declaredName, target)
              }}
              align="end"
              portal
              anchor={(
                <Button
                  variant="outline"
                  size="sm"
                  aria-haspopup="menu"
                  aria-expanded={addMenu}
                  aria-label={t('capabilitiesAddLabel', { name: presetName })}
                  disabled={state.busy.length > 0}
                  onClick={() => { setAddMenu(current => !current) }}
                >
                  {t('capabilitiesAdd')}
                </Button>
              )}
            />
          )}
      </div>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'unavailable' ? <p className={css.status} role="status">{t('unavailable')}</p> : null}
      {state.status === 'error' ? <p className={css.reason} role="alert">{t('error')}</p> : null}
      <NoticeLine notice={state.notice} t={t} onDismiss={props.dismissNotice} />
      {!loaded || preset !== undefined ? null : <p className={css.empty}>{t('presetMissing')}</p>}
      {preset?.broken === undefined ? null : <p className={css.reason} role="alert">{preset.broken}</p>}
      {preset === undefined || preset.broken !== undefined
        ? null
        : preset.rows.length === 0
          ? <p className={css.empty}>{t('presetRowsEmpty')}</p>
          : (
            <ul className={css.cards}>
              {preset.rows.map((row, index) => (
                <PresetCard
                  key={`${row.entryId ?? row.moduleName}:${String(index)}`}
                  preset={preset}
                  row={row}
                  packages={state.packages}
                  t={t}
                  busy={row.entryId !== null && state.busy.includes(rowKey(target, rowIdOf(row.entryId) as string))}
                  onSetDisabled={(rowId, disabled) => { props.setRowDisabled(target, rowId, disabled) }}
                  onRemove={(rowId) => { props.removeRow(target, rowId) }}
                />
              ))}
            </ul>
          )}
    </section>
  )
}
