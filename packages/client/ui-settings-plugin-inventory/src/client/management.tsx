/** Minimal profile package controls over the shared manager Remote. */
import { useEffect, useRef, useState } from 'react'
import type { BundleInfo, ChangeResult, PluginEntryId, PluginInfo } from '@deepseek-ai/dsh-api-remotes/client'
import type { PluginInventorySettingsTabProps } from './PluginInventorySettingsTab.tsx'
import css from './PluginInventorySettingsTab.module.css'

/** Operations consumed by the inventory page; all mutations execute on the Host. */
export interface PluginManagement {
  listPlugins(): Promise<PluginInfo[]>
  listBundles(): Promise<BundleInfo[]>
  setPluginEnabled(id: PluginEntryId, enabled: boolean): Promise<ChangeResult>
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeResult>
  installBundle(spec: string, options: { enabled: boolean }): Promise<ChangeResult>
  removeBundle(name: string): Promise<ChangeResult>
}

/** Load management state only when the Host inventory advertises the service.
 * @param manager Optional Remote operations.
 * @param available Current Host availability.
 * @param revision Inventory refresh revision.
 * @returns Current state and a serialized mutation action.
 */
export function usePluginManagement(manager: PluginManagement | undefined, available: boolean, revision: number) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [bundles, setBundles] = useState<BundleInfo[]>([])
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  const [result, setResult] = useState<ChangeResult>()
  const [error, setError] = useState<string>()
  const [readError, setReadError] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (!available || manager === undefined) return
    let current = true
    void Promise.all([manager.listPlugins(), manager.listBundles()]).then(([plugins, bundles]) => {
      if (!current) return
      setPlugins(plugins)
      setBundles(bundles)
      setReadError(undefined)
    }, (error: unknown) => { if (current) setReadError(error instanceof Error ? error.message : String(error)) })
    return () => { current = false }
  }, [manager, available, revision, refresh])
  const run = async (operation: () => Promise<ChangeResult>): Promise<void> => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError(undefined)
    setResult(undefined)
    try { setResult(await operation()) }
    catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { submitting.current = false; setBusy(false); setRefresh(value => value + 1) }
  }
  return { plugins, bundles, busy, result, error: error ?? readError, run, refresh }
}

/** Minimal bundle installation and enablement form. */
export function BundleManager({ manager, state, t }: {
  manager: PluginManagement
  state: ReturnType<typeof usePluginManagement>
  t: PluginInventorySettingsTabProps['t']
}) {
  const [spec, setSpec] = useState('')
  const [enabled, setEnabled] = useState(true)
  return <section className={css.manager} aria-label={t('bundles')} aria-busy={state.busy}>
    <h3>{t('bundles')}</h3>
    <form className={css.install} onSubmit={(event) => {
      event.preventDefault()
      void state.run(() => manager.installBundle(spec, { enabled }))
    }}>
      <input aria-label={t('packageSpec')} placeholder={t('packageSpec')} value={spec}
        disabled={state.busy} onChange={(event) => { setSpec(event.target.value) }} />
      <button type="submit" disabled={state.busy || spec.trim() === ''}>{t('install')}</button>
      <label><input type="checkbox" checked={enabled} disabled={state.busy}
        onChange={(event) => { setEnabled(event.target.checked) }} />{t('enableAfterInstall')}</label>
    </form>
    {state.busy ? <p role="status">{t('applying')}</p> : null}
    {state.error === undefined ? null : <p role="alert">{state.error}</p>}
    {state.result === undefined ? null : <p role={state.result.application === 'failed' ? 'alert' : 'status'}>
      {t(state.result.application === 'failed' ? 'operationFailed' : state.result.application)} {state.result.target}
      {state.result.error === undefined ? null : <span> {t(`${state.result.stage}Failed`)}: {t(state.result.error.code)} {state.result.error.diagnostic}</span>}
      {state.result.packageResult === undefined ? null : <code>{state.result.packageResult.logPath}</code>}
      {state.result.cleanup === undefined ? null : <span> {t('cleanup')}: {state.result.cleanup.name} — {t(state.result.cleanup.error === undefined ? 'applied' : 'operationFailed')}
        {state.result.cleanup.error?.diagnostic}
        {state.result.cleanup.packageResult === undefined ? null : <code>{state.result.cleanup.packageResult.logPath}</code>}
      </span>}
      {state.result.remainingDependencies?.length ? <span> {t('remainingDependencies')}: {state.result.remainingDependencies.join(', ')}</span> : null}
      {state.result.warnings?.length ? <span> {t('existingFailures')}: {state.result.warnings.join('\n')}</span> : null}
    </p>}
    <ul className={css.bundleList}>{state.bundles.map(bundle => <li key={bundle.name}>
      <span><strong>{bundle.name}</strong> {bundle.version}</span>
      <label><input type="checkbox" role="switch" aria-label={t('bundleSwitch', { name: bundle.name })}
        checked={bundle.enabled} disabled={state.busy || bundle.error !== undefined || bundle.readOnlyReason !== undefined}
        onChange={(event) => { void state.run(() => manager.setBundleEnabled(bundle.name, event.target.checked)) }} />
      {t(bundle.enabled ? 'enabledTag' : 'disabledTag')}</label>
      <button type="button" disabled={state.busy || !bundle.removable}
        onClick={() => { void state.run(() => manager.removeBundle(bundle.name)) }}>{t('remove')}</button>
      {bundle.error === undefined ? null : <p role="alert">{t(bundle.error.code)} {bundle.error.diagnostic}</p>}
      {bundle.readOnlyReason === undefined ? null : <p>{t(bundle.readOnlyReason)}</p>}
    </li>)}</ul>
  </section>
}
