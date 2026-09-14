/**
 * Global plugin management: installed package cards, bundle component switches,
 * entry diagnostics, streamed installation output and dependency confirmations.
 * Package details expose module names and runtime failures; non-bundle packages
 * retain package information and uninstall without automatic composition actions.
 */

import { isInstallPending } from './manager-store.ts'
import { useEffect, useId, useState, type ReactNode } from 'react'
import type { PluginInstallRejection, PluginPackageView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, IconChevronDownOutline14, IconCordisPluginOutline14, IconRefreshOutline16,
  Input, Modal, StateDot, Switch, Tag, TerminalBlock,
  type StateDotState, type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginManagerLocaleKey } from './locales.ts'
import { rowKey, type ConfirmState, type InstallState, type PluginManagerFace } from './manager-store.ts'
import { NoticeLine } from './NoticeLine.tsx'
import { packageOf, refusalText, rowLabel, shortName, type Translate } from './presentation.ts'
import css from './PluginManagerPage.module.css'

/** Full component props assembled by the main slot renderer. */
export type PluginManagerPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'pluginManager'>
  & InjectFace<PluginManagerFace>

type RowView = PluginPackageView['rows'][number]
type RowPhase = NonNullable<RowView['phase']>

/** The layer a pack's components are switched in: a row override always lands in the profile's global user layer. */

/** The list's two groups: packs, which switch as a whole, and everything else, which joins a composition per row. */
const PACKAGE_GROUPS = [
  { key: 'bundles', titleKey: 'bundlesTitle', holds: (pkg: PluginPackageView) => pkg.kind === 'bundle' },
  { key: 'plugins', titleKey: 'pluginsTitle', holds: (pkg: PluginPackageView) => pkg.kind !== 'bundle' },
] as const satisfies readonly { key: string; titleKey: PluginManagerLocaleKey; holds: (pkg: PluginPackageView) => boolean }[]

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
  if (row.phase === 'active' && row.failure?.stage === 'inject-pending') return false
  return !isWaitingRow(row) && (row.failure !== undefined || row.phase === 'failed')
}

/** The tag one package carries: a pending restart, rows waiting for a service, a problem, or none. */
function cardStatus(pkg: PluginPackageView): CardStatus | null {
  const base = pkg.kind === 'bundle' ? STATUS_OF[pkg.status] : pkg.reason === undefined ? null : 'problem'
  if (base === 'problem' && pkg.kind === 'bundle' && pkg.enabled
    && pkg.rows.some(isWaitingRow) && !pkg.rows.some(isFailedRow)
    && !pkg.issues?.some(issue => issue.stage !== 'inject-pending')) return 'waiting'
  return base
}

/** The count line over a pack's components: the total, then only the states that occur. */
function partsSummary(rows: readonly RowView[], t: Translate): string {
  const failed = rows.filter(row => row.phase !== 'active' && isFailedRow(row)).length
  const updateFailed = rows.filter(row => row.phase === 'active' && isFailedRow(row)).length
  const waiting = rows.filter(isWaitingRow).length
  const off = rows.filter(row => !row.enabled && !isFailedRow(row) && !isWaitingRow(row)).length
  const running = rows.filter(row => row.enabled && row.phase === 'active').length
  return [
    t('partsCountTotal', { count: String(rows.length) }),
    ...running > 0 ? [t('partsCountRunning', { count: String(running) })] : [],
    ...waiting > 0 ? [t('partsCountWaiting', { count: String(waiting) })] : [],
    ...off > 0 ? [t('partsCountOff', { count: String(off) })] : [],
    ...failed > 0 ? [t('partsCountFailed', { count: String(failed) })] : [],
    ...updateFailed > 0 ? [t('partsCountUpdateFailed', { count: String(updateFailed) })] : [],
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
  if (isFailedRow(row)) return t(row.phase === 'active' ? 'rowUpdateFailed' : 'rowStateFailed')
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
                  {row.failure === undefined || (row.phase === 'active' && !isFailedRow(row)) ? null : <p className={css.rowFailure}>{row.failure.message}</p>}
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

/** A bundle's enable switch on its card and its page: locked for a built-in bundle, off and locked for one the profile cannot enable. */
function EnableSwitch({ pkg, title, t, busy, onSetEnabled }: {
  readonly pkg: PluginPackageView
  readonly title: string
  readonly t: Translate
  readonly busy: boolean
  readonly onSetEnabled: (enabled: boolean) => void
}): ReactNode {
  if (pkg.kind !== 'bundle') return null
  return (
    <Switch
      checked={pkg.enabled}
      label={t('enableToggle', { name: title })}
      disabled={busy || (!pkg.enabled && pkg.status === 'not-enableable')}
      onChange={onSetEnabled}
    />
  )
}

/** One installed package as a card that opens its page: its name, its one-liner, its tags, and its bundle switch. */
function PackageCard({ pkg, t, busy, onOpen, onSetEnabled }: {
  readonly pkg: PluginPackageView
  readonly t: Translate
  readonly busy: boolean
  readonly onOpen: () => void
  readonly onSetEnabled: (enabled: boolean) => void
}): ReactNode {
  const title = pkg.title ?? shortName(pkg.name)
  const status = cardStatus(pkg)
  return (
    <li className={`${css.card} ${css.cardLink}`} data-plugin-package={pkg.name} data-plugin-status={pkg.status}>
      <div className={css.cardHead}>
        <div className={css.cardMain}>
          <div className={css.titleRow}>
            <button type="button" className={`${css.cardTitle} ${css.cardOpen}`} aria-label={t('openDetail', { name: title })} onClick={onOpen}>{title}</button>
            {status === null ? null : <Tag tone={status === 'problem' ? 'danger' : 'warning'}>{t(STATUS_KEYS[status])}</Tag>}
          </div>
          {pkg.description === undefined ? null : <span className={css.cardDesc}>{pkg.description}</span>}
        </div>
        <div className={css.cardEnd}>
          <EnableSwitch pkg={pkg} title={title} t={t} busy={busy} onSetEnabled={onSetEnabled} />

        </div>
      </div>
    </li>
  )
}

/**
 * One package's page: the crumb back to the list; its name, tags, one-liner,
 * and its switch; the reason when one applies; its version and source; its
 * rows with their switches; the built-in rows it changes; and retry and uninstall.
 */
function PackageDetail({
  pkg, t, busy, rowBusy,
  onBack, onSetEnabled, onRetry, onUninstall, onSetRowDisabled,
}: {
  readonly pkg: PluginPackageView
  readonly t: Translate
  readonly busy: boolean
  /** Whether a row has a write in flight. */
  readonly rowBusy: (rowId: string) => boolean
  readonly onBack: () => void
  readonly onSetEnabled: (enabled: boolean) => void
  readonly onRetry: () => void
  readonly onUninstall: () => void
  readonly onSetRowDisabled: (row: RowView, disabled: boolean) => void
}): ReactNode {
  const title = pkg.title ?? shortName(pkg.name)
  const bundle = pkg.kind === 'bundle'
  const status = cardStatus(pkg)
  const retryable = bundle && pkg.enabled && (pkg.status === 'failed' || pkg.status === 'partial')
  const affectedIssues = (pkg.issues ?? []).filter(issue => !pkg.rows.some(row => row.entryId === issue.entryId))
  // A row's switch acts at once only on a pack that is on, composed on a
  // profile that applies patches while it runs; elsewhere the rows stay read-only.
  const switchable = bundle && pkg.enabled && pkg.liveReload
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
            {status === null ? null : <Tag tone={status === 'problem' ? 'danger' : 'warning'}>{t(STATUS_KEYS[status])}</Tag>}
          </div>
          <p className={css.detailDesc}>{pkg.description ?? t('noDescription')}</p>
        </div>
        <div className={css.detailActions}>
          {retryable
            ? <Button variant="outline" size="sm" disabled={busy} onClick={onRetry}>{t('retryPackage')}</Button>
            : null}
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
          <EnableSwitch pkg={pkg} title={title} t={t} busy={busy} onSetEnabled={onSetEnabled} />
        </div>
      </div>
      {pkg.reason === undefined || status === 'waiting' ? null : <p className={css.reason} role="status">{t('reasonLabel')}: {pkg.reason}</p>}
      {pkg.kind === 'unknown' ? <p className={css.detailDesc}>{t('unknownPackage')}</p> : null}
      {pkg.version === undefined ? null : <dl className={css.facts}><dt>{t('versionLabel')}</dt><dd>{pkg.version}</dd></dl>}
      <div className={css.detailSections}>
        {affectedIssues.length === 0 ? null : (
          <section className={css.detailSection} data-plugin-affected-issues>
            <h4 className={css.sectionTitle}>{t('affectedIssuesLabel')}</h4>
            <ul className={css.rows}>
              {affectedIssues.map(issue => (
                <li key={issue.entryId} className={css.row}>
                  <span className={css.rowId}>{issue.entryId}</span>
                  <span className={css.rowModule}>{issue.moduleName}</span>
                  <p className={css.rowFailure}>{issue.message}</p>
                </li>
              ))}
            </ul>
          </section>
        )}
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

      </div>
    </div>
  )
}

/** The sentence for one package the Host removed again after the install. */
function removedText(entry: PluginInstallRejection, t: Translate): string {
  return entry.reason.startsWith('row ')
    ? t('installRemovedConflict', { name: entry.name, reason: entry.reason })
    : t('installRemovedInvalid', { name: entry.name, reason: entry.reason })
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
function InstallDialog({ install, t, onClose, onEditSpec, onToggleEnable, onRun, onCancel }: {
  readonly install: InstallState
  readonly t: Translate
  readonly onClose: () => void
  readonly onEditSpec: (text: string) => void
  readonly onToggleEnable: () => void
  readonly onRun: () => void
  readonly onCancel: () => void
}): ReactNode {
  const running = isInstallPending(install.phase)
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
        : running
          ? <Button variant="outline" disabled={install.phase !== 'running'} onClick={onCancel}>{t(install.phase === 'cancelling' ? 'installCancelling' : 'installCancel')}</Button>
          : (
            <>
              <Button variant="outline" disabled={running} onClick={onClose}>{t(install.phase === 'idle' ? 'cancel' : 'installClose')}</Button>
              <Button variant="primary" disabled={install.spec.trim() === ''} onClick={onRun}>
                {t(install.phase === 'failed' || install.phase === 'cancelled' ? 'installRetry' : 'installRun')}
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
          ? <p className={css.progress} role="status"><span className={css.spinner} aria-hidden="true" />{install.phase === 'starting' ? t('installStarting') : install.phase === 'cancelling' ? t('installCancelling') : install.phase === 'applying' ? t('installApplying') : t('installRunning', { spec: install.spec.trim() })}</p>
          : null}
        {outcomes.map(line => <p key={line} className={css.result} role="status">{line}</p>)}
        {install.phase === 'done'
          ? install.removed.map(entry => <p key={entry.name} className={css.resultWarn} role="status">{removedText(entry, t)}</p>)
          : null}
        {install.phase === 'cancelled' ? <p className={css.result} role="status">{t('installCancelled')}</p> : null}
        {install.failure?.code === 'client/cancel-unconfirmed' ? <p className={css.reason} role="alert">{t('installCancelUnconfirmed', { reason: install.failure.reason })}</p> : null}
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
            labels={{ ...terminalLabels(t), ...(install.phase === 'cancelled' || install.phase === 'cancelling' ? { failed: t('installCancelledShort') } : {}) }}
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
function ConfirmDialog({ confirm, t, packages, onConfirm, onCancel }: {
  readonly confirm: ConfirmState
  readonly t: Translate
  readonly packages: readonly PluginPackageView[]
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
        return t('dependentReferenceGlobal', { row })
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
export function PluginManagerPage(props: PluginManagerPageProps): ReactNode {
  const { t, ensure } = props
  const state = props.usePluginManager(snapshot => snapshot)
  // The package whose page is open; one that leaves the list (uninstalled) drops back to the cards.
  const [openPackage, setOpenPackage] = useState<string | null>(null)
  useEffect(() => { ensure() }, [ensure])

  // The page manages what the person installed; the bundles the profile
  // template supplies are inspected in the Settings Plugins section's Plugin list tab.
  const listed = state.packages.filter(pkg => pkg.installed)
  const restartPending = listed.filter(pkg => pkg.status === 'restart-required').map(pkg => pkg.title ?? shortName(pkg.name))
  const loaded = state.status === 'ready' || state.status === 'error'
  const openPkg = openPackage === null ? undefined : listed.find(pkg => pkg.name === openPackage)

  return (
    <section className={css.page} data-plugin-panel aria-busy={state.status === 'loading'}>
      {openPkg === undefined
        ? (
          <header className={css.pageHead}>
            <div>
              <h1 className={css.pageTitle}>{t('title')}</h1>
              <p className={css.pageIntro}>{t('intro')}</p>
            </div>
            <div className={css.toolbar}>
              <button type="button" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')} disabled={!loaded} onClick={props.refresh}>
                <span className={css.iconWrap} aria-hidden="true"><IconRefreshOutline16 /></span>
              </button>
              <Button variant="primary" size="sm" disabled={!loaded} onClick={props.openInstall}>{t('addPlugin')}</Button>
            </div>
          </header>
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
      <NoticeLine notice={state.notice} t={t} onDismiss={props.dismissNotice} />
      {loaded && openPkg !== undefined
        ? (
          <PackageDetail
            pkg={openPkg}
            t={t}
            busy={state.busy.includes(openPkg.name)}
            rowBusy={rowId => state.busy.includes(rowKey(rowId))}
            onBack={() => { setOpenPackage(null) }}
            onSetEnabled={(enabled) => { props.setEnabled(openPkg.name, enabled) }}
            onRetry={() => { props.retry(openPkg.name) }}
            onUninstall={() => { props.uninstall(openPkg.name) }}
            onSetRowDisabled={(row, disabled) => {
              // Off asks first when other rows inject what the row provides; on has nothing to ask.
              if (disabled) props.disableRow(openPkg.name, row.entryId, row.rowId)
              else props.setRowDisabled(row.rowId, false)
            }}
          />
        )
        : null}
      {loaded && openPkg === undefined
        ? listed.length === 0
          ? <p className={css.empty}>{t('empty')}</p>
          : PACKAGE_GROUPS.map((group) => {
            const members = listed.filter(group.holds)
            return members.length === 0
              ? null
              : (
                <section key={group.key} className={css.group} data-plugin-scope="global" data-plugin-group={group.key}>
                  <div className={css.groupTitleRow}>
                    <h3 className={css.groupTitle}>{t(group.titleKey)}</h3>
                    <span className={css.count} data-plugin-count={members.length}>{`${String(members.length)} ${t('countUnit')}`}</span>
                  </div>
                  <ul className={css.cards}>
                    {members.map(pkg => (
                      <PackageCard
                        key={pkg.name}
                        pkg={pkg}
                        t={t}
                        busy={state.busy.includes(pkg.name)}
                        onOpen={() => { setOpenPackage(pkg.name) }}
                        onSetEnabled={(enabled) => { props.setEnabled(pkg.name, enabled) }}
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
        onCancel={props.cancelInstall}
      />
      {state.confirm === null
        ? null
        : (
          <ConfirmDialog
            confirm={state.confirm}
            t={t}
            packages={state.packages}
            onConfirm={props.confirm}
            onCancel={props.cancelConfirm}
          />
        )}
    </section>
  )
}
