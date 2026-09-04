/**
 * The Manage plugins tab: the profile's packages as cards with their switch,
 * rows, and actions; the selected agent preset's composition with per-row
 * switches; the install dialog streaming pnpm's output; and the confirmation
 * a destructive action waits on, listing what it would strand.
 */

import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { PluginPackageView, PluginRowTarget } from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, IconChevronDownOutline14, Menu, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PluginManagerLocaleKey } from './locales.ts'
import type {
  ConfirmState, InstallState, ManagerNotice, PluginManagerFace, PresetGroup, PresetRow,
} from './manager-store.ts'
import { rowKey } from './manager-store.ts'
import css from './PluginManagerSettingsTab.module.css'

/** Full component props assembled by the Settings slot renderer. */
export type PluginManagerSettingsTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pluginManager'>
  & InjectFace<PluginManagerFace>

type Translate = PluginManagerSettingsTabProps['t']
type RowView = PluginPackageView['rows'][number]
type RowPhase = NonNullable<RowView['phase']>

const PHASE_KEYS = {
  pending: 'rowPhasePending',
  loading: 'rowPhaseLoading',
  active: 'rowPhaseActive',
  failed: 'rowPhaseFailed',
  unloading: 'rowPhaseUnloading',
} satisfies Record<RowPhase, PluginManagerLocaleKey>

const STATUS_KEYS = {
  'running': 'statusRunning',
  'partial': 'statusPartial',
  'failed': 'statusFailed',
  'disabled': 'statusDisabled',
  'not-enableable': 'statusNotEnableable',
  'restart-required': 'statusRestartRequired',
  'plain': 'statusPlain',
} satisfies Record<PluginPackageView['status'], PluginManagerLocaleKey>

const KIND_KEYS = {
  bundle: 'bundleTag',
  plugin: 'pluginTag',
  library: 'libraryTag',
} satisfies Record<PluginPackageView['kind'], PluginManagerLocaleKey>

/** Compact a package name to what a person calls it. */
function shortName(name: string): string {
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return unscoped.replace(/^dsh-(?:host-|client-)?/, '')
}

/** The roster row shown when the switcher has no explicit choice. */
function fallbackPreset(presets: readonly PresetGroup[]): PresetGroup | undefined {
  return presets.find(preset => preset.isDefault) ?? presets[0]
}

function presetLabel(preset: PresetGroup, t: Translate, presetName: (preset: PresetGroup) => string): string {
  const name = presetName(preset)
  if (preset.broken !== undefined) return t('presetOptionBroken', { name })
  if (preset.isDefault) return t('presetOptionDefault', { name })
  return name
}

/** Status dot naming a live root-fiber phase. */
function PhaseDot({ phase, t }: { readonly phase: RowPhase; readonly t: Translate }): ReactNode {
  const label = t(PHASE_KEYS[phase])
  return <span className={css.statusDot} data-phase={phase} role="img" aria-label={label} title={label} />
}

function Tag({ kind, children }: { readonly kind: string; readonly children: ReactNode }): ReactNode {
  return <span className={css.tag} data-kind={kind}>{children}</span>
}

function Switch({ checked, label, disabled, title, onChange }: {
  readonly checked: boolean
  readonly label: string
  readonly disabled: boolean
  readonly title?: string
  readonly onChange: (checked: boolean) => void
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      className={clsx(css.switch, checked && css.switchOn)}
      disabled={disabled}
      onClick={() => { onChange(!checked) }}
    >
      <span className={css.thumb} />
    </button>
  )
}

/** One package: its header with the switch, and its details once expanded. */
function PackageCard({ pkg, t, busy, open, presets, presetName, onToggleOpen, onSetEnabled, onRetry, onUninstall, onAddRow }: {
  readonly pkg: PluginPackageView
  readonly t: Translate
  readonly busy: boolean
  readonly open: boolean
  readonly presets: readonly PresetGroup[]
  readonly presetName: (preset: PresetGroup) => string
  readonly onToggleOpen: () => void
  readonly onSetEnabled: (enabled: boolean) => void
  readonly onRetry: () => void
  readonly onUninstall: () => void
  readonly onAddRow: (declaredName: string, target: PluginRowTarget) => void
}): ReactNode {
  const [addMenu, setAddMenu] = useState<string | null>(null)
  const title = pkg.title ?? shortName(pkg.name)
  const bundle = pkg.kind === 'bundle'
  const locked = pkg.trust === 'builtin'
  const detailId = `plugin-package-${encodeURIComponent(pkg.name)}`
  const targets = [
    { id: 'global', label: t('addToGlobal') },
    ...presets.map(preset => ({ id: `preset:${preset.id}`, label: t('addToPreset', { name: presetName(preset) }) })),
  ]
  const targetOf = (id: string): PluginRowTarget =>
    id === 'global' ? { kind: 'global' } : { kind: 'preset', preset: id.slice('preset:'.length) }
  return (
    <li
      className={css.card}
      data-plugin-package={pkg.name}
      data-plugin-status={pkg.status}
      data-open={open ? 'true' : undefined}
    >
      <div className={css.cardHead}>
        <div className={css.cardMain}>
          <div className={css.cardTitleRow}>
            <span className={css.cardTitle}>{title}</span>
            <Tag kind={pkg.trust}>{t(pkg.trust === 'builtin' ? 'builtinTag' : 'externalTag')}</Tag>
            <Tag kind={pkg.kind}>{t(KIND_KEYS[pkg.kind])}</Tag>
            {pkg.stage === 'boot' ? <Tag kind="boot">{t('stageBootTag')}</Tag> : null}
            <Tag kind={pkg.status}>{t(STATUS_KEYS[pkg.status])}</Tag>
          </div>
          <span className={css.cardName}>{pkg.name}{pkg.version === undefined ? '' : ` · ${pkg.version}`}</span>
        </div>
        <div className={css.cardEnd}>
          {bundle
            ? (
              <Switch
                checked={pkg.enabled}
                label={t('enableToggle', { name: title })}
                disabled={busy || locked || (!pkg.enabled && pkg.status === 'not-enableable')}
                {...locked ? { title: t('builtinLocked') } : {}}
                onChange={onSetEnabled}
              />
            )
            : null}
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
            {pkg.description === undefined ? null : <p className={css.cardDescription}>{pkg.description}</p>}
            {pkg.reason === undefined ? null : <p className={css.reason} role="status">{t('reasonLabel')}: {pkg.reason}</p>}
            <dl className={css.facts}>
              <dt>{t('packageLabel')}</dt>
              <dd>{pkg.name}</dd>
              {pkg.enginesDsh === undefined ? null : <><dt>{t('enginesLabel')}</dt><dd>{pkg.enginesDsh}</dd></>}
              <dt>{t('cordisLabel')}</dt>
              <dd>{t(pkg.cordisSameCopy === null ? 'cordisUnknown' : pkg.cordisSameCopy ? 'cordisSame' : 'cordisForeign')}</dd>
              {pkg.probedAt === undefined ? null : <><dt>{t('probedAtLabel')}</dt><dd>{pkg.probedAt}</dd></>}
              {pkg.overrides.length === 0 ? null : <><dt>{t('overridesLabel')}</dt><dd>{pkg.overrides.join(', ')}</dd></>}
            </dl>
            {bundle
              ? (
                <>
                  <p className={css.groupSub}>{t('rowsLabel')}</p>
                  {pkg.rows.length === 0
                    ? <p className={css.status}>{t('rowsEmpty')}</p>
                    : (
                      <ul className={css.rows}>
                        {pkg.rows.map(row => (
                          <li key={row.entryId} className={css.row} data-plugin-row={row.entryId}>
                            {row.enabled && row.phase !== null ? <PhaseDot phase={row.phase} t={t} /> : null}
                            <span className={css.rowId}>{row.rowId}</span>
                            <span className={css.rowModule}>{row.moduleName}</span>
                            {row.enabled
                              ? null
                              : <Tag kind="disabled">{t(row.disabledBy === 'user' ? 'rowDisabledByUser' : 'rowDisabledByComposition')}</Tag>}
                            {row.failure === undefined ? null : <p className={css.rowFailure}>{row.failure.message}</p>}
                          </li>
                        ))}
                      </ul>
                    )}
                </>
              )
              : null}
            {pkg.addable.length === 0
              ? null
              : (
                <>
                  <p className={css.groupSub}>{t('addableLabel')}</p>
                  <ul className={css.rows}>
                    {pkg.addable.map(entry => (
                      <li key={entry.moduleName} className={css.row} data-plugin-addable={entry.moduleName}>
                        <span className={css.rowId}>{entry.title ?? entry.declaredName}</span>
                        <span className={css.rowModule}>{entry.moduleName}</span>
                        {entry.ok
                          ? (
                            <Menu
                              open={addMenu === entry.moduleName}
                              onClose={() => { setAddMenu(null) }}
                              items={targets}
                              onSelect={(id) => {
                                setAddMenu(null)
                                onAddRow(entry.declaredName, targetOf(id))
                              }}
                              align="end"
                              portal
                              anchor={(
                                <button
                                  type="button"
                                  className={css.linkButton}
                                  aria-haspopup="menu"
                                  aria-expanded={addMenu === entry.moduleName}
                                  disabled={busy}
                                  onClick={() => { setAddMenu(current => current === entry.moduleName ? null : entry.moduleName) }}
                                >
                                  {t('addTo')}
                                </button>
                              )}
                            />
                          )
                          : <Tag kind="failed">{t('addableNotOk')}</Tag>}
                        {entry.error === undefined ? null : <p className={css.rowFailure}>{entry.error}</p>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            <div className={css.actions}>
              {bundle && pkg.enabled && (pkg.status === 'failed' || pkg.status === 'partial')
                ? <button type="button" className={css.linkButton} disabled={busy} onClick={onRetry}>{t('retryPackage')}</button>
                : null}
              {pkg.installed && !locked
                ? (
                  <button type="button" className={css.linkButton} data-danger="true" disabled={busy} onClick={onUninstall}>
                    {t('uninstall')}
                  </button>
                )
                : null}
            </div>
          </div>
        )
        : null}
    </li>
  )
}

/** One row of the selected preset's composition, with its switch. */
function PresetRowItem({ preset, row, t, busy, onSetDisabled, onRemove }: {
  readonly preset: PresetGroup
  readonly row: PresetRow
  readonly t: Translate
  readonly busy: boolean
  readonly onSetDisabled: (rowId: string, disabled: boolean) => void
  readonly onRemove: (rowId: string) => void
}): ReactNode {
  const id = row.entryId
  const failed = row.fiberPhase === 'failed'
  const enabled = row.enabled === true
  return (
    <li className={css.row} data-preset-row={id ?? undefined} data-plugin-source={row.source}>
      {enabled && !failed && row.fiberPhase !== null ? <PhaseDot phase={row.fiberPhase} t={t} /> : null}
      <span className={css.rowId}>{id ?? shortName(row.moduleName)}</span>
      <span className={css.rowModule}>{row.moduleName}</span>
      {row.source === 'user' ? <Tag kind="user">{t('rowSourceUser')}</Tag> : null}
      {failed ? <Tag kind="failed">{t('rowPhaseFailed')}</Tag> : null}
      {row.enabled === 'conditional' ? <Tag kind="conditional">{t('rowConditional')}</Tag> : null}
      {row.enabled === false
        ? <Tag kind="disabled">{t(row.disabledBy === 'user' ? 'rowDisabledByUser' : 'rowDisabledByComposition')}</Tag>
        : null}
      {id === null
        ? <span className={css.rowModule} title={t('rowNoId')}>{t('rowNoId')}</span>
        : (
          <>
            <Switch
              checked={row.enabled !== false}
              label={t('rowToggle', { id })}
              disabled={busy || preset.broken !== undefined}
              onChange={(checked) => { onSetDisabled(id, !checked) }}
            />
            {row.source === 'user'
              ? (
                <button
                  type="button"
                  className={css.linkButton}
                  data-danger="true"
                  aria-label={t('rowRemove', { id })}
                  disabled={busy}
                  onClick={() => { onRemove(id) }}
                >
                  {t('rowRemove', { id: '' }).trim()}
                </button>
              )
              : null}
          </>
        )}
    </li>
  )
}

/** The install dialog: the spec, the enable choice, and pnpm's output. */
function InstallDialog({ install, t, onClose, onEditSpec, onToggleEnable, onRun }: {
  readonly install: InstallState
  readonly t: Translate
  readonly onClose: () => void
  readonly onEditSpec: (text: string) => void
  readonly onToggleEnable: () => void
  readonly onRun: () => void
}): ReactNode {
  const running = install.phase === 'running'
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
          <Button variant="primary" disabled={running || install.spec.trim() === ''} onClick={onRun}>
            {t(running ? 'installRunning' : 'installRun')}
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
            disabled={running}
            onChange={(event) => { onEditSpec(event.currentTarget.value) }}
          />
        </label>
        <label className={css.installOption}>
          <input type="checkbox" checked={install.enable} disabled={running} onChange={onToggleEnable} />
          <span>{t('installEnable')}</span>
        </label>
        {install.phase === 'done'
          ? (
            <p className={css.status} role="status">
              {install.installed.length === 0 ? t('installDoneNothing') : t('installDone', { names: install.installed.join(', ') })}
            </p>
          )
          : null}
        {install.phase === 'done' && install.removed.length > 0
          ? (
            <ul className={css.removedList} aria-label={t('installRemovedLabel')}>
              {install.removed.map(entry => (
                <li key={entry.name} className={css.reason}>{t('installRemoved', { name: entry.name, reason: entry.reason })}</li>
              ))}
            </ul>
          )
          : null}
        {install.phase === 'failed'
          ? <p className={css.reason} role="alert">{install.failure === null ? t('installFailed') : refusalText(install.failure, t)}</p>
          : null}
        {install.log === '' && install.phase === 'idle'
          ? null
          : <pre className={css.log} aria-label={t('installLogLabel')} aria-live="polite">{install.log}</pre>}
      </div>
    </Modal>
  )
}

/** The confirmation a destructive action waits on, listing what it would strand. */
function ConfirmDialog({ confirm, t, presets, presetName, onAcknowledge, onConfirm, onCancel }: {
  readonly confirm: ConfirmState
  readonly t: Translate
  readonly presets: readonly PresetGroup[]
  readonly presetName: (preset: PresetGroup) => string
  readonly onAcknowledge: (acknowledged: boolean) => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): ReactNode {
  const name = shortName(confirm.packageName)
  const targetText = (target: PluginRowTarget): string => {
    if (target.kind === 'global') return t('targetGlobal')
    const preset = presets.find(candidate => candidate.id === target.preset)
    return t('targetPreset', { name: preset === undefined ? target.preset : presetName(preset) })
  }
  const dependents = confirm.dependents
  const lines = dependents === undefined
    ? []
    : [
      ...dependents.services.map(service => t('dependentService', {
        service: service.service, provider: service.providedBy, rows: service.injectedBy.join(', '),
      })),
      ...dependents.references.map(reference => t('dependentReference', {
        row: reference.rowId, target: targetText(reference.target), module: reference.moduleName,
      })),
    ]
  return (
    <Modal
      open
      onClose={onCancel}
      title={t(confirm.action === 'uninstall' ? 'confirmUninstallTitle' : 'confirmDisableTitle', { name })}
      closeLabel={t('close')}
      description={t(confirm.action === 'uninstall' ? 'confirmUninstallDescription' : 'confirmDisableDescription')}
      footer={(
        <>
          <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" disabled={dependents === undefined || !confirm.acknowledged} onClick={onConfirm}>
            {t('confirm')}
          </Button>
        </>
      )}
    >
      {dependents === undefined ? <p className={css.status}>{t('loading')}</p> : null}
      {lines.length > 0
        ? (
          <>
            <p className={css.status}>{t('confirmDependents')}</p>
            <ul className={css.dependents}>{lines.map(line => <li key={line}>{line}</li>)}</ul>
          </>
        )
        : null}
      <label className={css.installOption}>
        <input type="checkbox" checked={confirm.acknowledged} onChange={(event) => { onAcknowledge(event.currentTarget.checked) }} />
        <span>{t('acknowledge')}</span>
      </label>
    </Modal>
  )
}

function noticeText(notice: ManagerNotice, t: Translate): string {
  switch (notice.kind) {
    case 'restart': return t('restartNotice')
    case 'done': return t('doneNotice')
    case 'failed': {
      switch (notice.code) {
        case 'plugins/not-enableable': return t('notEnableable', { reason: notice.reason })
        case 'plugins/enable-failed': return t('enableFailed', { reason: notice.reason })
        case 'plugins/row-conflict': return t('rowConflict', { row: notice.rowId ?? '' })
        case 'plugins/not-installed': return t('notInstalled', { name: notice.packageName ?? '' })
        default: return refusalText(notice, t)
      }
    }
  }
}

/** The copy for a refusal every mutation can meet: the manager is busy, or a session is running. */
function refusalText(failure: { readonly code: string; readonly reason: string }, t: Translate): string {
  switch (failure.code) {
    case 'plugins/busy': return t('busy', { reason: failure.reason })
    case 'plugins/agents-running': return t('agentsRunning', { reason: failure.reason })
    default: return failure.code === 'plugins/install-failed' ? t('installFailed') : t('actionFailed', { reason: failure.reason })
  }
}

/** Render the plugin manager: packages first, then the selected preset's composition. */
export function PluginManagerSettingsTab(props: PluginManagerSettingsTabProps): ReactNode {
  const { t, presetName, ensure } = props
  const state = props.usePluginManager(snapshot => snapshot)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [switcherOpen, setSwitcherOpen] = useState(false)
  useEffect(() => { ensure() }, [ensure])

  const selected = state.presets.find(preset => preset.id === state.selectedPreset) ?? fallbackPreset(state.presets)
  const restartPending = state.packages.filter(pkg => pkg.status === 'restart-required').map(pkg => pkg.title ?? shortName(pkg.name))
  const loaded = state.status === 'ready' || state.status === 'error'

  return (
    <div className={css.section} aria-busy={state.status === 'loading'}>
      <div className={css.toolbar}>
        <Button variant="outline" size="sm" disabled={!loaded} onClick={props.refresh}>{t('refresh')}</Button>
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
            <button type="button" className={css.linkButton} onClick={props.dismissNotice}>{t('dismiss')}</button>
          </p>
        )}
      {loaded
        ? (
          <>
            <section className={css.group} data-plugin-scope="global">
              <div className={css.groupTitleRow}>
                <h3 className={css.groupTitle}>{t('globalTitle')}</h3>
              </div>
              <p className={css.groupSub}>
                {t('globalSubtitle')}
                <span data-plugin-count={state.packages.length}>{` · ${String(state.packages.length)} ${t('countUnit')}`}</span>
              </p>
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
                        presetName={presetName}
                        onToggleOpen={() => { setExpanded(current => current === pkg.name ? null : pkg.name) }}
                        onSetEnabled={(enabled) => { props.setEnabled(pkg.name, enabled) }}
                        onRetry={() => { props.retry(pkg.name) }}
                        onUninstall={() => { props.uninstall(pkg.name) }}
                        onAddRow={(declaredName, target) => { props.addRow(pkg.name, declaredName, target) }}
                      />
                    ))}
                  </ul>
                )}
            </section>
            <section className={css.group} data-plugin-scope="preset" data-preset-id={selected?.id}>
              <div className={css.groupTitleRow}>
                <h3 className={css.groupTitle}>{t('presetTitle')}</h3>
                {selected === undefined
                  ? null
                  : (
                    <Menu
                      open={switcherOpen}
                      onClose={() => { setSwitcherOpen(false) }}
                      items={state.presets.map(preset => ({ id: preset.id, label: presetLabel(preset, t, presetName) }))}
                      selectedId={selected.id}
                      onSelect={(id) => {
                        setSwitcherOpen(false)
                        props.selectPreset(id)
                      }}
                      align="end"
                      portal
                      anchor={(
                        <button
                          type="button"
                          className={css.switcher}
                          aria-haspopup="menu"
                          aria-expanded={switcherOpen}
                          aria-label={t('switcherLabel')}
                          onClick={() => { setSwitcherOpen(value => !value) }}
                        >
                          <span className={css.switcherLabel}>{presetLabel(selected, t, presetName)}</span>
                          <IconChevronDownOutline14 className={css.chevron} aria-hidden="true" />
                        </button>
                      )}
                    />
                  )}
              </div>
              <p className={css.groupSub}>{t('presetSubtitle')}</p>
              {selected === undefined
                ? <p className={css.empty}>{t('presetNoRoster')}</p>
                : selected.broken !== undefined
                  ? <p className={css.reason} role="alert">{selected.broken}</p>
                  : selected.rows.length === 0
                    ? <p className={css.empty}>{t('presetRowsEmpty')}</p>
                    : (
                      <ul className={css.rows}>
                        {selected.rows.map((row, index) => (
                          <PresetRowItem
                            key={`${row.entryId ?? row.moduleName}:${String(index)}`}
                            preset={selected}
                            row={row}
                            t={t}
                            busy={row.entryId !== null && state.busy.includes(rowKey({ kind: 'preset', preset: selected.id }, row.entryId))}
                            onSetDisabled={(rowId, disabled) => { props.setRowDisabled({ kind: 'preset', preset: selected.id }, rowId, disabled) }}
                            onRemove={(rowId) => { props.removeRow({ kind: 'preset', preset: selected.id }, rowId) }}
                          />
                        ))}
                      </ul>
                    )}
            </section>
          </>
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
            presets={state.presets}
            presetName={presetName}
            onAcknowledge={props.acknowledgeConfirm}
            onConfirm={props.confirm}
            onCancel={props.cancelConfirm}
          />
        )}
    </div>
  )
}
