/**
 * The Manage plugins tab: the profile's installed packages as cards — a
 * plugin pack with its switch, a plugin with its **Add to…** menu, a built-in
 * pack with a locked switch — each a name, a one-liner, and a tag only when
 * a restart is pending or something is wrong; the install dialog streaming
 * pnpm's output behind a fold; and the confirmation a destructive action
 * waits on, naming what still uses the package. Entry ids, module names,
 * kinds, and probe facts stay off the page. A card opens the package's own
 * page: its version and source, its rows — each with its own switch on an
 * external pack composed on a live-reload profile — the built-in rows it
 * changes, the modules it declares addable, and its uninstall. A preset's
 * composition lives on the preset's own detail page (`PresetPluginsSection`).
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { PluginInstallRejection, PluginPackageView, PluginRowTarget } from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, IconChevronDownOutline14, IconChevronRightOutline14, IconCordisPluginOutline14, IconRefreshOutline16,
  Input, Menu, Modal, StateDot, Switch, Tag, TerminalBlock,
  type MenuItem, type StateDotState, type TerminalBlockLabels,
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

/** The list's two groups: packs, which switch as a whole, and everything else, which joins a composition per row. */
const PACKAGE_GROUPS = [
  { key: 'bundles', title: 'bundlesTitle', holds: (pkg: PluginPackageView) => pkg.kind === 'bundle' },
  { key: 'plugins', title: 'pluginsTitle', holds: (pkg: PluginPackageView) => pkg.kind !== 'bundle' },
] as const satisfies readonly { key: string; title: PluginManagerLocaleKey; holds: (pkg: PluginPackageView) => boolean }[]

const PHASE_KEYS = {
  pending: 'rowPhasePending',
  loading: 'rowPhaseLoading',
  active: 'rowPhaseActive',
  failed: 'rowPhaseFailed',
  unloading: 'rowPhaseUnloading',
} satisfies Record<RowPhase, PluginManagerLocaleKey>

/** The states a card tags; running and off are what the switch shows. */
type CardStatus = 'restart' | 'waiting' | 'problem'

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
  waiting: 'statusWaiting',
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

/**
 * A row waiting for a service another row provides: a fiber left pending by
 * a live recomposition, or the failure a fresh composition records for the
 * same wait. Both read as one state, since the person sees one situation.
 */
function isWaitingRow(row: RowView): boolean {
  if (row.phase === 'active') return false
  return row.failure?.stage === 'inject-pending' || (row.failure === undefined && row.phase === 'pending')
}

/** A row with a recorded startup failure or a failed fiber; a wait for a service is not a failure. */
function isFailedRow(row: RowView): boolean {
  if (row.phase === 'active') return false
  return !isWaitingRow(row) && (row.failure !== undefined || row.phase === 'failed')
}

/** The tag one package carries: a pending restart, rows waiting for a service, a problem, or none. */
function cardStatus(pkg: PluginPackageView): CardStatus | null {
  const base = pkg.kind === 'bundle' ? STATUS_OF[pkg.status] : pkg.reason === undefined ? null : 'problem'
  if (base === 'problem' && pkg.kind === 'bundle' && pkg.enabled && pkg.rows.some(isWaitingRow) && !pkg.rows.some(isFailedRow)) return 'waiting'
  return base
}

/** The count line over a pack's components: the total, then only the states that occur. */
function partsSummary(rows: readonly RowView[], t: Translate): string {
  const failed = rows.filter(isFailedRow).length
  const waiting = rows.filter(isWaitingRow).length
  const off = rows.filter(row => !row.enabled && !isFailedRow(row) && !isWaitingRow(row)).length
  const running = rows.filter(row => row.enabled && row.phase === 'active').length
  return [
    t('partsCountTotal', { count: String(rows.length) }),
    ...running > 0 ? [t('partsCountRunning', { count: String(running) })] : [],
    ...waiting > 0 ? [t('partsCountWaiting', { count: String(waiting) })] : [],
    ...off > 0 ? [t('partsCountOff', { count: String(off) })] : [],
    ...failed > 0 ? [t('partsCountFailed', { count: String(failed) })] : [],
  ].join(' · ')
}

/** The switch one row renders: whether a write is in flight for it, and the write it asks for. */
interface RowToggle {
  readonly busy: boolean
  readonly onChange: (disabled: boolean) => void
}

/** Switching for a pack's rows: which rows have a write in flight, and the write. */
interface RowToggles {
  readonly busy: (rowId: string) => boolean
  readonly onSetDisabled: (row: RowView, disabled: boolean) => void
}

/** Rows beyond this count get a filter box above the list. */
const ROW_FILTER_THRESHOLD = 10

/** A row's switch: off when the person switched it off; locked, saying why, when the pack itself keeps it off. */
function RowSwitch({ row, t, toggle }: { readonly row: RowView; readonly t: Translate; readonly toggle: RowToggle }): ReactNode {
  const locked = row.disabledBy === 'composition'
  return (
    <Switch
      checked={row.enabled}
      label={t('partToggle', { name: row.rowId })}
      disabled={toggle.busy || locked}
      {...locked ? { title: t('partLockedByComposition') } : {}}
      onChange={(next) => { toggle.onChange(!next) }}
    />
  )
}

/** What a row's state line says: the failure, why it is off, or the phase its fiber is in. */
function rowStateText(row: RowView, t: Translate): string {
  if (isWaitingRow(row)) return t('rowPhasePending')
  if (isFailedRow(row)) return t('rowStateFailed')
  if (!row.enabled) return t(row.disabledBy === 'user' ? 'partDisabledByUser' : 'partDisabledByComposition')
  return row.phase === null ? t('rowStateIdle') : t(PHASE_KEYS[row.phase])
}

/** The dot beside a row: its failure, its fiber phase, or idle. */
function rowDotState(row: RowView): StateDotState {
  if (isWaitingRow(row)) return 'ongoing'
  if (isFailedRow(row)) return 'error'
  if (!row.enabled || row.phase === null) return 'idle'
  return PHASE_STATES[row.phase]
}

/**
 * A pack's rows as a list in the order the pack declares them: a state dot,
 * the row id, one line saying its state, the failure when one is recorded,
 * and, when the pack is switchable, a switch — except on a row another layer
 * owns, of which nothing mounted. A pack like base carries close to a hundred
 * rows, so a long list gets a filter.
 */
function RowsSection({ rows, t, toggle }: {
  readonly rows: readonly RowView[]
  readonly t: Translate
  readonly toggle?: RowToggles | undefined
}): ReactNode {
  const [filter, setFilter] = useState('')
  const query = filter.trim().toLowerCase()
  const shown = query === '' ? rows : rows.filter(row => row.rowId.toLowerCase().includes(query))
  return (
    <section className={css.detailSection} data-plugin-rows>
      <div className={css.sectionHead}>
        <h4 className={css.sectionTitle}>{t('partsLabel')}</h4>
        {rows.length === 0 ? null : <span className={css.sectionCount}>{partsSummary(rows, t)}</span>}
      </div>
      {rows.length === 0 ? <p className={css.status}>{t('partsEmpty')}</p> : null}
      {rows.length > ROW_FILTER_THRESHOLD
        ? (
          <Input
            type="search"
            className={css.partsFilter as string}
            placeholder={t('partsFilter')}
            aria-label={t('partsFilter')}
            value={filter}
            onChange={(event) => { setFilter(event.target.value) }}
          />
        )
        : null}
      {rows.length > 0 && shown.length === 0 ? <p className={css.status}>{t('partsFilterEmpty')}</p> : null}
      {shown.length === 0
        ? null
        : (
          <ul className={css.rows}>
            {shown.map((row) => {
              const rowToggle = toggle === undefined || row.failure?.stage === 'conflict'
                ? undefined
                : { busy: toggle.busy(row.rowId), onChange: (disabled: boolean) => { toggle.onSetDisabled(row, disabled) } }
              return (
                <li
                  key={row.entryId}
                  className={css.row}
                  data-plugin-row={row.entryId}
                  {...isWaitingRow(row) ? { 'data-state': 'waiting' } : isFailedRow(row) ? { 'data-state': 'failed' } : row.enabled ? {} : { 'data-state': 'off' }}
                >
                  <div className={css.rowLine}>
                    <span className={css.rowIcon} aria-hidden="true"><IconCordisPluginOutline14 /></span>
                    <div className={css.rowMain}>
                      <span className={css.rowId}>{row.rowId}</span>
                      <span className={css.rowModule}>{row.moduleName}</span>
                    </div>
                    <span className={css.rowState}>
                      <StateDot state={rowDotState(row)} size={8} />
                      {rowStateText(row, t)}
                    </span>
                    {rowToggle === undefined ? null : <RowSwitch row={row} t={t} toggle={rowToggle} />}
                  </div>
                  {row.failure === undefined || row.phase === 'active' ? null : <p className={css.rowFailure}>{row.failure.message}</p>}
                </li>
              )
            })}
          </ul>
        )}
    </section>
  )
}

/** The built-in rows the pack's patch changes, by id: the one thing a pack does outside its own rows. */
function OverridesSection({ overrides, t }: { readonly overrides: readonly string[]; readonly t: Translate }): ReactNode {
  return (
    <section className={css.detailSection} data-plugin-overrides>
      <div className={css.sectionHead}>
        <h4 className={css.sectionTitle}>{t('overridesLabel')}</h4>
      </div>
      <ul className={css.chips}>
        {overrides.map(id => <li key={id} className={css.chip}>{id}</li>)}
      </ul>
    </section>
  )
}

/** Where one module is composed already: every session, then the presets that carry it. */
function joinedTargets(
  entry: PluginPackageView['addable'][number], presets: readonly PresetGroup[], globalModules: readonly string[],
  t: Translate, presetName: (preset: PresetGroup) => string,
): string[] {
  return [
    ...globalModules.includes(entry.moduleName) ? [t('joinedGlobal')] : [],
    ...presets.filter(preset => preset.rows.some(row => row.moduleName === entry.moduleName)).map(presetName),
  ]
}

/** The modules a package declares addable: each with where it is composed, or why it cannot be, and its **Add to…** menu. */
function ModulesSection({ pkg, t, busy, presets, globalModules, presetName, onAddRow }: {
  readonly pkg: PluginPackageView
  readonly t: Translate
  readonly busy: boolean
  readonly presets: readonly PresetGroup[]
  readonly globalModules: readonly string[]
  readonly presetName: (preset: PresetGroup) => string
  readonly onAddRow: (declaredName: string, target: PluginRowTarget) => void
}): ReactNode {
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const title = pkg.title ?? shortName(pkg.name)
  return (
    <section className={css.detailSection} data-plugin-modules>
      <div className={css.sectionHead}>
        <h4 className={css.sectionTitle}>{t('modulesLabel')}</h4>
      </div>
      <ul className={css.rows}>
        {pkg.addable.map((entry) => {
          const joined = joinedTargets(entry, presets, globalModules, t, presetName)
          const open = openMenu === entry.moduleName
          return (
            <li key={entry.moduleName} className={css.row} data-plugin-module={entry.moduleName} {...entry.ok ? {} : { 'data-state': 'failed' }}>
              <div className={css.rowLine}>
                <span className={css.rowIcon} aria-hidden="true"><IconCordisPluginOutline14 /></span>
                <div className={css.rowMain}>
                  <span className={css.rowId}>{entry.title ?? (entry.declaredName === '.' ? title : entry.declaredName)}</span>
                  <span className={css.rowModule}>{entry.moduleName}</span>
                  <span className={css.rowNote}>
                    {entry.ok
                      ? joined.length > 0 ? t('moduleJoined', { targets: joined.join(t('joinedSeparator')) }) : t('moduleNotJoined')
                      : t('moduleBroken', { error: entry.error ?? '' })}
                  </span>
                </div>
                {entry.ok
                  ? (
                    <Menu
                      open={open}
                      onClose={() => { setOpenMenu(null) }}
                      items={addTargets(entry, presets, globalModules, t, presetName)}
                      onSelect={(id) => {
                        setOpenMenu(null)
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
                          aria-expanded={open}
                          disabled={busy}
                          onClick={() => { setOpenMenu(open ? null : entry.moduleName) }}
                        >
                          {t('addTo')}
                        </Button>
                      )}
                    />
                  )
                  : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
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

/** One installed package as a card: its name, its one-liner, its tags, its switch or its **Add to…** menu, and the way into its page. */
function PackageCard({ pkg, t, busy, presets, globalModules, presetName, onOpen, onSetEnabled, onAddRow }: {
  readonly pkg: PluginPackageView
  readonly t: Translate
  readonly busy: boolean
  readonly presets: readonly PresetGroup[]
  readonly globalModules: readonly string[]
  readonly presetName: (preset: PresetGroup) => string
  readonly onOpen: () => void
  readonly onSetEnabled: (enabled: boolean) => void
  readonly onAddRow: (declaredName: string, target: PluginRowTarget) => void
}): ReactNode {
  const [addMenu, setAddMenu] = useState(false)
  const title = pkg.title ?? shortName(pkg.name)
  const bundle = pkg.kind === 'bundle'
  const builtin = pkg.trust === 'builtin'
  const status = cardStatus(pkg)
  const addable = pkg.addable.filter(entry => entry.ok)
  const [single] = addable
  const menuItems: MenuItem[] = single !== undefined && addable.length === 1
    ? addTargets(single, presets, globalModules, t, presetName)
    : addable.map(entry => ({
      id: entry.moduleName,
      label: entry.title ?? entry.declaredName,
      submenu: addTargets(entry, presets, globalModules, t, presetName),
    }))
  return (
    <li className={css.card} data-plugin-package={pkg.name} data-plugin-status={pkg.status}>
      <div className={css.cardHead}>
        <div className={css.cardMain}>
          <div className={css.titleRow}>
            <span className={css.cardTitle}>{title}</span>
            {builtin ? <Tag>{t('builtinTag')}</Tag> : null}
            {status === null ? null : <Tag tone={status === 'problem' ? 'danger' : 'warning'}>{t(STATUS_KEYS[status])}</Tag>}
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
            aria-label={t('openDetail', { name: title })}
            title={t('openDetailTip')}
            onClick={onOpen}
          >
            <IconChevronRightOutline14 className={css.cardArrow} aria-hidden="true" />
          </button>
        </div>
      </div>
    </li>
  )
}

/**
 * One package's page: the crumb back to the list; its name, tags, one-liner,
 * and its switch; the reason when one applies; its version and source; its
 * rows with their switches; the built-in rows it changes; the modules it
 * declares addable with where each is composed; and retry and uninstall.
 */
function PackageDetail({
  pkg, t, busy, rowBusy, presets, globalModules, presetName,
  onBack, onSetEnabled, onRetry, onUninstall, onAddRow, onSetRowDisabled,
}: {
  readonly pkg: PluginPackageView
  readonly t: Translate
  readonly busy: boolean
  /** Whether a row has a write in flight. */
  readonly rowBusy: (rowId: string) => boolean
  readonly presets: readonly PresetGroup[]
  readonly globalModules: readonly string[]
  readonly presetName: (preset: PresetGroup) => string
  readonly onBack: () => void
  readonly onSetEnabled: (enabled: boolean) => void
  readonly onRetry: () => void
  readonly onUninstall: () => void
  readonly onAddRow: (declaredName: string, target: PluginRowTarget) => void
  readonly onSetRowDisabled: (row: RowView, disabled: boolean) => void
}): ReactNode {
  const title = pkg.title ?? shortName(pkg.name)
  const bundle = pkg.kind === 'bundle'
  const builtin = pkg.trust === 'builtin'
  const status = cardStatus(pkg)
  const retryable = bundle && pkg.enabled && (pkg.status === 'failed' || pkg.status === 'partial')
  const removable = pkg.installed && !builtin
  // A row's switch acts at once only on an external pack composed on a
  // profile that applies patches while it runs; elsewhere the rows stay read-only.
  const switchable = bundle && !builtin && pkg.enabled && pkg.liveReload
  return (
    <div className={css.detail} data-plugin-detail={pkg.name}>
      <button type="button" className={css.crumb} aria-label={t('backToList')} onClick={onBack}>
        <IconChevronDownOutline14 className={css.crumbIcon} aria-hidden="true" />
        <span>{t('crumbRoot')}</span>
        <span className={css.crumbSep} aria-hidden="true" />
        <span className={css.crumbHere}>{title}</span>
      </button>
      <div className={css.detailHead}>
        <div className={css.detailMain}>
          <div className={css.titleRow}>
            <h3 className={css.detailTitle}>{title}</h3>
            {builtin ? <Tag>{t('builtinTag')}</Tag> : null}
            {status === null ? null : <Tag tone={status === 'problem' ? 'danger' : 'warning'}>{t(STATUS_KEYS[status])}</Tag>}
          </div>
          <p className={css.detailDesc}>{pkg.description ?? t('noDescription')}</p>
        </div>
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
      </div>
      {pkg.reason === undefined || status === 'waiting' ? null : <p className={css.reason} role="status">{t('reasonLabel')}: {pkg.reason}</p>}
      <dl className={css.facts}>
        {pkg.version === undefined ? null : <><dt>{t('versionLabel')}</dt><dd>{pkg.version}</dd></>}
        <dt>{t('sourceLabel')}</dt>
        <dd>{t(builtin ? 'sourceBuiltin' : 'sourceExternal')}</dd>
      </dl>
      <div className={css.detailSections}>
        {bundle
          ? (
            <RowsSection
              rows={pkg.rows}
              t={t}
              toggle={switchable ? { busy: rowId => busy || rowBusy(rowId), onSetDisabled: onSetRowDisabled } : undefined}
            />
          )
          : null}
        {pkg.overrides.length === 0 ? null : <OverridesSection overrides={pkg.overrides} t={t} />}
        {pkg.addable.length === 0
          ? null
          : (
            <ModulesSection
              pkg={pkg}
              t={t}
              busy={busy}
              presets={presets}
              globalModules={globalModules}
              presetName={presetName}
              onAddRow={onAddRow}
            />
          )}
        {retryable || removable
          ? (
            <div className={css.detailActions}>
              {retryable
                ? <Button variant="outline" size="sm" disabled={busy} onClick={onRetry}>{t('retryPackage')}</Button>
                : null}
              {removable
                ? (
                  <Button
                    variant="outline"
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
    </div>
  )
}

/** The sentence for one package the Host removed again after the install. */
function removedText(entry: PluginInstallRejection, t: Translate): string {
  return entry.reason.startsWith('row ')
    ? t('installRemovedConflict', { name: entry.name, reason: entry.reason })
    : t('installRemovedLibrary', { name: entry.name })
}

/** Output lines an install run's terminal shows before its middle folds: the first and last six of a long pnpm log. */
const INSTALL_TERMINAL_LINES = 12

/** The install terminal's display copy, from the tab's dictionary. */
function terminalLabels(t: Translate): TerminalBlockLabels {
  return {
    /* v8 ignore next -- the Host reports a killed pnpm as a null exit code, never a signal name; the label interface needs one */
    signal: signal => t('terminalSignal', { signal }),
    exitCode: code => t('terminalExitCode', { code: String(code) }),
    noExitCode: t('terminalNoExitCode'),
    running: t('terminalRunning'),
    failed: t('terminalFailed'),
    done: t('terminalDone'),
    copy: t('terminalCopy'),
    copied: t('terminalCopied'),
    noOutput: t('terminalNoOutput'),
    collapseAria: t('terminalCollapseAria'),
    collapse: t('terminalCollapse'),
    expandAria: hidden => t('terminalExpandAria', { n: String(hidden) }),
    expand: hidden => t('terminalExpand', { n: String(hidden) }),
  }
}

/**
 * The failure line: the Host's refusal in its words, except a pnpm failure,
 * which the terminal above already shows — unless none of its output reached
 * the dialog, in which case the Host's captured tail stands in.
 */
function failureText(install: InstallState, t: Translate): string {
  if (install.failure === null) return t('installFailed')
  if (install.failure.code === 'plugins/install-failed' && install.runs.length === 0) {
    return t('installFailedTail', { reason: install.failure.reason })
  }
  return refusalText(install.failure, t)
}

/** The install dialog: the spec, the enable choice, the run's progress, and a terminal per pnpm run. */
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
  const firstRun = install.runs[0]
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
      className={css.installDialog as string}
      footer={install.phase === 'done'
        ? <Button variant="primary" onClick={onClose}>{t('installClose')}</Button>
        : (
          <>
            <Button variant="outline" disabled={running} onClick={onClose}>{t(install.phase === 'idle' ? 'cancel' : 'installClose')}</Button>
            <Button variant="primary" disabled={running || install.spec.trim() === ''} onClick={onRun}>
              {t(install.phase === 'failed' ? 'installRetry' : 'installRun')}
            </Button>
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
          ? <p className={css.reason} role="alert">{failureText(install, t)}</p>
          : null}
        {firstRun === undefined
          ? null
          : <p className={css.installLocation}>{t('installLocation', { dir: firstRun.cwd })}</p>}
        {install.runs.map(run => (
          <TerminalBlock
            key={run.jobId}
            command={run.command}
            output={run.output}
            running={run.exitCode === undefined}
            exitCode={run.exitCode}
            maxLines={INSTALL_TERMINAL_LINES}
            labels={terminalLabels(t)}
            className={css.terminal}
          />
        ))}
      </div>
    </Modal>
  )
}

/** The copy of each confirmation: its title, its one-line description, and its action button. */
const CONFIRM_KEYS = {
  uninstall: { titleKey: 'confirmUninstallTitle', descriptionKey: 'confirmUninstallDescription', actionKey: 'confirmUninstall' },
  disable: { titleKey: 'confirmDisableTitle', descriptionKey: 'confirmDisableDescription', actionKey: 'confirmDisable' },
  disableRow: { titleKey: 'confirmDisableRowTitle', descriptionKey: 'confirmDisableRowDescription', actionKey: 'confirmDisableRow' },
} as const satisfies Record<ConfirmState['action'], Record<'titleKey' | 'descriptionKey' | 'actionKey', PluginManagerLocaleKey>>

/** The confirmation a destructive action waits on, naming what still uses the package or the row. */
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
  const name = confirm.action === 'disableRow' ? confirm.rowId : pkg?.title ?? shortName(confirm.packageName)
  const keys = CONFIRM_KEYS[confirm.action]
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
  return (
    <Modal
      open
      onClose={onCancel}
      title={t(keys.titleKey, { name })}
      closeLabel={t('close')}
      description={t(keys.descriptionKey)}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" className={css.dangerButton} disabled={dependents === undefined} onClick={onConfirm}>
            {t(keys.actionKey)}
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
  // The package whose page is open; one that leaves the list (uninstalled) drops back to the cards.
  const [openPackage, setOpenPackage] = useState<string | null>(null)
  useEffect(() => { ensure() }, [ensure])

  const restartPending = state.packages.filter(pkg => pkg.status === 'restart-required').map(pkg => pkg.title ?? shortName(pkg.name))
  const loaded = state.status === 'ready' || state.status === 'error'
  const openPkg = openPackage === null ? undefined : state.packages.find(pkg => pkg.name === openPackage)

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      {openPkg === undefined
        ? (
          <div className={css.toolbar}>
            <button type="button" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')} disabled={!loaded} onClick={props.refresh}>
              <span className={css.iconWrap} aria-hidden="true"><IconRefreshOutline16 /></span>
            </button>
            <Button variant="primary" size="sm" disabled={!loaded} onClick={props.openInstall}>{t('addPlugin')}</Button>
          </div>
        )
        : null}
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
      {loaded && openPkg !== undefined
        ? (
          <PackageDetail
            pkg={openPkg}
            t={t}
            busy={state.busy.includes(openPkg.name)}
            rowBusy={rowId => state.busy.includes(rowKey(GLOBAL, rowId))}
            presets={state.presets}
            globalModules={state.globalModules}
            presetName={presetName}
            onBack={() => { setOpenPackage(null) }}
            onSetEnabled={(enabled) => { props.setEnabled(openPkg.name, enabled) }}
            onRetry={() => { props.retry(openPkg.name) }}
            onUninstall={() => { props.uninstall(openPkg.name) }}
            onAddRow={(declaredName, target) => { props.addRow(openPkg.name, declaredName, target) }}
            onSetRowDisabled={(row, disabled) => {
              // Off asks first when other rows inject what the row provides; on has nothing to ask.
              if (disabled) props.disableRow(openPkg.name, row.entryId, row.rowId)
              else props.setRowDisabled(GLOBAL, row.rowId, false)
            }}
          />
        )
        : null}
      {loaded && openPkg === undefined
        ? state.packages.length === 0
          ? <p className={css.empty}>{t('empty')}</p>
          : PACKAGE_GROUPS.map((group) => {
            const members = state.packages.filter(group.holds)
            return members.length === 0
              ? null
              : (
                <section key={group.key} className={css.group} data-plugin-scope="global" data-plugin-group={group.key}>
                  <div className={css.groupTitleRow}>
                    <h3 className={css.groupTitle}>{t(group.title)}</h3>
                    <span className={css.count} data-plugin-count={members.length}>{`${String(members.length)} ${t('countUnit')}`}</span>
                  </div>
                  <ul className={css.cards}>
                    {members.map(pkg => (
                      <PackageCard
                        key={pkg.name}
                        pkg={pkg}
                        t={t}
                        busy={state.busy.includes(pkg.name)}
                        presets={state.presets}
                        globalModules={state.globalModules}
                        presetName={presetName}
                        onOpen={() => { setOpenPackage(pkg.name) }}
                        onSetEnabled={(enabled) => { props.setEnabled(pkg.name, enabled) }}
                        onAddRow={(declaredName, target) => { props.addRow(pkg.name, declaredName, target) }}
                      />
                    ))}
                  </ul>
                </section>
              )
          })
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
