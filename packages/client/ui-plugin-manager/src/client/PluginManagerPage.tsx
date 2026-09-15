/**
 * Global plugin management: installed package cards, bundle component switches,
 * entry diagnostics, the guided install dialog with its folded pnpm output,
 * dependency confirmations, and the toasts an action's refusal becomes.
 * Package details expose module names and runtime failures; non-bundle packages
 * retain package information and uninstall without automatic composition actions.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { PluginInstallFailureKind, PluginInstallRejection, PluginPackageView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, IconCheckOutline16, IconChevronDownOutline14, IconChevronLeftOutline14, IconCloseOutline16,
  IconCordisPluginOutline14, IconRefreshOutline16, IconWarningOutline16,
  Input, Modal, StateDot, Switch, Tag, TerminalBlock, Toast,
  type StateDotState, type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginManagerLocaleKey } from './locales.ts'
import {
  isInstallPending, rowKey, type ConfirmState, type InstallInputError, type InstallState, type InstallSubject, type PluginManagerFace,
} from './manager-store.ts'
import { noticeText, packageOf, refusalText, rowLabel, shortName, type Translate } from './presentation.ts'
import css from './PluginManagerPage.module.css'

/** Full component props assembled by the main slot renderer. */
export type PluginManagerPageProps =
  PropsRuntime<'main'>
  & PropsLocale<'pluginManager'>
  & InjectFace<PluginManagerFace>

type RowView = PluginPackageView['rows'][number]
type RowPhase = NonNullable<RowView['phase']>

/** The layer a pack's components are switched in: a row override always lands in the profile's global user layer. */

/**
 * The list's two groups: packs, which switch as a whole, and the dependencies
 * that are not packs, which only uninstall and stay folded until opened.
 */
const PACKAGE_GROUPS = [
  { key: 'bundles', titleKey: 'bundlesTitle', introKey: undefined, folds: false, holds: (pkg: PluginPackageView) => pkg.kind === 'bundle' },
  { key: 'plugins', titleKey: 'pluginsTitle', introKey: 'pluginsIntro', folds: true, holds: (pkg: PluginPackageView) => pkg.kind !== 'bundle' },
] as const satisfies readonly {
  key: string
  titleKey: PluginManagerLocaleKey
  introKey: PluginManagerLocaleKey | undefined
  folds: boolean
  holds: (pkg: PluginPackageView) => boolean
}[]

/** How long the list marks a package an install just enabled. */
const HIGHLIGHT_MS = 2_400

/** How long a toast holds: long enough to read a failure that names what broke. */
function toastHoldMs(text: string): number {
  return Math.min(8_000, Math.max(3_000, text.length * 80))
}

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
function PackageCard({ pkg, t, busy, highlighted, onOpen, onSetEnabled }: {
  readonly pkg: PluginPackageView
  readonly t: Translate
  readonly busy: boolean
  readonly highlighted: boolean
  readonly onOpen: () => void
  readonly onSetEnabled: (enabled: boolean) => void
}): ReactNode {
  const title = pkg.title ?? shortName(pkg.name)
  const status = cardStatus(pkg)
  return (
    <li
      className={`${css.card} ${css.cardLink}`}
      data-plugin-package={pkg.name}
      data-plugin-status={pkg.status}
      {...highlighted ? { 'data-plugin-highlight': '' } : {}}
    >
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

/** The sentence under the field for a spec the check refused. */
const INPUT_PROBLEM_KEYS = {
  'invalid-spec': 'installProblemInvalid',
  'already-installed': 'installProblemInstalled',
  'not-found': 'installProblemNotFound',
  'not-a-package': 'installProblemNotPackage',
  'network': 'installProblemNetwork',
  'unknown': 'installProblemUnknown',
} satisfies Record<InstallInputError['problem'], PluginManagerLocaleKey>

/** The one-line reading of a classified pnpm failure. */
const FAILURE_KIND_KEYS = {
  'pnpm-missing': 'installFailurePnpmMissing',
  'timeout': 'installFailureTimeout',
  'not-found': 'installFailureNotFound',
  'no-matching-version': 'installFailureNoMatchingVersion',
  'network': 'installFailureNetwork',
  'disk-full': 'installFailureDiskFull',
  'permission': 'installFailurePermission',
  'build-blocked': 'installFailureBuildBlocked',
  'integrity': 'installFailureIntegrity',
  'unknown': 'installFailureGeneric',
} satisfies Record<PluginInstallFailureKind, PluginManagerLocaleKey>

/** The heading of each screen past the spec. */
const SCREEN_TITLE_KEYS = {
  starting: 'installStarting',
  running: 'installingTitle',
  cancelling: 'installCancelling',
  applying: 'installApplying',
  done: 'installedTitle',
  failed: 'installFailedTitle',
} satisfies Record<Exclude<InstallState['phase'], 'idle' | 'checking'>, PluginManagerLocaleKey>

/** What the spec's kind reads as when the package carries no description of its own. */
const SUBJECT_KIND_KEYS = {
  registry: undefined,
  path: 'installSubjectPath',
  git: 'installSubjectGit',
  tarball: 'installSubjectTarball',
} satisfies Record<InstallSubject['kind'], PluginManagerLocaleKey | undefined>

/**
 * The failed screen's one line: a pnpm failure by its kind, any other
 * refusal in the Host's words; the run's output stays behind the details.
 */
function failureText(failure: InstallState['failure'], t: Translate): string {
  if (failure === null) return t('installFailureGeneric')
  if (failure.code === 'plugins/install-failed') return t(FAILURE_KIND_KEYS[failure.kind ?? 'unknown'])
  return refusalText(failure, t)
}

/** The package the install is about: its title, one-liner, and version, as the Host read them before installing. */
function SubjectCard({ subject, t }: { readonly subject: InstallSubject; readonly t: Translate }): ReactNode {
  const title = subject.title ?? subject.name ?? subject.spec
  const kindKey = SUBJECT_KIND_KEYS[subject.kind]
  const description = subject.description ?? (kindKey === undefined ? undefined : t(kindKey))
  return (
    <div className={css.subject} data-install-subject={subject.spec}>
      <p className={css.subjectName}>{title}</p>
      {description === undefined ? null : <p className={css.subjectDesc}>{description}</p>}
      {subject.version === undefined ? null : <p className={css.subjectMeta}>{t('installVersion', { version: subject.version })}</p>}
    </div>
  )
}

/** The install dialog: the spec and its check, then the installing, installed, and failed screens over the same subject card. */
function InstallDialog({ install, t, onClose, onEditSpec, onRun, onCancel, onToggleDetails, onEnableNow }: {
  readonly install: InstallState
  readonly t: Translate
  readonly onClose: () => void
  readonly onEditSpec: (text: string) => void
  readonly onRun: () => void
  readonly onCancel: () => void
  readonly onToggleDetails: () => void
  readonly onEnableNow: () => void
}): ReactNode {
  const errorId = useId()
  const { phase } = install
  if (phase === 'idle' || phase === 'checking') {
    const checking = phase === 'checking'
    const empty = install.spec.trim() === ''
    return (
      <Modal
        open={install.open}
        onClose={onClose}
        title={t('installTitle')}
        closeLabel={t('close')}
        description={t('installDescription')}
        className={css.installDialog as string}
        footer={(
          <Button variant="primary" className={css.wide} disabled={checking || empty} aria-busy={checking} onClick={onRun}>
            {checking ? <span className={css.spinner} aria-hidden="true" /> : null}
            {t(checking ? 'installChecking' : 'installRun')}
          </Button>
        )}
      >
        <div className={css.installBody}>
          <label className={css.installField}>
            <span>{t('installSpecLabel')}</span>
            <input
              type="text"
              value={install.spec}
              placeholder={t('installSpecPlaceholder')}
              disabled={checking}
              aria-invalid={install.inputError !== null}
              aria-describedby={install.inputError === null ? undefined : errorId}
              onChange={(event) => { onEditSpec(event.currentTarget.value) }}
              onKeyDown={(event) => { if (event.key === 'Enter' && !empty && !checking) onRun() }}
            />
          </label>
          {install.inputError === null
            ? null
            : <p id={errorId} className={css.inputError} role="alert">{t(INPUT_PROBLEM_KEYS[install.inputError.problem], { reason: install.inputError.reason })}</p>}
        </div>
      </Modal>
    )
  }
  const heading = t(SCREEN_TITLE_KEYS[phase])
  const pending = isInstallPending(phase)
  // Only a run the Host acknowledged can be stopped; before that, and while it stops or applies, the controls wait.
  const stoppable = phase === 'running' || phase === 'failed'
  const unconfirmed = install.failure?.code === 'client/cancel-unconfirmed' ? install.failure.reason : undefined
  const firstRun = install.runs[0]
  return (
    <Modal open={install.open} onClose={onClose} title={heading} headless className={css.installDialog as string}>
      <div className={css.wizard} data-install-phase={phase}>
        <div className={css.wizardHead}>
          {phase === 'done'
            ? <span />
            : (
              <button type="button" className={css.wizardBack} aria-label={t('installEditAria')} disabled={!stoppable} onClick={onCancel}>
                <IconChevronLeftOutline14 aria-hidden="true" />
                <span>{t('installEdit')}</span>
              </button>
            )}
          <button type="button" className={css.wizardClose} aria-label={t('close')} disabled={pending} onClick={onClose}>
            <IconCloseOutline16 size={14} />
          </button>
        </div>
        <div className={css.wizardHero}>
          <span className={css.wizardIcon} data-tone={pending ? 'pending' : phase} aria-hidden="true">
            {pending
              ? <span className={css.spinnerLarge} />
              : phase === 'done' ? <IconCheckOutline16 size={28} /> : <IconWarningOutline16 size={28} />}
          </span>
          <h2 className={css.wizardTitle} role={phase === 'failed' ? 'alert' : 'status'}>{heading}</h2>
          {phase === 'failed' ? <p className={css.wizardSub}>{failureText(install.failure, t)}</p> : null}
          {unconfirmed === undefined ? null : <p className={css.wizardSub} role="alert">{t('installCancelUnconfirmed', { reason: unconfirmed })}</p>}
        </div>
        {install.subject === null ? null : <SubjectCard subject={install.subject} t={t} />}
        {phase === 'done' && install.installed.length === 0 && install.removed.length === 0
          ? <p className={css.result} role="status">{t('installDoneNothing')}</p>
          : null}
        {phase === 'done'
          ? install.plain.map(name => <p key={name} className={css.resultWarn} role="status">{t('installDoneNotBundle', { name })}</p>)
          : null}
        {phase === 'done'
          ? install.removed.map(entry => <p key={entry.name} className={css.resultWarn} role="status">{removedText(entry, t)}</p>)
          : null}
        <div className={css.wizardFoot}>
          <button type="button" className={css.detailsToggle} aria-expanded={install.detailsOpen} onClick={onToggleDetails}>
            <span>{t(install.detailsOpen ? 'installDetailsHide' : 'installDetailsShow')}</span>
            <IconChevronDownOutline14 className={css.detailsChevron} aria-hidden="true" />
          </button>
          {pending
            ? (
              <Button variant="outline" size="sm" disabled={phase !== 'running'} onClick={onCancel}>
                {t(phase === 'cancelling' ? 'installCancelling' : 'installCancel')}
              </Button>
            )
            : null}
          {phase === 'failed' ? <Button variant="primary" size="sm" onClick={onRun}>{t('installRetry')}</Button> : null}
        </div>
        {install.detailsOpen
          ? (
            <div className={css.detailsBody}>
              <p className={css.installLocation}>{firstRun === undefined ? t('terminalNoOutput') : t('installLocation', { dir: firstRun.cwd })}</p>
              {install.runs.map(run => (
                <TerminalBlock
                  key={run.jobId}
                  command={run.command}
                  output={run.output}
                  running={run.exitCode === undefined}
                  exitCode={run.exitCode}
                  maxLines={INSTALL_TERMINAL_LINES}
                  labels={{ ...terminalLabels(t), ...phase === 'cancelling' ? { failed: t('installCancelledShort') } : {} }}
                  className={css.terminal}
                />
              ))}
            </div>
          )
          : null}
        {phase !== 'done'
          ? null
          : install.installedOnly.length > 0
            ? <Button variant="primary" className={css.wide} disabled={install.enabling} aria-busy={install.enabling} onClick={onEnableNow}>{t('installEnableNow')}</Button>
            : <Button variant="primary" className={css.wide} onClick={onClose}>{t('installClose')}</Button>}
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
  // The folded group of dependencies that are not packs.
  const [pluginsOpen, setPluginsOpen] = useState(false)
  useEffect(() => { ensure() }, [ensure])
  // A package an install just enabled: scroll it into view and mark it for a moment.
  const { highlight, clearHighlight } = { highlight: state.highlight, clearHighlight: props.clearHighlight }
  useEffect(() => {
    if (highlight === null) return
    const card = document.querySelector(`[data-plugin-package="${highlight}"]`)
    if (card !== null && typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timer = setTimeout(clearHighlight, HIGHLIGHT_MS)
    return () => { clearTimeout(timer) }
  }, [highlight, clearHighlight])
  const noticeLine = state.notice === null ? null : noticeText(state.notice, t)

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
      {state.notice === null || noticeLine === null
        ? null
        : (
          <Toast
            key={state.notice.seq}
            text={noticeLine}
            icon={<IconWarningOutline16 />}
            holdMs={toastHoldMs(noticeLine)}
            onDone={props.dismissNotice}
          />
        )}
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
            const open = !group.folds || pluginsOpen
            return members.length === 0
              ? null
              : (
                <section key={group.key} className={css.group} data-plugin-scope="global" data-plugin-group={group.key}>
                  <div className={css.groupTitleRow}>
                    {group.folds
                      ? (
                        <button type="button" className={css.groupToggle} aria-expanded={open} onClick={() => { setPluginsOpen(value => !value) }}>
                          <IconChevronDownOutline14 className={css.groupChevron} aria-hidden="true" />
                          <span className={css.groupTitle}>{t(group.titleKey)}</span>
                        </button>
                      )
                      : <h3 className={css.groupTitle}>{t(group.titleKey)}</h3>}
                    <span className={css.count} data-plugin-count={members.length}>{`${String(members.length)} ${t('countUnit')}`}</span>
                  </div>
                  {group.introKey === undefined ? null : <p className={css.groupIntro}>{t(group.introKey)}</p>}
                  {open
                    ? (
                      <ul className={css.cards}>
                        {members.map(pkg => (
                          <PackageCard
                            key={pkg.name}
                            pkg={pkg}
                            t={t}
                            busy={state.busy.includes(pkg.name)}
                            highlighted={state.highlight === pkg.name}
                            onOpen={() => { setOpenPackage(pkg.name) }}
                            onSetEnabled={(enabled) => { props.setEnabled(pkg.name, enabled) }}
                          />
                        ))}
                      </ul>
                    )
                    : null}
                </section>
              )
          })
        : null}
      <InstallDialog
        install={state.install}
        t={t}
        onClose={props.closeInstall}
        onEditSpec={props.editInstallSpec}
        onRun={props.runInstall}
        onCancel={props.cancelInstall}
        onToggleDetails={props.toggleInstallDetails}
        onEnableNow={props.enableInstalled}
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
