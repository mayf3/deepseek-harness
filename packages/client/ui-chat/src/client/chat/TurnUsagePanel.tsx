// Icon-row Turn-stat actions: a database pill labelled with the turn total
// click-opens the per-Turn usage dialog, and a clock pill labelled with the
// turn wall time click-opens the Turn-time dialog. Both sit right of the
// branch action in the tail's IconActions row, ahead of the plain clock text.
// TEMPORARY: the `flat` variant (usage-variant debug switch) renders the
// whole meta line as one trigger whose dialog stacks both sections; one of
// the two variants will be deleted after user testing.

import { Fragment, useEffect, useRef, useState, type CSSProperties, type MutableRefObject } from 'react'
import { createPortal } from 'react-dom'
import {
  IconClockOutline16, IconDatabaseOutline16, useAnchoredPosition,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TurnTokenUsage } from '../contract/chat-nodes.ts'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import {
  formatLatencySeconds, formatMessageClock, formatRunDuration, formatTokensPerSecond,
} from './message-chrome.ts'
import { formatCacheHitPercent, formatExactTokens, formatTokens } from './token-format.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import css from './TurnUsagePanel.module.css'

export interface TurnUsagePanelProps {
  usage: TurnTokenUsage
  /** Trigger form: the default icon pill or the temporary flat whole-line text. */
  variant?: 'pill' | 'flat'
  /** Unix epoch ms for the flat trigger's clock segment. */
  time?: number | undefined
  /** Turn wall time in ms; the flat trigger and its dialog's Turn-time section show it. */
  runMs?: number | undefined
  /** Turn decode throughput; the flat trigger and its dialog's Turn-time section show it. */
  tokensPerSecond?: number | undefined
  /** Turn first-step TTFT in ms; the flat trigger and its dialog's Turn-time section show it. */
  ttftMs?: number | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

export interface TurnTimePanelProps {
  /** Turn wall time in ms, the pill's label. */
  runMs: number
  /** Turn decode throughput, a dialog row when known. */
  tokensPerSecond?: number | undefined
  /** Turn first-step TTFT in ms, a dialog row when known. */
  ttftMs?: number | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

function formatCompactCount(value: number, t: ChatViewSlotProps['t']): string {
  return t('message.turnUsage.count', { count: formatTokens(value, t) })
}

function formatExactCount(value: number, t: ChatViewSlotProps['t']): string {
  return t('message.turnUsage.count', { count: formatExactTokens(value, t) })
}

/** Viewport margin the placement clamp keeps (the Menu portal margin). */
const PANEL_MARGIN = 12

/** Distance between the trigger's top edge and the panel's bottom. */
const PANEL_GAP = 8

/**
 * Unplaced portal panel: hidden but laid out so the clamp measures real
 * dimensions (the `useAnchoredPosition` measure pass).
 */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

interface StatDialogSeat {
  open: boolean
  setOpen: (open: boolean) => void
  rootRef: MutableRefObject<HTMLSpanElement | null>
  panelRef: MutableRefObject<HTMLDivElement | null>
  pos: CSSProperties | null
}

/** One trigger-anchored dialog seat: open state, viewport-clamped placement, outside-close. */
function useStatDialog(): StatDialogSeat {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Portal placement: the dialog is fixed above the trigger and clamped inside
  // the viewport, so a trigger near the window edge cannot push it off-screen.
  const pos = useAnchoredPosition({
    open,
    anchorRef: rootRef,
    panelRef,
    side: 'top',
    gap: PANEL_GAP,
    margin: PANEL_MARGIN,
  })

  // Outside click / Escape close, one document listener while open (ContextMeter's pattern).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (!(e.target instanceof Node)) return
      if (rootRef.current?.contains(e.target) === true) return
      if (panelRef.current?.contains(e.target) === true) return
      setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return { open, setOpen, rootRef, panelRef, pos }
}

/** Turn-time dialog rows: run time plus throughput and TTFT when known. */
function TimeDetails({ runMs, tokensPerSecond, ttftMs, t }: {
  runMs: number | undefined
  tokensPerSecond: number | undefined
  ttftMs: number | undefined
  t: ChatViewSlotProps['t']
}) {
  return (
    <dl className={css.details} data-turn-time-details>
      {runMs !== undefined && (
        <>
          <dt>{t('message.turnTime.duration')}</dt>
          <dd>{formatRunDuration(runMs, t)}</dd>
        </>
      )}
      {tokensPerSecond !== undefined && (
        <>
          <dt>{t('message.turnTime.speed')}</dt>
          <dd>{t('message.tokensPerSecond', { tps: formatTokensPerSecond(tokensPerSecond) })}</dd>
        </>
      )}
      {ttftMs !== undefined && (
        <>
          <dt>{t('message.turnTime.ttft')}</dt>
          <dd>{t('duration.seconds', { seconds: formatLatencySeconds(ttftMs) })}</dd>
        </>
      )}
    </dl>
  )
}

/**
 * Turn-usage IconActions pill (or the temporary flat meta-line trigger) with
 * a click-open Turn-usage details dialog.
 * @param props - Turn usage buckets, trigger form, and locale seat.
 * @returns The trigger and, while open, its portaled dialog anchored above the trigger.
 */
export function TurnUsagePanel({ usage, variant = 'pill', time, runMs, tokensPerSecond, ttftMs, t }: TurnUsagePanelProps) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()
  const day = useCalendarDay()

  const cacheHit = usage.cacheReadTokens === undefined
    ? null
    : formatCacheHitPercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens, 1)
  const total = formatCompactCount(usage.totalTokens, t)
  const routes = usage.routes?.map(route => `${route.provider}/${route.model}`).join(', ') ?? ''
  const flatSegments: string[] = []
  if (variant === 'flat') {
    if (time !== undefined) flatSegments.push(formatMessageClock(time, t, day))
    if (runMs !== undefined) flatSegments.push(t('message.ranFor', { duration: formatRunDuration(runMs, t) }))
    flatSegments.push(t('message.turnUsage.consumed', { total }))
    if (cacheHit !== null) flatSegments.push(t('message.turnUsage.cacheHitRate', { percent: cacheHit }))
    if (tokensPerSecond !== undefined) {
      flatSegments.push(t('message.turnUsage.speed', { tps: formatTokensPerSecond(tokensPerSecond) }))
    }
    if (ttftMs !== undefined) flatSegments.push(t('message.ttft', { seconds: formatLatencySeconds(ttftMs) }))
  }
  const hasTimeFacts = runMs !== undefined || tokensPerSecond !== undefined || ttftMs !== undefined

  return (
    <span ref={rootRef} className={css.root}>
      <button
        type="button"
        className={variant === 'flat' ? css.flatTrigger : css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        {variant === 'flat' ? flatSegments.map((segment, index) => (
          <Fragment key={index}>
            {index > 0 && <span className={css.flatDot} aria-hidden>·</span>}
            {segment}
          </Fragment>
        )) : (
          <>
            <IconDatabaseOutline16 />
            <span className={css.label}>{t('message.turnUsage.consumed', { total })}</span>
          </>
        )}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          role="dialog"
          aria-label={t('message.turnUsage.title')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={css.title}>
            <span className={css.titleLabel}>
              <IconDatabaseOutline16 />
              {t('message.turnUsage.title')}
            </span>
            <span className={css.titleValue}>{formatExactCount(usage.totalTokens, t)}</span>
          </div>
          <div className={css.titleRule} aria-hidden />
          <dl className={css.details} data-turn-usage-details>
            {routes !== '' && (
              <>
                <dt>{t('message.turnUsage.model')}</dt>
                <dd className={css.route}>{routes}</dd>
              </>
            )}
            {cacheHit !== null && (
              <>
                <dt>{t('message.turnUsage.cacheHit')}</dt>
                <dd>{`${cacheHit}%`}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.input')}</dt>
            <dd>{formatExactCount(usage.uncachedInputTokens, t)}</dd>
            {usage.cacheReadTokens !== undefined && (
              <>
                <dt>{t('message.turnUsage.cacheRead')}</dt>
                <dd>{formatExactCount(usage.cacheReadTokens, t)}</dd>
              </>
            )}
            {usage.cacheWriteTokens !== undefined && (
              <>
                <dt>{t('message.turnUsage.cacheWrite')}</dt>
                <dd>{formatExactCount(usage.cacheWriteTokens, t)}</dd>
              </>
            )}
            <dt>{t('message.turnUsage.output')}</dt>
            <dd>
              {formatExactCount(usage.outputTokens, t)}
              {usage.reasoningTokens !== undefined && (
                <span className={css.reasoning}>
                  {t('message.turnUsage.reasoning', { tokens: formatExactCount(usage.reasoningTokens, t) })}
                </span>
              )}
            </dd>
          </dl>
          {variant === 'flat' && hasTimeFacts && (
            <>
              <div className={`${css.title} ${css.timeTitle}`}>
                <span className={css.titleLabel}>
                  <IconClockOutline16 />
                  {t('message.turnTime.title')}
                </span>
              </div>
              <div className={css.titleRule} aria-hidden />
              <TimeDetails runMs={runMs} tokensPerSecond={tokensPerSecond} ttftMs={ttftMs} t={t} />
            </>
          )}
        </div>,
        document.body,
      )}
    </span>
  )
}

/**
 * Turn-time IconActions pill with a click-open Turn-time details dialog.
 * @param props - Turn timing facts and locale seat.
 * @returns The clock-and-duration trigger and, while open, its portaled dialog anchored above the trigger.
 */
export function TurnTimePanel({ runMs, tokensPerSecond, ttftMs, t }: TurnTimePanelProps) {
  const { open, setOpen, rootRef, panelRef, pos } = useStatDialog()
  return (
    <span ref={rootRef} className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        <IconClockOutline16 />
        <span className={css.label}>{t('message.ranFor', { duration: formatRunDuration(runMs, t) })}</span>
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          className={css.panel}
          role="dialog"
          aria-label={t('message.turnTime.title')}
          style={pos ?? MEASURE_STYLE}
        >
          <div className={css.title}>
            <span className={css.titleLabel}>
              <IconClockOutline16 />
              {t('message.turnTime.title')}
            </span>
          </div>
          <div className={css.titleRule} aria-hidden />
          <TimeDetails runMs={runMs} tokensPerSecond={tokensPerSecond} ttftMs={ttftMs} t={t} />
        </div>,
        document.body,
      )}
    </span>
  )
}
