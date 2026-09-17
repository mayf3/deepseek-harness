/** Persistent transcript card and pending-review action use the same plan resource opener. */
import { IconFullscreenOutline16, IconPlanOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-client-ui-user-questions/client'
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
      <IconPlanOutline14 size={18} />
      <span className={css.cardTitle}>{node.data.title}</span>
      <IconFullscreenOutline16 size={16} />
    </button>
  )
}

/**
 * Add a sidebar opener to the pending review without changing its answer.
 * @param props - Review identity, localized copy, and navigation.
 * @returns an opener when the asker supplied a logged invocation identity.
 */
export function PlanReviewOpen({ review, openPlan, t }: PropsRuntime<'conversation.plan-review.actions'> & InjectFace<PlanOpenInjected> & PropsLocale<'plan'>) {
  const callId = review.callId
  if (callId === undefined) return null
  return <button type="button" className={css.reviewOpen} title={t('preview.open')} aria-label={t('preview.open')}
    onClick={() => { openPlan(callId) }}><IconFullscreenOutline16 size={16} /></button>
}
