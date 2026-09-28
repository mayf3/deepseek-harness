/** Navigation from the enabled Schedule bundle to its live task page. */
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ScheduleCatalogEntry } from '@deepseek-ai/dsh-schedule/client'
import type { CatalogInjected, CatalogSnapshot } from './catalog-source.ts'
import css from './SchedulePluginUsage.module.css'

/** Shared catalog readiness and navigation supplied by the Schedule plugin. */
export interface SchedulePluginUsageInjected extends Pick<CatalogInjected<ScheduleCatalogEntry>, 'hooks' | 'onRetry'> {
  /** Open the global task page without selecting or creating a Session. */
  readonly onOpenAutomation: () => void
}

/** Shares for the bundle detail's usage card. */
export type SchedulePluginUsageProps = PropsRuntime<'plugins.bundle.usage'>
  & PropsLocale<'schedule.manager'> & InjectFace<SchedulePluginUsageInjected>

/** Shares for the guidance shown after explicit bundle enablement. */
export type SchedulePluginActivationProps = PropsRuntime<'plugins.bundle.activation'>
  & PropsLocale<'schedule.manager'> & InjectFace<SchedulePluginUsageInjected>

type Status = CatalogSnapshot['status']
type CopyProps = PropsLocale<'schedule.manager'> & { readonly status: Status }

function statusKey(status: Status) {
  return status === 'ready' ? 'plugin.ready' : status === 'loading' ? 'plugin.checking' : 'plugin.unavailable'
}

function UsageSummary({ status, t }: CopyProps) {
  return <div className={css.summary}>
    <div className={css.status} role="status">
      <StateDot state={status === 'ready' ? 'done' : status === 'loading' ? 'ongoing' : 'error'} />
      <span>{t(statusKey(status))}</span>
    </div>
    <p className={css.description}>{t('plugin.capability')}</p>
    <div className={css.location}>
      <span>{t('plugin.locationLabel')}</span>
      <span>{t('plugin.location')}</span>
    </div>
  </div>
}

/**
 * Show an enabled bundle's destination once the Host catalog answers.
 * @param props - bundle enablement, catalog hook, navigation and localized copy.
 * @returns a usage card, or nothing for a disabled bundle.
 */
export function SchedulePluginUsage({ pkg, useCatalog, onOpenAutomation, onRetry, t }: SchedulePluginUsageProps) {
  const status = useCatalog(snapshot => snapshot.status)
  if (!pkg.enabled) return null
  return <section className={css.card} aria-label={t('plugin.usageLabel')} data-schedule-plugin-usage>
    <UsageSummary status={status} t={t} />
    <div className={css.actions}>
      {status === 'error' ? <Button variant="outline" size="sm" onClick={() => { void onRetry() }}>{t('list.retry')}</Button> : null}
      <Button variant="primary" size="sm" disabled={status !== 'ready'} onClick={onOpenAutomation}>{t('plugin.open')}</Button>
    </div>
  </section>
}

/**
 * Guide an explicit activation to the same task page after the Host answers.
 * @param props - catalog hook, dismiss and navigation callbacks, and localized copy.
 * @returns dismissible guidance without creating a task or starting a model turn.
 */
export function SchedulePluginActivation({ useCatalog, onOpenAutomation, onRetry, onDismiss, t }: SchedulePluginActivationProps) {
  const status = useCatalog(snapshot => snapshot.status)
  return <Modal open title={t('plugin.usageLabel')} closeLabel={t('plugin.close')} onClose={onDismiss}
    footer={<>
      <Button variant="ghost" onClick={onDismiss}>{t('plugin.close')}</Button>
      {status === 'error' ? <Button variant="outline" onClick={() => { void onRetry() }}>{t('list.retry')}</Button> : null}
      <Button variant="primary" disabled={status !== 'ready'} data-modal-autofocus onClick={() => { onDismiss(); onOpenAutomation() }}>{t('plugin.open')}</Button>
    </>}>
    <UsageSummary status={status} t={t} />
  </Modal>
}
