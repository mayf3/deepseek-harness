/** Read-only Markdown viewer for an exact plan resource. */
import { useMemo } from 'react'
import { IconCopyOutline16, MarkdownText, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './plan-resource.ts'
import css from './PlanPreview.module.css'

type PlanPreviewProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'plan'>

/**
 * Render the submitted plan with its complete Markdown and a copy action.
 * @param props - Framework-bound tab identity, resource, and copy.
 * @returns the plan document or a localized loading/failure state.
 */
export function PlanPreview({ useTabInfo, useResource, t }: PlanPreviewProps) {
  const tab = useTabInfo()
  const resource = useResource<'plan'>(tab.tab.navigation.address)
  const labels = useMemo(() => ({
    code: {
      copyLabel: t('copy'), copiedLabel: t('copied'), sourceLabel: t('markdown.code.source'),
      lineNumbersLabel: t('markdown.code.lineNumbers'),
    },
    footnotes: t('markdown.footnotes'),
  }), [t])
  const plan = resource.value
  if (plan === undefined) return (
    <div className={css.message} role="status">
      {resource.status === 'failed' ? t('preview.failed') : t('preview.loading')}
      {resource.failure !== undefined && <p>{resource.failure.message}</p>}
    </div>
  )
  return (
    <section className={css.preview} data-plan-preview={plan.callId} aria-label={plan.title}>
      <div className={css.toolbar}><button type="button" className={css.iconButton} aria-label={t('copy')}
        onClick={() => { void writeClipboard(plan.markdown) }}><IconCopyOutline16 /></button></div>
      <div className={css.document}><MarkdownText text={plan.markdown} labels={labels} /></div>
    </section>
  )
}

/**
 * Display the plan heading in its tab after resource recovery.
 * @param props - Framework-bound tab identity and resource reader.
 * @returns the recovered plan title or the tab's initial localized label.
 */
export function PlanTitle({ useTabInfo, useResource }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  const tab = useTabInfo()
  const resource = useResource<'plan'>(tab.tab.navigation.address)
  return <span>{resource.value?.title ?? tab.tab.title}</span>
}
