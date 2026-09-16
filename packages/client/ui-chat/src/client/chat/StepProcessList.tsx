/** Nested process disclosures retain the existing whole-turn visibility owner. */
import { memo, useCallback, useEffect, useId, useState, type ComponentProps } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { turnProcessAlwaysOpen } from '../contract/turn-process.ts'
import { storedTurnProcessEntry } from '../stores.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { processActivity, processRanges, processTitle, type ProcessRange } from './step-process.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './StepProcessList.module.css'
import flowCss from './ChatView.module.css'

type SeatProps = Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey'>
type ListProps = SeatProps & { readonly useChat: ChatViewSlotProps['useChat']; readonly expandedSteps: boolean }

/** Ordered chat seats with configurable process defaults between assistant responses. */
export const ChatNodeList = memo(function ChatNodeList({ useChat, expandedSteps, ...seatProps }: ListProps) {
  const snapshot = useChat(value => value)
  return processRanges(snapshot).map(range => range.process
    ? <StepProcess key={range.key} range={range} expandedSteps={expandedSteps}
      nodes={range.seats.map(seat => snapshot.nodes.get(seat.nodeKey) as ChatNode)} {...seatProps} />
    : <ChatNodeSeat key={range.key} {...seatProps} {...range.seats[0]} />)
})

function StepProcess({ range, nodes, expandedSteps, ...seatProps }: SeatProps & {
  readonly range: ProcessRange
  readonly nodes: readonly ChatNode[]
  readonly expandedSteps: boolean
}) {
  const { useChatNodeProcess, useStore, actions, t } = seatProps
  const [open, setOpen] = useState(expandedSteps)
  useEffect(() => { setOpen(expandedSteps) }, [expandedSteps])
  const bodyId = useId()
  const presentation = useChatNodeProcess(range.seats[0].nodeKey)
  const spec = presentation?.spec
  const stored = useStore(state => spec === undefined ? undefined : storedTurnProcessEntry(state, spec.turn))
  const alwaysOpen = (presentation !== undefined && !presentation.turnClosed)
    || nodes.some(turnProcessAlwaysOpen)
  const outerFoldable = seatProps.compactTranscript
    && (!seatProps.historyIncomplete || presentation?.turnStarted === true)
    && spec !== undefined
  const outerHidden = outerFoldable && !alwaysOpen && stored?.answerStep !== (spec.answerStep ?? 0)
  const revealOuter = useCallback(() => {
    if (spec !== undefined && !alwaysOpen) actions.setTurnProcessOpen(spec.turn, (spec.answerStep ?? 0), true)
  }, [actions, spec, alwaysOpen])
  const rootRef = useSearchableHidden(outerHidden, revealOuter)
  const reveal = useCallback(() => { setOpen(true) }, [])
  const bodyRef = useSearchableHidden(!open, reveal)
  const summary = processActivity(nodes)
  const label = processTitle(summary, range.closed, t)
  return (
    <div ref={rootRef} className={css.root} data-chat-flow-key={range.key}
      data-chat-anchor-key={range.key} data-chat-turn={range.turn} data-step-process>
      <button type="button" className={css.title} aria-expanded={open} aria-controls={bodyId}
        onClick={(event) => { event.currentTarget.focus(); setOpen(!open) }}>
        <span>{label}</span>
        <IconChevronDownOutline14 className={css.chevron} />
      </button>
      <div ref={bodyRef} id={bodyId} className={`${css.body} ${flowCss.processBody}`} data-step-process-body>
        {range.seats.map(seat => <ChatNodeSeat key={`${seat.nodeKey}:${seat.assistantPart ?? ''}`} {...seatProps} {...seat} />)}
      </div>
    </div>
  )
}
