/** Nested process disclosures retain the existing whole-turn visibility owner. */
import {
  memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode,
} from 'react'
import {
  IconAgentPresetOutlineRegular, IconApiOutlineRegular, IconBrowseOutlineRegular, IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
  IconCodeOutlineRegular, IconEditOutlineRegular, IconGlobeOutlineRegular, IconPlanOutlineRegular,
  IconQuestionOutlineRegular, IconSearchOutlineRegular, IconSparkleRegular, IconThinkOutlineRegular, TextShimmer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ProcessActivity, ProcessActivitySummary, ProcessRange } from '../contract/step-process.ts'
import { turnProcessAlwaysOpen } from '../contract/turn-process.ts'
import { storedTurnProcessEntry } from '../stores.ts'
import { ChatNodeSeat } from './ChatNodeSeat.tsx'
import { processTitle } from './step-process.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './StepProcessList.module.css'
import flowCss from './ChatView.module.css'

type SeatProps = Omit<ComponentProps<typeof ChatNodeSeat>, 'nodeKey'>
type ListProps = SeatProps & { readonly useChat: ChatViewSlotProps['useChat']; readonly expandedSteps: boolean }

interface ProcessScrollEdges {
  readonly canScrollUp: boolean
  readonly canScrollDown: boolean
}

const PROCESS_SCROLL_AT_REST: ProcessScrollEdges = { canScrollUp: false, canScrollDown: false }
const PROCESS_TITLE_MINIMUM_MS = 150

type ProcessTitleActivity = ProcessActivity | 'thinking'

interface LiveProcessTitle {
  readonly activity: ProcessTitleActivity
  readonly detail: string
}

const PROCESS_ICONS: Record<ProcessTitleActivity, ReactNode> = {
  thinking: <IconThinkOutlineRegular />,
  read: <IconBrowseOutlineRegular size={14} />,
  search: <IconSearchOutlineRegular size={14} />,
  edit: <IconEditOutlineRegular size={14} />,
  commands: <IconApiOutlineRegular />,
  code: <IconCodeOutlineRegular size={14} />,
  webSearch: <IconGlobeOutlineRegular />,
  webFetch: <IconBrowseOutlineRegular size={14} />,
  subagents: <IconAgentPresetOutlineRegular size={14} />,
  plan: <IconPlanOutlineRegular />,
  questions: <IconQuestionOutlineRegular />,
  tools: <IconSparkleRegular size={14} />,
}

function processScrollEdges(element: HTMLElement): ProcessScrollEdges {
  return {
    canScrollUp: element.scrollTop > 1,
    canScrollDown: element.scrollTop < element.scrollHeight - element.clientHeight - 1,
  }
}

function sameProcessScrollEdges(left: ProcessScrollEdges, right: ProcessScrollEdges): boolean {
  return left.canScrollUp === right.canScrollUp && left.canScrollDown === right.canScrollDown
}

function sameLiveProcessTitle(left: LiveProcessTitle, right: LiveProcessTitle): boolean {
  return left.activity === right.activity && left.detail === right.detail
}

function useStableLiveProcessTitle(desired: LiveProcessTitle, active: boolean): LiveProcessTitle {
  const [displayed, setDisplayed] = useState(desired)
  const displayedRef = useRef(displayed)
  const desiredRef = useRef(desired)
  const displayedAtRef = useRef(Date.now())
  useEffect(() => {
    desiredRef.current = desired
    if (!active || sameLiveProcessTitle(displayedRef.current, desired)) return
    const remaining = PROCESS_TITLE_MINIMUM_MS - (Date.now() - displayedAtRef.current)
    const commit = (): void => {
      const next = desiredRef.current
      displayedRef.current = next
      displayedAtRef.current = Date.now()
      setDisplayed(next)
    }
    if (remaining <= 0) {
      commit()
      return
    }
    const timer = setTimeout(commit, remaining)
    return () => { clearTimeout(timer) }
  }, [active, desired.activity, desired.detail])
  return active ? displayed : desired
}

/** Ordered chat seats with configurable process defaults between assistant responses. */
export const ChatNodeList = memo(function ChatNodeList({ useChat, expandedSteps, ...seatProps }: ListProps) {
  const layout = useChat(snapshot => snapshot.stepProcesses.layout)
  return layout.flatMap(range => expandedSteps && range.process
    ? range.seats.map(seat => <ChatNodeSeat key={`${seat.nodeKey}:${seat.assistantPart ?? ''}`} {...seatProps} {...seat} />)
    : range.process
      ? <StepProcessSeat key={range.key} groupKey={range.key} useChat={useChat} {...seatProps} />
      : <ChatNodeSeat key={range.key} {...seatProps} {...range.seats[0]} />)
})

const StepProcessSeat = memo(function StepProcessSeat({ groupKey, useChat, ...seatProps }: SeatProps & {
  readonly groupKey: string
  readonly useChat: ChatViewSlotProps['useChat']
}) {
  const group = useChat(snapshot => snapshot.stepProcesses.get(groupKey))
  return group === undefined ? null : <StepProcess {...group} {...seatProps} />
})

function StepProcess({ range, nodes, summary, ...seatProps }: SeatProps & {
  readonly range: ProcessRange
  readonly nodes: readonly ChatNode[]
  readonly summary: ProcessActivitySummary
}) {
  const { useChatNodeProcess, useStore, actions, t } = seatProps
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const presentation = useChatNodeProcess(range.seats[0].nodeKey)
  const spec = presentation?.spec
  const stored = useStore(state => spec === undefined ? undefined : storedTurnProcessEntry(state, spec.turn))
  const alwaysOpen = (presentation !== undefined && !presentation.turnClosed)
    || nodes.some(turnProcessAlwaysOpen)
  const outerFoldable = (!seatProps.historyIncomplete || presentation?.turnStarted === true)
    && spec !== undefined
  const outerHidden = outerFoldable && !alwaysOpen && stored?.answerStep !== (spec.answerStep ?? 0)
  const revealOuter = useCallback(() => {
    if (spec !== undefined && !alwaysOpen) actions.setTurnProcessOpen(spec.turn, (spec.answerStep ?? 0), true)
  }, [actions, spec, alwaysOpen])
  const rootRef = useSearchableHidden(outerHidden, revealOuter)
  useEffect(() => {
    if (outerHidden && rootRef.current?.hasAttribute('hidden')) setOpen(false)
  }, [outerHidden, rootRef])
  const reveal = useCallback(() => { setOpen(true) }, [])
  const bodyRef = useSearchableHidden(!open, reveal)
  const [scrollEdges, setScrollEdges] = useState<ProcessScrollEdges>(PROCESS_SCROLL_AT_REST)
  const syncScrollEdges = useCallback(() => {
    const body = bodyRef.current
    if (body === null || !open) {
      setScrollEdges(current => sameProcessScrollEdges(current, PROCESS_SCROLL_AT_REST)
        ? current
        : PROCESS_SCROLL_AT_REST)
      return
    }
    const next = processScrollEdges(body)
    setScrollEdges(current => sameProcessScrollEdges(current, next) ? current : next)
  }, [bodyRef, open])
  useLayoutEffect(() => {
    syncScrollEdges()
    const body = bodyRef.current
    if (body === null || !open || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(syncScrollEdges)
    observer.observe(body)
    for (const child of body.children) observer.observe(child)
    return () => { observer.disconnect() }
  }, [bodyRef, nodes.length, open, syncScrollEdges])
  const desiredLiveTitle: LiveProcessTitle = {
    activity: summary.running ?? 'thinking',
    detail: summary.runningDetail,
  }
  const liveTitle = useStableLiveProcessTitle(desiredLiveTitle, !range.closed)
  const label = range.closed
    ? processTitle(summary, true, t)
    : t(`message.stepProcess.${liveTitle.activity}`)
  const detail = !seatProps.compactTranscript && !range.closed
    ? liveTitle.detail
    : ''
  const title = detail === '' ? label : `${label}${t('message.turnProcess.separator')}${detail}`
  const activity = range.closed ? summary.counts[0]?.kind ?? 'thinking' : liveTitle.activity
  const bodyClasses = [css.body, flowCss.processBody]
  if (scrollEdges.canScrollUp) bodyClasses.push(css.fadeTop)
  if (scrollEdges.canScrollDown) bodyClasses.push(css.fadeBottom)
  return (
    <div ref={rootRef} className={css.root} data-chat-flow-key={range.key}
      data-chat-anchor-key={range.key} data-chat-turn={range.turn} data-step-process>
      <button type="button" className={css.title} aria-expanded={open} aria-controls={bodyId}
        data-process-activity={activity}
        onClick={(event) => { event.currentTarget.focus(); setOpen(!open) }}>
        <span className={css.leading} aria-hidden="true">
          <span className={css.activityIcon} data-step-process-icon>{PROCESS_ICONS[activity]}</span>
          <span className={css.chevron} data-step-process-chevron>
            {open ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
          </span>
        </span>
        {range.closed
          ? <span className={css.label}>{title}</span>
          : <TextShimmer className={css.label}>{title}</TextShimmer>}
      </button>
      <div ref={bodyRef} id={bodyId} className={bodyClasses.join(' ')} data-step-process-body
        data-scroll-up={scrollEdges.canScrollUp || undefined}
        data-scroll-down={scrollEdges.canScrollDown || undefined}
        onScroll={syncScrollEdges}>
        {range.seats.map(seat => <ChatNodeSeat key={`${seat.nodeKey}:${seat.assistantPart ?? ''}`} {...seatProps} {...seat} />)}
      </div>
    </div>
  )
}
