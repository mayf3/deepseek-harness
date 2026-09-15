import { memo } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { formatRunDuration } from './message-chrome.ts'
import css from './TurnProcessNodeView.module.css'

/** Turn-level process disclosure controller. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  node, turnProcess, t,
}: ChatNodeViewProps<'turn-process'>) {
  if (turnProcess === undefined) throw new Error('turn-process node requires Turn process owner state')
  if (!turnProcess.foldable) return null
  const open = turnProcess.open
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const label = turn?.start === undefined || turn.end === undefined
    ? t('message.turnProcess.worked')
    : t('message.turnProcess.workedFor', { duration: formatRunDuration(turn.end.time - turn.start.time, t) })
  return (
    <button
      type="button"
      className={css.root}
      data-open={open || undefined}
      data-turn-process={node.data.turn}
      data-turn-process-messages={node.data.messageCount}
      data-turn-process-tool-calls={node.data.toolCallCount}
      data-turn-process-subagents={node.data.subagentCount}
      aria-expanded={open}
      onClick={(event) => {
        event.currentTarget.focus()
        turnProcess.setOpen(!open)
      }}
    >
      <span className={css.label}>{label}</span>
      <IconChevronDownOutlineRegular className={css.chevron} />
    </button>
  )
})
