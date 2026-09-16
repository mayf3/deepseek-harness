import { memo, useEffect, useState } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import { turnProcessAlwaysOpen } from '../contract/turn-process.ts'
import { formatRunDuration } from './message-chrome.ts'
import css from './TurnProcessNodeView.module.css'

/** Turn-level process disclosure controller. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  node, turnProcess, t,
}: ChatNodeViewProps<'turn-process'>) {
  if (turnProcess === undefined) throw new Error('turn-process node requires Turn process owner state')
  const open = turnProcess.open
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const [now, setNow] = useState(Date.now)
  const ticking = turnProcess.foldable && turn?.status === 'open'
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [ticking])
  if (!turnProcess.foldable) return null
  const running = turn?.status === 'open'
  const reason = turn?.end?.data.reason.kind
  const duration = turn?.start === undefined ? undefined
    : formatRunDuration(Math.max(running ? 1000 : 0, (turn.end?.time ?? now) - turn.start.time), t)
  // Other end reasons retain elapsed time; only cancellation and failure replace it.
  const label = reason === 'aborted' ? t('message.stopped')
    : reason === 'error' ? t('message.turnProcess.failed')
      : duration === undefined ? t('message.turnProcess.worked')
        : t(running ? 'message.turnProcess.workedFor' : 'message.turnProcess.took', { duration })
  return (
    <button
      type="button"
      className={css.root}
      data-open={open || undefined}
      data-turn-process={node.data.turn}
      data-turn-process-messages={node.data.messageCount}
      data-turn-process-tool-calls={node.data.toolCallCount}
      data-turn-process-subagents={node.data.subagentCount}
      disabled={turnProcessAlwaysOpen(node)}
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
