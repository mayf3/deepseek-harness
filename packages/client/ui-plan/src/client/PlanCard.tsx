/** Persistent transcript card and pending-review action use the same plan resource opener. */
import { useEffect } from 'react'
import { FileTypeIcon, IconFullscreenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-client-ui-user-questions/client'
import type { createPlanReviewStore } from './review-store.ts'
import css from './PlanPreview.module.css'

/** Session-bound navigation injected into both plan entry points. */
export interface PlanOpenInjected {
  /** Open or focus the exact submitted plan. */
  openPlan: (callId: ToolCallId) => void
}

/**
 * Render the plan's permanent transcript entry.
 * @param props - Logged plan, localized copy, and Session-bound navigation.
 * @returns a keyboard-accessible plan card.
 */
export function PlanCard({ node, openPlan, t }: PropsRuntime<'conversation.chat.node', 'submitted-plan'> & InjectFace<PlanOpenInjected> & PropsLocale<'plan'>) {
  return (
    <button type="button" className={css.card} data-plan-card={node.data.callId}
      aria-label={t('preview.openNamed', { title: node.data.title })}
      onClick={() => { openPlan(node.data.callId) }}>
      <span className={css.cardIcon}><FileTypeIcon kind="markdown" size={20} /></span>
      <span className={css.cardDetails}>
        <span className={css.cardTitle}>{node.data.title}</span>
        <span className={css.cardDescription}>{t('preview.document')}</span>
      </span>
      <span className={css.cardOpen}>{t('preview.action')}</span>
    </button>
  )
}

/**
 * Open each pending plan automatically and retain a manual opener without answering it.
 * @param props - Review identity, Session store, localized copy, and navigation.
 * @returns an opener when the asker supplied a logged invocation identity.
 */
export function PlanReviewOpen({ review, openPlan, t, useStore, actions }: PropsRuntime<'conversation.plan-review.actions'> & InjectFace<PlanOpenInjected> & PropsLocale<'plan'> & PropsStore<ReturnType<typeof createPlanReviewStore>>) {
  const callId = review.callId
  const opened = useStore(state => callId !== undefined && state.opened[callId] === true)
  useEffect(() => {
    if (callId === undefined || opened) return
    actions.markOpened(callId)
    openPlan(callId)
  }, [callId, opened, openPlan, actions])
  if (callId === undefined) return null
  return <button type="button" className={css.reviewOpen} title={t('preview.open')} aria-label={t('preview.open')}
    onClick={() => { openPlan(callId) }}><IconFullscreenOutline16 size={16} /></button>
}
