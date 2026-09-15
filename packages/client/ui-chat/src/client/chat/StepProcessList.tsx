/** Nested process disclosures retain the existing whole-turn visibility owner. */
import { memo, useCallback, useId, useState, type ComponentProps } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { storedTurnProcessEntry } from '../stores.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { processActivity, processRanges, processTitle, type ProcessRange } from './step-process.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './StepProcessList.module.css'
import flowCss from './ChatView.module.css'

type SeatProps = Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey'>
type ListProps = SeatProps & { readonly useChat: ChatViewSlotProps['useChat'] }

/** Ordered chat seats with default-collapsed work between assistant responses. */
export const ChatNodeList = memo(function ChatNodeList({ useChat, ...seatProps }: ListProps) {
  const snapshot = useChat(value => value)
  return processRanges(snapshot).map(range => range.process
    ? <StepProcess key={range.key} range={range}
      nodes={range.seats.map(seat => snapshot.nodes.get(seat.nodeKey) as ChatNode)} {...seatProps} />
    : <ChatNodeSeat key={range.key} {...seatProps} {...range.seats[0]} />)
})

function StepProcess({ range, nodes, ...seatProps }: SeatProps & { readonly range: ProcessRange; readonly nodes: readonly ChatNode[] }) {
  const { useChatNodeProcess, useStore, actions, t } = seatProps
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const presentation = useChatNodeProcess(range.seats[0].nodeKey)
  const spec = presentation?.spec
  const stored = useStore(state => spec === undefined ? undefined : storedTurnProcessEntry(state, spec.turn))
  const outerFoldable = seatProps.compactTranscript
    && (!seatProps.historyIncomplete || presentation?.turnStarted === true)
    && presentation?.turnClosed === true && spec?.answerStep !== null && spec?.answerAnchorSeq !== null
  const outerHidden = outerFoldable && stored?.answerStep !== spec?.answerStep
  const revealOuter = useCallback(() => {
    if (spec !== undefined && spec.answerStep !== null) actions.setTurnProcessOpen(spec.turn, spec.answerStep, true)
  }, [actions, spec])
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
