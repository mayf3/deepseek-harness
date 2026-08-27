// Single-row Turn chrome: the finalized footer's whole meta line (clock,
// duration, turn total, throughput, TTFT, cache-hit) as one inline trigger
// whose click opens the per-Turn details dialog.

import { Fragment, useEffect, useRef, useState } from 'react'
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
  /** Turn-close instant (unix epoch ms) shown as the line's leading clock. */
  time: number
  /** Turn elapsed run time in ms, shown as `用时 6秒`; omitted when unrecorded. */
  runMs?: number | undefined
  /** Turn first-step TTFT in ms, shown as `TTFT 1.2s`; omitted when unrecorded. */
  ttftMs?: number | undefined
  /** Turn decode throughput, shown as `34 tok/s`; omitted when unrecorded. */
  tokensPerSecond?: number | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

function formatCompactCount(value: number, t: ChatViewSlotProps['t']): string {
  return t('message.turnUsage.count', { count: formatTokens(value, t) })
}

function formatExactCount(value: number, t: ChatViewSlotProps['t']): string {
  return t('message.turnUsage.count', { count: formatExactTokens(value, t) })
}

/**
 * Whole-line clickable meta cluster with a click-open Turn-details dialog.
 * @param props - Turn usage buckets, close time, optional timing metrics, locale seat.
 * @returns The trigger and, while open, its anchored dialog.
 */
export function TurnUsagePanel({ usage, time, runMs, ttftMs, tokensPerSecond, t }: TurnUsagePanelProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const day = useCalendarDay()

  // Outside click / Escape close, one document listener while open (ContextMeter's pattern).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target) === true) return
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

  const cacheHit = usage.cacheReadTokens === undefined
    ? null
    : formatCacheHitPercent(usage.cacheReadTokens, usage.totalTokens - usage.outputTokens, 1)
  const total = formatCompactCount(usage.totalTokens, t)
  const routes = usage.routes?.map(route => `${route.provider}/${route.model}`).join(', ') ?? ''
  const clock = formatMessageClock(time, t, day)
  const metrics: string[] = [clock]
  if (runMs !== undefined) metrics.push(t('message.ranFor', { duration: formatRunDuration(runMs, t) }))
  metrics.push(t('message.turnUsage.consumed', { total }))
  if (cacheHit !== null) metrics.push(t('message.turnUsage.cacheHitRate', { percent: cacheHit }))
  if (tokensPerSecond !== undefined) {
    metrics.push(t('message.turnUsage.speed', { tps: formatTokensPerSecond(tokensPerSecond) }))
  }
  if (ttftMs !== undefined) metrics.push(t('message.ttft', { seconds: formatLatencySeconds(ttftMs) }))

  return (
    <span ref={rootRef} className={css.root}>
      <button
        type="button"
        className={css.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setOpen(!open) }}
      >
        {metrics.map((metric, index) => (
          <Fragment key={metric}>
            {index > 0 && (
              <>
                {' '}
                <span className={css.dot} aria-hidden>·</span>
                {' '}
              </>
            )}
            {metric}
          </Fragment>
        ))}
      </button>
      {open && (
        <div className={css.panel} role="dialog" aria-label={t('message.turnUsage.title')}>
          <dl className={css.details} data-turn-usage-details>
            {routes !== '' && (
              <>
                <dt>{t('message.turnUsage.model')}</dt>
                <dd className={css.route}>{routes}</dd>
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
            {cacheHit !== null && (
              <>
                <dt>{t('message.turnDetails.cacheHit')}</dt>
                <dd>{`${cacheHit}%`}</dd>
              </>
            )}
            <dt className={css.totalLabel}>{t('message.turnUsage.total')}</dt>
            <dd className={css.totalValue}>{formatExactCount(usage.totalTokens, t)}</dd>
          </dl>
        </div>
      )}
    </span>
  )
}
