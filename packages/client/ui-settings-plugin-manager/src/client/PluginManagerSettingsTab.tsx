/**
 * The Manage plugins tab: the profile's installed packages as cards — a
 * plugin pack with its switch, a plugin with its **Add to…** menu, a built-in
 * pack with a locked switch — each a name, a one-liner, and a tag only when
 * a restart is pending or something is wrong; the install dialog streaming
 * pnpm's output behind a fold; and the confirmation a destructive action
 * waits on, naming what still uses the package. Entry ids, module names,
 * kinds, and probe facts stay off the page; an expanded card shows the
 * version, the source, a pack's components — each with its own switch on an
 * external pack composed on a live-reload profile — and its uninstall. A preset's
 * composition lives on the preset's own detail page (`PresetPluginsSection`).
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { PluginInstallRejection, PluginPackageView, PluginRowTarget } from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, IconChevronDownOutline14, IconRefreshOutline16, Input, Menu, Modal, StateDot, Switch, Tag,
  type MenuItem, type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginManagerLocaleKey } from './locales.ts'
import { rowKey, type ConfirmState, type InstallState, type PluginManagerFace, type PresetGroup } from './manager-store.ts'
import { noticeText, packageOf, refusalText, rowLabel, shortName, type Translate } from './presentation.ts'
import css from './PluginManagerSettingsTab.module.css'

/** Full component props assembled by the Settings slot renderer. */
export type PluginManagerSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginManager'>
  & InjectFace<PluginManagerFace>

type RowView = PluginPackageView['rows'][number]
type RowPhase = NonNullable<RowView['phase']>

/** The layer a pack's components are switched in: a row override always lands in the profile's global user layer. */
const GLOBAL: PluginRowTarget = { kind: 'global' }

const PHASE_KEYS = {
  pending: 'rowPhasePending',
  loading: 'rowPhaseLoading',
  active: 'rowPhaseActive',
  failed: 'rowPhaseFailed',
  unloading: 'rowPhaseUnloading',
} satisfies Record<RowPhase, PluginManagerLocaleKey>

/** The two states a card tags; running and off are what the switch shows. */
type CardStatus = 'restart' | 'problem'

const STATUS_OF = {
  'running': null,
  'partial': 'problem',
  'failed': 'problem',
  'not-enableable': 'problem',
  'disabled': null,
  'restart-required': 'restart',
  'plain': null,
} satisfies Record<PluginPackageView['status'], CardStatus | null>

const STATUS_KEYS = {
  restart: 'statusRestart',
  problem: 'statusProblem',
} satisfies Record<CardStatus, PluginManagerLocaleKey>

/** Status dot naming a live root-fiber phase. */
/** Pending and unloading fibers do nothing; only loading is in progress. */
const PHASE_STATES = {
  pending: 'idle',
  loading: 'ongoing',
  active: 'done',
  failed: 'error',
  unloading: 'idle',
} satisfies Record<RowPhase, StateDotState>

/** One fiber phase as a state dot, named for assistive technology by the phase's copy. */
function PhaseDot({ phase, t }: { readonly phase: RowPhase; readonly t: Translate }): ReactNode {
  const label = t(PHASE_KEYS[phase])
  return (
    <span className={css.phase} role="img" aria-label={label} title={label}>
      <StateDot state={PHASE_STATES[phase]} size={8} />
    </span>
  )
}

/** A component with a recorded startup failure or a failed fiber. */
function isFailedRow(row: RowView): boolean {
  return row.failure !== undefined || row.phase === 'failed'
}

/** The count line over a pack's components: the total, then only the states that occur. */
function partsSummary(rows: readonly RowView[], t: Translate): string {
  const failed = rows.filter(isFailedRow).length
  const off = rows.filter(row => !row.enabled && !isFailedRow(row)).length
  const running = rows.filter(row => row.enabled && row.phase === 'active').length
  return [
    t('partsCountTotal', { count: String(rows.length) }),
    ...running > 0 ? [t('partsCountRunning', { count: String(running) })] : [],
    ...off > 0 ? [t('partsCountOff', { count: String(off) })] : [],
    ...failed > 0 ? [t('partsCountFailed', { count: String(failed) })] : [],
  ].join(' · ')
}

/** The switch one component renders: whether a write is in flight for it, and the write it asks for. */
interface PartToggle {
  readonly busy: boolean
  readonly onChange: (disabled: boolean) => void
}

/** Switching for a pack's components: which rows have a write in flight, and the write. */
interface PartToggles {
  readonly busy: (rowId: string) => boolean
  readonly onSetDisabled: (rowId: string, disabled: boolean) => void
}

/** A component's switch: off when the user switched it off; locked, saying why, when the pack itself keeps it off. */
function PartSwitch({ row, t, toggle }: { readonly row: RowView; readonly t: Translate; readonly toggle: PartToggle }): ReactNode {
  const locked = row.disabledBy === 'composition'
  return (
    <Switch
      className={css.chipSwitch}
      checked={row.enabled}
      label={t('partToggle', { name: row.rowId })}
      disabled={toggle.busy || locked}
      {...locked ? { title: t('partLockedByComposition') } : {}}
      onChange={(next) => { toggle.onChange(!next) }}
    />
  )
}

/** One component as a chip: its declared id, its fiber phase when it has one, and its switch when it has one. */
function PartChip({ row, off, t, toggle }: {
  readonly row: RowView
  readonly off: boolean
  readonly t: Translate
  readonly toggle?: PartToggle | undefined
}): ReactNode {
  return (
    <li className={css.chip} data-plugin-row={row.entryId} {...off ? { 'data-state': 'off' } : {}}>
      {row.phase === null ? null : <PhaseDot phase={row.phase} t={t} />}
      {row.rowId}
      {toggle === undefined ? null : <PartSwitch row={row} t={t} toggle={toggle} />}
    </li>
  )
}

/**
 * The components of one plugin pack: a count line; the failing components,
 * one line each with the failure; the off ones as chips under why they are
 * off; and the rest as chips behind **Show all** with a filter. A pack like
 * base carries close to a hundred rows and switches dozens off by design,
 * so only a failure earns a line of its own. With `toggle`, every component
 * carries a switch, except a row another layer owns: nothing of it mounted.
 */
function BundleParts({ rows, t, toggle }: {
  readonly rows: readonly RowView[]
  readonly t: Translate
  readonly toggle?: PartToggles | undefined
}): ReactNode {
  const partToggle = (row: RowView): PartToggle | undefined => toggle === undefined || row.failure?.stage === 'conflict'
    ? undefined
    : { busy: toggle.busy(row.rowId), onChange: (disabled) => { toggle.onSetDisabled(row.rowId, disabled) } }
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const failed = rows.filter(isFailedRow)
  const off = rows.filter(row => !isFailedRow(row) && !row.enabled)
  const offGroups = [
    { key: 'partDisabledByUser' as const, rows: off.filter(row => row.disabledBy === 'user') },
    { key: 'partDisabledByComposition' as const, rows: off.filter(row => row.disabledBy !== 'user') },
  ].filter(group => group.rows.length > 0)
  const rest = rows.filter(row => !isFailedRow(row) && row.enabled)
  const query = filter.trim().toLowerCase()
  const shown = query === '' ? rest : rest.filter(row => row.rowId.toLowerCase().includes(query))
  return (
    <div className={css.parts}>
      <div className={css.partsHead}>
        <span className={css.subLabel}>{t('partsLabel')}</span>
        {rows.length === 0 ? null : <span className={css.partsCount}>{partsSummary(rows, t)}</span>}
        {rest.length === 0
          ? null
          : (
            <Button
              variant="ghost"
              size="sm"
              className={css.partsToggle}
              aria-expanded={open}
              onClick={() => { setOpen(current => !current) }}
            >
              {t(open ? 'partsCollapse' : 'partsShowAll')}
            </Button>
          )}
      </div>
      {rows.length === 0 ? <p className={css.status}>{t('partsEmpty')}</p> : null}
      {failed.length === 0
        ? null
        : (
          <ul className={css.partExceptions}>
            {failed.map((row) => {
              const rowToggle = partToggle(row)
              return (
                <li key={row.entryId} className={css.partException} data-plugin-row={row.entryId}>
                  <StateDot state="error" size={8} />
                  <span className={css.partId}>{row.rowId}</span>
                  <Tag tone="danger">{t('rowStateFailed')}</Tag>
                  {rowToggle === undefined ? null : <PartSwitch row={row} t={t} toggle={rowToggle} />}
                  {row.failure === undefined ? null : <p className={css.partFailure}>{row.failure.message}</p>}
                </li>
              )
            })}
          </ul>
        )}
      {offGroups.map(group => (
        <div key={group.key} className={css.partGroup}>
          <span className={css.partWhy}>{t('partsGroupLabel', { reason: t(group.key), count: String(group.rows.length) })}</span>
          <ul className={css.chips}>
            {group.rows.map(row => <PartChip key={row.entryId} row={row} off t={t} toggle={partToggle(row)} />)}
          </ul>
        </div>
      ))}
      {open
        ? (
          <div className={css.partsAll}>
            <Input
              type="search"
              className={css.partsFilter as string}
              placeholder={t('partsFilter')}
              aria-label={t('partsFilter')}
              value={filter}
              onChange={(event) => { setFilter(event.target.value) }}
            />
            {shown.length === 0
              ? <p className={css.status}>{t('partsFilterEmpty')}</p>
              : (
                <ul className={css.chips}>
                  {shown.map(row => <PartChip key={row.entryId} row={row} off={false} t={t} toggle={partToggle(row)} />)}
                </ul>
              )}
          </div>
        )
        : null}
    </div>
  )
}

/** One **Add to…** choice, carried through the menu as its item id. */
interface AddChoice {
  readonly declaredName: string
  readonly target: PluginRowTarget
}

/** The **Add to…** menu entries of one addable module; each id carries the choice it makes. */
function addTargets(
  entry: PluginPackageView['addable'][number], presets: readonly PresetGroup[], globalModules: readonly string[],
  t: Translate, presetName: (preset: PresetGroup) => string,
): MenuItem[] {
  const choice = (target: PluginRowTarget): string => JSON.stringify({ declaredName: entry.declaredName, target } satisfies AddChoice)
  const inGlobal = globalModules.includes(entry.moduleName)
  return [
    { id: choice({ kind: 'global' }), label: t(inGlobal ? 'addToGlobalAdded' : 'addToGlobal'), disabled: inGlobal },
    ...presets.map((preset) => {
      const added = preset.rows.some(row => row.source === 'user' && row.moduleName === entry.moduleName)
      return {
        id: choice({ kind: 'preset', preset: preset.id }),
        label: t(added ? 'addToPresetAdded' : 'addToPreset', { name: presetName(preset) }),
        disabled: added || preset.broken !== undefined,
      }
    }),
  ]
}

/** One installed package: its head with the switch or the add menu, and its details once expanded. */
function PackageCard({
  pkg, t, busy, open, presets, globalModules, presetName,
  onToggleOpen, onSetEnabled, onRetry, onUninstall, onAddRow, rowBusy, onSetRowDisabled,
}: {
  readonly pkg: PluginPackageView
  readonly t: Translate
  readonly busy: boolean
  readonly open: boolean
  readonly presets: readonly PresetGroup[]
  readonly globalModules: readonly string[]
  readonly presetName: (preset: PresetGroup) => string
  readonly onToggleOpen: () => void
  readonly onSetEnabled: (enabled: boolean) => void
  readonly onRetry: () => void
  readonly onUninstall: () => void
  readonly onAddRow: (declaredName: string, target: PluginRowTarget) => void
  /** Whether a component's row has a write in flight. */
  readonly rowBusy: (rowId: string) => boolean
  readonly onSetRowDisabled: (rowId: string, disabled: boolean) => void
}): ReactNode {
  const [addMenu, setAddMenu] = useState(false)
  const title = pkg.title ?? shortName(pkg.name)
  const bundle = pkg.kind === 'bundle'
  const builtin = pkg.trust === 'builtin'
  const status: CardStatus | null = bundle ? STATUS_OF[pkg.status] : pkg.reason === undefined ? null : 'problem'
  const detailId = `plugin-package-${encodeURIComponent(pkg.name)}`
  const addable = pkg.addable.filter(entry => entry.ok)
  const [single] = addable
  const menuItems: MenuItem[] = single !== undefined && addable.length === 1
    ? addTargets(single, presets, globalModules, t, presetName)
    : addable.map(entry => ({
      id: entry.moduleName,
      label: entry.title ?? entry.declaredName,
      submenu: addTargets(entry, presets, globalModules, t, presetName),
    }))
  const retryable = bundle && pkg.enabled && (pkg.status === 'failed' || pkg.status === 'partial')
  const removable = pkg.installed && !builtin
  // A component's switch acts at once only on an external pack composed on a
  // profile that applies patches while it runs; elsewhere the chips stay read-only.
  const switchable = bundle && !builtin && pkg.enabled && pkg.liveReload
  return (
    <li
      className={css.card}
      data-plugin-package={pkg.name}
      data-plugin-status={pkg.status}
      data-open={open ? 'true' : undefined}
    >
      <div className={css.cardHead}>
        <div className={css.cardMain}>
          <div className={css.titleRow}>
            <span className={css.cardTitle}>{title}</span>
            {builtin ? <Tag>{t('builtinTag')}</Tag> : null}
            {status === null ? null : <Tag tone={status === 'restart' ? 'warning' : 'danger'}>{t(STATUS_KEYS[status])}</Tag>}
          </div>
          {pkg.description === undefined ? null : <span className={css.cardDesc}>{pkg.description}</span>}
        </div>
        <div className={css.cardEnd}>
          {bundle
            ? (
              <Switch
                checked={pkg.enabled}
                label={t('enableToggle', { name: title })}
                disabled={busy || builtin || (!pkg.enabled && pkg.status === 'not-enableable')}
                {...builtin ? { title: t('builtinLocked') } : {}}
                onChange={onSetEnabled}
              />
            )
            : null}
          {menuItems.length === 0
            ? null
            : (
              <Menu
                open={addMenu}
                onClose={() => { setAddMenu(false) }}
                items={menuItems}
                onSelect={(id) => {
                  setAddMenu(false)
                  // Only a leaf carries a choice; a submenu parent's id is its module name.
                  const choice = JSON.parse(id) as AddChoice
                  onAddRow(choice.declaredName, choice.target)
                }}
                align="end"
                portal
                anchor={(
                  <Button
                    variant="outline"
                    size="sm"
                    aria-haspopup="menu"
                    aria-expanded={addMenu}
                    disabled={busy}
                    onClick={() => { setAddMenu(current => !current) }}
                  >
                    {t('addTo')}
                  </Button>
                )}
              />
            )}
          <button
            type="button"
            className={css.iconButton}
            aria-expanded={open}
            aria-controls={detailId}
            aria-label={t(open ? 'collapse' : 'expand', { name: title })}
            onClick={onToggleOpen}
          >
            <IconChevronDownOutline14 className={clsx(css.chevron, open && css.chevronOpen)} aria-hidden="true" />
          </button>
        </div>
      </div>
      {open
        ? (
          <div className={css.cardBody} id={detailId}>
            {pkg.reason === undefined ? null : <p className={css.reason} role="status">{t('reasonLabel')}: {pkg.reason}</p>}
            <dl className={css.facts}>
              {pkg.version === undefined ? null : <><dt>{t('versionLabel')}</dt><dd>{pkg.version}</dd></>}
              <dt>{t('sourceLabel')}</dt>
              <dd>{t(builtin ? 'sourceBuiltin' : 'sourceLocal')}</dd>
            </dl>
            {bundle
              ? (
                <BundleParts
                  rows={pkg.rows}
                  t={t}
                  toggle={switchable ? { busy: rowId => busy || rowBusy(rowId), onSetDisabled: onSetRowDisabled } : undefined}
                />
              )
              : null}
            {retryable || removable
              ? (
                <div className={css.actions}>
                  {retryable
                    ? <Button variant="ghost" size="sm" disabled={busy} onClick={onRetry}>{t('retryPackage')}</Button>
                    : null}
                  {removable
                    ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className={css.danger}
                        aria-label={t('uninstallLabel', { name: title })}
                        disabled={busy}
                        onClick={onUninstall}
                      >
                        {t('uninstall')}
                      </Button>
                    )
                    : null}
                </div>
              )
              : null}
          </div>
        )
        : null}
    </li>
  )
}

/** The sentence for one package the Host removed again after the install. */
function removedText(entry: PluginInstallRejection, t: Translate): string {
  return entry.reason.startsWith('row ')
    ? t('installRemovedConflict', { name: entry.name, reason: entry.reason })
    : t('installRemovedLibrary', { name: entry.name })
}

/** The install dialog: the spec, the enable choice, the run's progress, and pnpm's output behind a fold. */
function InstallDialog({ install, t, onClose, onEditSpec, onToggleEnable, onRun }: {
  readonly install: InstallState
  readonly t: Translate
  readonly onClose: () => void
  readonly onEditSpec: (text: string) => void
  readonly onToggleEnable: () => void
  readonly onRun: () => void
}): ReactNode {
  const running = install.phase === 'running'
  const exampleId = useId()
  const outcomes: string[] = install.phase !== 'done'
    ? []
    : install.installed.length === 0 && install.removed.length === 0
      ? [t('installDoneNothing')]
      : install.installed.map(name => t(
        install.enabled.includes(name)
          ? 'installDoneEnabled'
          : install.installedOnly.includes(name) ? 'installDoneBundle' : install.plain.includes(name) ? 'installDonePlugin' : 'installDoneOther',
        { name },
      ))
  return (
    <Modal
      open={install.open}
      onClose={onClose}
      title={t('installTitle')}
      closeLabel={t('close')}
      description={t('installDescription')}
      footer={(
        <>
          <Button variant="outline" disabled={running} onClick={onClose}>{t(install.phase === 'idle' ? 'cancel' : 'installClose')}</Button>
          <Button variant="primary" disabled={running || install.spec.trim() === ''} onClick={onRun}>{t('installRun')}</Button>
        </>
      )}
    >
      <div className={css.installBody}>
        <label className={css.installField}>
          <span>{t('installSpecLabel')}</span>
          <input
            type="text"
            value={install.spec}
            placeholder={t('installSpecPlaceholder')}
            aria-describedby={exampleId}
            disabled={running}
            onChange={(event) => { onEditSpec(event.currentTarget.value) }}
          />
        </label>
        <span id={exampleId} className={css.installExample}>{t('installExample')}</span>
        <label className={css.installOption}>
          <input type="checkbox" checked={install.enable} disabled={running} onChange={onToggleEnable} />
          <span>{t('installEnable')}</span>
        </label>
        {running
          ? <p className={css.progress} role="status"><span className={css.spinner} aria-hidden="true" />{t('installRunning', { spec: install.spec.trim() })}</p>
          : null}
        {outcomes.map(line => <p key={line} className={css.result} role="status">{line}</p>)}
        {install.phase === 'done'
          ? install.removed.map(entry => <p key={entry.name} className={css.resultWarn} role="status">{removedText(entry, t)}</p>)
          : null}
        {install.phase === 'failed'
          ? <p className={css.reason} role="alert">{install.failure === null ? t('installFailed') : refusalText(install.failure, t)}</p>
          : null}
        {install.log === ''
          ? null
          : (
            <details className={css.logFold} open={install.phase === 'failed'}>
              <summary>{t('installLogToggle')}</summary>
              <pre className={css.log} aria-label={t('installLogLabel')} aria-live="polite">{install.log}</pre>
            </details>
          )}
      </div>
    </Modal>
  )
}

/** The confirmation a destructive action waits on, naming what still uses the package. */
function ConfirmDialog({ confirm, t, packages, presets, presetName, onConfirm, onCancel }: {
  readonly confirm: ConfirmState
  readonly t: Translate
  readonly packages: readonly PluginPackageView[]
  readonly presets: readonly PresetGroup[]
  readonly presetName: (preset: PresetGroup) => string
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): ReactNode {
  const pkg = packages.find(candidate => candidate.name === confirm.packageName)
  const name = pkg?.title ?? shortName(confirm.packageName)
  const dependents = confirm.dependents
  const lines = dependents === undefined
    ? []
    : [
      ...dependents.services.map(service => t('dependentService', { rows: service.injectedBy.map(id => rowLabel(t, id)).join(', ') })),
      ...dependents.references.map((reference) => {
        const owner = packageOf(reference.moduleName, packages)
        const row = owner === undefined ? reference.rowId : owner.title ?? shortName(owner.name)
        if (reference.target.kind === 'global') return t('dependentReferenceGlobal', { row })
        const target = reference.target.preset
        const preset = presets.find(candidate => candidate.id === target)
        return t('dependentReferencePreset', { name: preset === undefined ? target : presetName(preset), row })
      }),
    ]
  const uninstall = confirm.action === 'uninstall'
  return (
    <Modal
      open
      onClose={onCancel}
      title={t(uninstall ? 'confirmUninstallTitle' : 'confirmDisableTitle', { name })}
      closeLabel={t('close')}
      description={t(uninstall ? 'confirmUninstallDescription' : 'confirmDisableDescription')}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" className={css.dangerButton} disabled={dependents === undefined} onClick={onConfirm}>
            {t(uninstall ? 'confirmUninstall' : 'confirmDisable')}
          </Button>
        </>
      )}
    >
      {dependents === undefined ? <p className={css.status}>{t('confirmChecking')}</p> : null}
      {lines.length > 0
        ? (
          <>
            <p className={css.status}>{t('confirmDependents')}</p>
            <ul className={css.dependents}>{lines.map(line => <li key={line}>{line}</li>)}</ul>
          </>
        )
        : null}
    </Modal>
  )
}

/** Render the plugin manager: the installed packages, the install dialog, and the confirmation. */
export function PluginManagerSettingsTab(props: PluginManagerSettingsTabProps): ReactNode {
  const { t, presetName, ensure } = props
  const state = props.usePluginManager(snapshot => snapshot)
  const [expanded, setExpanded] = useState<string | null>(null)
  useEffect(() => { ensure() }, [ensure])

  const restartPending = state.packages.filter(pkg => pkg.status === 'restart-required').map(pkg => pkg.title ?? shortName(pkg.name))
  const loaded = state.status === 'ready' || state.status === 'error'

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      <div className={css.toolbar}>
        <button type="button" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')} disabled={!loaded} onClick={props.refresh}>
          <span className={css.iconWrap} aria-hidden="true"><IconRefreshOutline16 /></span>
        </button>
        <Button variant="primary" size="sm" disabled={!loaded} onClick={props.openInstall}>{t('addPlugin')}</Button>
      </div>
      {state.status === 'loading' ? <p className={css.status}>{t('loading')}</p> : null}
      {state.status === 'unavailable' ? <p className={css.status} role="status">{t('unavailable')}</p> : null}
      {state.status === 'error'
        ? (
          <div className={css.failure}>
            <p role="alert">{t('error')}</p>
            <Button variant="outline" size="sm" onClick={props.refresh}>{t('retry')}</Button>
          </div>
        )
        : null}
      {restartPending.length > 0
        ? <p className={css.banner} role="status">{t('restartBanner', { names: restartPending.join(', ') })}</p>
        : null}
      {state.notice === null
        ? null
        : (
          <p className={css.notice} data-kind={state.notice.kind} role={state.notice.kind === 'failed' ? 'alert' : 'status'}>
            <span>{noticeText(state.notice, t)}</span>
            <Button variant="ghost" size="sm" onClick={props.dismissNotice}>{t('dismiss')}</Button>
          </p>
        )}
      {loaded
        ? (
          <section className={css.group} data-plugin-scope="global">
            <div className={css.groupTitleRow}>
              <h3 className={css.groupTitle}>{t('installedTitle')}</h3>
              <span className={css.count} data-plugin-count={state.packages.length}>{`${String(state.packages.length)} ${t('countUnit')}`}</span>
            </div>
            {state.packages.length === 0
              ? <p className={css.empty}>{t('empty')}</p>
              : (
                <ul className={css.cards}>
                  {state.packages.map(pkg => (
                    <PackageCard
                      key={pkg.name}
                      pkg={pkg}
                      t={t}
                      busy={state.busy.includes(pkg.name)}
                      open={expanded === pkg.name}
                      presets={state.presets}
                      globalModules={state.globalModules}
                      presetName={presetName}
                      onToggleOpen={() => { setExpanded(current => current === pkg.name ? null : pkg.name) }}
                      onSetEnabled={(enabled) => { props.setEnabled(pkg.name, enabled) }}
                      onRetry={() => { props.retry(pkg.name) }}
                      onUninstall={() => { props.uninstall(pkg.name) }}
                      onAddRow={(declaredName, target) => { props.addRow(pkg.name, declaredName, target) }}
                      rowBusy={rowId => state.busy.includes(rowKey(GLOBAL, rowId))}
                      onSetRowDisabled={(rowId, disabled) => { props.setRowDisabled(GLOBAL, rowId, disabled) }}
                    />
                  ))}
                </ul>
              )}
          </section>
        )
        : null}
      <InstallDialog
        install={state.install}
        t={t}
        onClose={props.closeInstall}
        onEditSpec={props.editInstallSpec}
        onToggleEnable={props.toggleInstallEnable}
        onRun={props.runInstall}
      />
      {state.confirm === null
        ? null
        : (
          <ConfirmDialog
            confirm={state.confirm}
            t={t}
            packages={state.packages}
            presets={state.presets}
            presetName={presetName}
            onConfirm={props.confirm}
            onCancel={props.cancelConfirm}
          />
        )}
    </div>
  )
}
