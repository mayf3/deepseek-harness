/** Persistent transcript card and pending-review action use the same plan resource opener. */
import { useEffect } from 'react'
import { FileTypeIcon, IconChevronRightOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { shallowEqual } from '@deepseek-ai/dsh-client-store'
import type {} from './plan-definition.ts'
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
 * Render the completed Turn's submitted plans in invocation order.
 * @param props - Logged plan, localized copy, and Session-bound navigation.
 * @returns keyboard-accessible plan cards, or null for a Turn without plans.
 */
export function PlanCards({ turn, useChat, openPlan, t }: PropsRuntime<'conversation.chat.turnTail'> & InjectFace<PlanOpenInjected> & PropsLocale<'plan'>) {
  const plans = useChat(snapshot => snapshot.nodes.values()
    .filter((node): node is ChatNode<'submitted-plan'> => node.kind === 'submitted-plan'
      && (node.location.kind === 'turn' || node.location.kind === 'step')
      && node.location.turn.turn === turn.turn)
    .sort((a, b) => a.anchorSeq - b.anchorSeq), shallowEqual)
  if (plans.length === 0) return null
  return (
    <div className={css.cards} data-plan-artifacts>
      {plans.map(({ data: plan }) => <button key={plan.callId} type="button" className={css.card} data-plan-card={plan.callId}
        aria-label={t('preview.openNamed', { title: plan.title })}
        onClick={() => { openPlan(plan.callId) }}>
        <span className={css.cardIcon}><FileTypeIcon kind="markdown" size={20} /></span>
        <span className={css.cardDetails}>
          <span className={css.cardTitle}>{plan.title}</span>
          <span className={css.cardDescription}>{t('preview.document')}</span>
        </span>
        <span className={css.cardOpen}>{t('preview.action')}</span>
      </button>)}
    </div>
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
  return <button type="button" className={css.reviewLink} title={t('preview.open')} aria-label={t('preview.open')}
    onClick={() => { openPlan(callId) }}>{t('preview.full')}<IconChevronRightOutline14 size={14} /></button>
}
