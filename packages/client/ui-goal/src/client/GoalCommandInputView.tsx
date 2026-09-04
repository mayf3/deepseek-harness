import { memo } from 'react'
import { projectUserText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { GOAL_COMMAND, type GoalCommandInputData } from './goal-command-input.ts'
import css from './GoalCommandInputView.module.css'

type GoalCommandInputViewProps =
  PropsRuntime<'conversation.chat.node', 'command-input'>
  & PropsLocale<'goal'>

/**
 * Right-aligned `/goal` input bubble without ordinary message actions. The
 * echoed line decorates its leading `/goal` token as a command chip — the run
 * this Node projects is the fact that the token was a command — and keeps
 * the objective as plain text.
 */
export const GoalCommandInputView = memo(function GoalCommandInputView({
  node, t,
}: GoalCommandInputViewProps) {
  const data: GoalCommandInputData = node.data
  return (
    <div
      className={css.row}
      data-command-input=""
      role="group"
      aria-label={t('commandInput.aria')}
    >
      <div className={css.stack}>
        <div className={css.bubble}>
          {projectUserText(data.text, [], [GOAL_COMMAND], 'command')}
        </div>
      </div>
    </div>
  )
})
