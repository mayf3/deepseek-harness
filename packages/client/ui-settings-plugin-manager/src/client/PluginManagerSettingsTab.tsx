/**
 * The Manage plugins tab: the profile's installed packages as cards — a
 * plugin pack with its switch, a plugin with its **Add to…** menu, a built-in
 * pack with a locked switch — each a name, a one-liner, and a tag only when
 * a restart is pending or something is wrong; the selected agent preset's
 * composition as the same cards with one switch each; the install dialog
 * streaming pnpm's output behind a fold; and the confirmation a destructive
 * action waits on, naming what still uses the package. Entry ids, module
 * names, kinds, and probe facts stay off the page; an expanded card shows
 * the version, the source, a pack's components, and its uninstall.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { PluginInstallRejection, PluginPackageView, PluginRowTarget } from '@deepseek-ai/dsh-api-remotes/client'
import {
  Button, IconChevronDownOutline14, IconRefreshOutline16, Menu, Modal, type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { zh, type PluginManagerLocaleKey } from './locales.ts'
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

/** The scope every harness module is published under. */
const FIRST_PARTY_SCOPE = '@deepseek-ai/'

/** Compact a package name to what a person calls it. */
function shortName(name: string): string {
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return unscoped.replace(/^dsh-(?:host-|client-)?/, '')
}

/** The dictionary key for one slug, when the dictionary carries it. */
function copyKey(kind: 'name' | 'desc', slug: string): PluginManagerLocaleKey | undefined {
  const key = `${kind}.${slug}`
  return key in zh ? key as PluginManagerLocaleKey : undefined
}

/**
 * Display copy of one harness module: by the composition row id first (four
 * subagent rows share one module), then by the unscoped module name without
 * its `dsh-` prefix. Every `name.<slug>` key has its `desc.<slug>` partner.
 * Undefined for a module outside the harness scope or one the dictionary
 * does not name.
 */
function harnessCopy(t: Translate, moduleName: string, rowId: string | null): { title: string; description: string } | undefined {
  if (!moduleName.startsWith(FIRST_PARTY_SCOPE)) return undefined
  const slugs = [...rowId === null ? [] : [rowId], moduleName.slice(FIRST_PARTY_SCOPE.length).replace(/^dsh-/, '')]
  for (const slug of slugs) {
    const name = copyKey('name', slug)
    if (name === undefined) continue
    return { title: t(name), description: t(`desc.${slug}` as PluginManagerLocaleKey) }
  }
  return undefined
}

/** The installed package a module belongs to: the package itself or one of its subpaths. */
function packageOf(moduleName: string, packages: readonly PluginPackageView[]): PluginPackageView | undefined {
  return packages.find(pkg => moduleName === pkg.name || moduleName.startsWith(`${pkg.name}/`))
}

/** The row id a tree entry id ends in: what a user layer addresses. */
function rowIdOf(entryId: string | null): string | null {
  return entryId === null ? null : entryId.slice(entryId.lastIndexOf(':') + 1)
}

/** What a person calls one tree entry: its harness name, else its row id. */
function rowLabel(t: Translate, entryId: string): string {
  const id = rowIdOf(entryId) as string
  const key = copyKey('name', id)
  return key === undefined ? id : t(key)
}

/** What one preset row shows: a title, a one-liner, and whether the person installed it. */
function presetRowCopy(
  row: PresetRow, packages: readonly PluginPackageView[], t: Translate,
): { title: string; description?: string; local: boolean } {
  const pkg = packageOf(row.moduleName, packages)
  if (pkg !== undefined) {
    const addable = pkg.addable.find(entry => entry.moduleName === row.moduleName)
    return {
      title: addable?.title ?? pkg.title ?? shortName(pkg.name),
      ...pkg.description === undefined ? {} : { description: pkg.description },
      local: pkg.trust === 'external',
    }
  }
  const harness = harnessCopy(t, row.moduleName, rowIdOf(row.entryId))
  if (harness !== undefined) return { ...harness, local: false }
  return { title: shortName(row.moduleName), description: row.moduleName, local: !row.moduleName.startsWith(FIRST_PARTY_SCOPE) }
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

/** A text action: grey in a card head, red for a destructive one. */
function TextButton({ label, disabled, danger, onClick, children }: {
  readonly label: string
  readonly disabled: boolean
  readonly danger?: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}): ReactNode {
  return (
    <button
      type="button"
      className={css.textButton}
      data-danger={danger === true ? 'true' : undefined}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
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
  pkg, t, busy, open, presets, globalModules, presetName, onToggleOpen, onSetEnabled, onRetry, onUninstall, onAddRow,
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
            {builtin ? <Tag kind="builtin">{t('builtinTag')}</Tag> : null}
            {status === null ? null : <Tag kind={status}>{t(STATUS_KEYS[status])}</Tag>}
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
                  <button
                    type="button"
                    className={css.addButton}
                    aria-haspopup="menu"
                    aria-expanded={addMenu}
                    disabled={busy}
                    onClick={() => { setAddMenu(current => !current) }}
                  >
                    {t('addTo')}
                  </button>
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
                <>
                  <p className={css.subLabel}>{t('partsLabel')}</p>
                  {pkg.rows.length === 0
                    ? <p className={css.status}>{t('partsEmpty')}</p>
                    : (
                      <ul className={css.parts}>
                        {pkg.rows.map(row => (
                          <li key={row.entryId} className={css.part} data-plugin-row={row.entryId}>
                            {row.enabled && row.phase !== null ? <PhaseDot phase={row.phase} t={t} /> : null}
                            <span className={css.partName}>{row.rowId}</span>
                            {row.enabled
                              ? null
                              : <Tag kind="off">{t(row.disabledBy === 'user' ? 'partDisabledByUser' : 'partDisabledByComposition')}</Tag>}
                            {row.failure === undefined ? null : <p className={css.partFailure}>{row.failure.message}</p>}
                          </li>
                        ))}
                      </ul>
                    )}
                </>
              )
              : null}
            {retryable || removable
              ? (
                <div className={css.actions}>
                  {retryable
                    ? <TextButton label={t('retryPackage')} disabled={busy} onClick={onRetry}>{t('retryPackage')}</TextButton>
                    : null}
                  {removable
                    ? <TextButton label={t('uninstallLabel', { name: title })} disabled={busy} danger onClick={onUninstall}>{t('uninstall')}</TextButton>
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

/** One row of the selected preset's composition, as a card with its switch. */
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
            {copy.local ? <Tag kind="local">{t('localTag')}</Tag> : null}
            {row.fiberPhase === 'failed' ? <Tag kind="problem">{t('rowStateFailed')}</Tag> : null}
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
                    <TextButton label={t('rowRemoveLabel', { name: copy.title })} disabled={busy} danger onClick={() => { onRemove(id) }}>
                      {t('rowRemove')}
                    </TextButton>
                  )
                  : null}
                <Switch
                  checked={row.enabled !== false}
                  label={t('rowToggle', { name: copy.title })}
                  disabled={busy || preset.broken !== undefined || lockedOff}
                  {...lockedOff ? { title: t('rowLockedByComposition') } : {}}
                  onChange={(checked) => { onSetDisabled(id, !checked) }}
                />
              </>
            )}
        </div>
      </div>
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

/** Render the plugin manager: installed packages first, then the selected preset's composition. */
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
            <button type="button" className={css.linkButton} onClick={props.dismissNotice}>{t('dismiss')}</button>
          </p>
        )}
      {loaded
        ? (
          <>
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
                      <ul className={css.cards}>
                        {selected.rows.map((row, index) => (
                          <PresetCard
                            key={`${row.entryId ?? row.moduleName}:${String(index)}`}
                            preset={selected}
                            row={row}
                            packages={state.packages}
                            t={t}
                            busy={row.entryId !== null && state.busy.includes(rowKey({ kind: 'preset', preset: selected.id }, rowIdOf(row.entryId) as string))}
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
