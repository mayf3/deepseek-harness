import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type {
  ActivityFeedSnapshot, ActivityId, ActivityRow, ObservedActivity,
} from '@deepseek-ai/dsh-api-activity-controller/client'
import {
  IconChevronDownOutline14, StateDot, TerminalBlock, useDismissOnOutsidePointer,
  type StateDotState, type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './ActivityListAction.module.css'

/** Registration-side business face for the activity feed. */
export interface ActivityListInjected {
  hooks: {
    /** Client activity snapshot bound by the renderer as useActivity. */
    activity: {
      getSnapshot(): ActivityFeedSnapshot
      subscribe(listener: () => void): () => void
    }
  }
  /**
   * Start observing one activity's live output; returns the stop function.
   * Reference-counted by the client feed, so panels can overlap safely.
   */
  observe: (id: ActivityId) => () => void
}

/** Full props for the session-header live-activity action. */
export type ActivityListActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof NS>
  & InjectFace<ActivityListInjected>

/** Stable empty list so a session with no activities keeps one array identity. */
const NO_ROWS: readonly ActivityRow[] = []

/** Minimum gap kept between the popover and the viewport edges (the Menu primitive's portal margin). */
const VIEWPORT_MARGIN = 12

/** Height cap for one live output panel inside the popover. */
const PANEL_MAX_LINES = 16

function isLive(row: ActivityRow): boolean {
  return row.status === 'running'
}

/** Closed-union exhaustiveness fence for the wire status set. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a status is forged */
function assertNever(value: never): never {
  throw new Error(`unhandled activity status: ${JSON.stringify(value)}`)
}

function dotState(status: ActivityRow['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'completed': return 'done'
    case 'killed': return 'warning'
    case 'failed': return 'error'
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

function statusLabel(status: ActivityRow['status'], t: TranslateNS<typeof NS>): string {
  switch (status) {
    case 'running': return t('status.running')
    case 'completed': return t('status.completed')
    case 'killed': return t('status.killed')
    case 'failed': return t('status.failed')
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/** Localized display copy for the embedded terminal panel. */
function terminalLabels(t: TranslateNS<typeof NS>): TerminalBlockLabels {
  return {
    // The labels contract requires exit-fact formatters, but this panel never
    // passes exit facts, so TerminalBlock never invokes them.
    /* v8 ignore next */
    signal: signal => t('terminal.signal', { signal }),
    /* v8 ignore next */
    exitCode: code => t('terminal.exitCode', { code }),
    running: t('terminal.running'),
    failed: t('terminal.failed'),
    done: t('terminal.done'),
    copy: t('terminal.copy'),
    copied: t('terminal.copied'),
    noOutput: t('terminal.noOutput'),
    collapseAria: t('terminal.collapseAria'),
    collapse: t('terminal.collapse'),
    expandAria: hidden => t('terminal.expandAria', { n: hidden }),
    expand: hidden => t('terminal.expand', { n: hidden }),
  }
}

/* jscpd:ignore-start -- mirrors JobListAction's ordering and trigger chrome by design so the two header lists read as one family. */
/** Live rows first in start order, then settled rows newest-first. */
function ordered(rows: readonly ActivityRow[]): ActivityRow[] {
  return [...rows].sort((left, right) => {
    const liveLeft = isLive(left)
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1
    if (liveLeft) return left.startedAt - right.startedAt
    const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    return finished !== 0 ? finished : left.startedAt - right.startedAt
  })
}
/* jscpd:ignore-end */

/** One expandable roster row plus its on-demand live output panel. */
function ActivityItem({ row, view, expanded, onToggle, t }: {
  row: ActivityRow
  view: ObservedActivity | undefined
  expanded: boolean
  onToggle: () => void
  t: TranslateNS<typeof NS>
}) {
  const live = isLive(row)
  const status = statusLabel(row.status, t)
  const labels = useMemo(() => terminalLabels(t), [t])
  return (
    <li className={css.item}>
      <button
        type="button"
        className={live ? css.row : `${css.row} ${css.rowSettled}`}
        aria-expanded={expanded}
        aria-label={t(expanded ? 'row.collapseAria' : 'row.expandAria', { label: row.label })}
        onClick={onToggle}
      >
        <StateDot state={dotState(row.status)} className={css.rowDot} />
        <span className={css.kind}>{row.kind}</span>
        <span className={css.label} title={row.label}>{row.label}</span>
        <span className={css.status} title={row.detail ?? status}>{row.detail ?? status}</span>
        <IconChevronDownOutline14 className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
      </button>
      {expanded
        ? (
          <div className={css.panel}>
            {view?.gapBefore === true ? <div className={css.notice}>{t('output.gap')}</div> : null}
            {view?.error !== undefined
              ? <div className={`${css.notice} ${css.noticeError}`}>{t('output.error', { error: view.error })}</div>
              : null}
            <TerminalBlock
              command={row.label}
              output={view?.text ?? ''}
              running={live}
              maxLines={PANEL_MAX_LINES}
              labels={labels}
            />
          </div>
        )
        : null}
    </li>
  )
}

/**
 * Session-header entry point for this session's live activities. It renders
 * nothing at all until the session can see at least one activity, expanding a
 * row starts its observation stream, and collapsing (or closing the popover)
 * stops it — output only flows while someone is watching.
 * @param props - runtime slot currency, the activity snapshot hook, the
 *   observation control, and the namespace translator.
 * @returns the trigger and its popover list, or null when there is nothing to show.
 */
export function ActivityListAction({ sessionId, useActivity, observe, t }: ActivityListActionProps) {
  const owned = useActivity(state => state.rowsBySession[sessionId]) ?? NO_ROWS
  const unowned = useActivity(state => state.rowsBySession['']) ?? NO_ROWS
  const observedViews = useActivity(state => state.observed)
  const [open, setOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  // Horizontal shift applied to the trigger-anchored popover so it stays
  // inside the viewport (the stylesheet alone cannot see the anchor offset).
  const [menuShift, setMenuShift] = useState(0)

  const rows = useMemo(() => ordered([...owned, ...unowned]), [owned, unowned])
  const liveCount = useMemo(() => rows.filter(isLive).length, [rows])

  useDismissOnOutsidePointer(rootRef, open, setOpen)

  // Fit the open popover to the viewport: shift left when the anchored width
  // would cross the right edge, never past the left margin.
  useLayoutEffect(() => {
    if (!open) {
      setMenuShift(0)
      return
    }
    const fit = (): void => {
      const root = rootRef.current
      const menu = menuRef.current
      /* v8 ignore next -- both refs are attached while the open popover renders. */
      if (root === null || menu === null) return
      const width = menu.offsetWidth
      // Unlaid-out nodes (and jsdom) measure 0: keep the pure CSS anchor.
      if (width === 0) return
      const anchorLeft = root.getBoundingClientRect().left
      setMenuShift(Math.max(
        VIEWPORT_MARGIN - anchorLeft,
        Math.min(0, window.innerWidth - VIEWPORT_MARGIN - width - anchorLeft),
      ))
    }
    fit()
    window.addEventListener('resize', fit)
    return () => { window.removeEventListener('resize', fit) }
  }, [open])

  // Observation follows visibility: the stream opens when a panel expands and
  // closes when it collapses, unmounts, or the popover closes.
  const activeId = open ? expandedId : undefined
  useEffect(() => {
    if (activeId === undefined) return
    return observe(activeId as ActivityId)
  }, [activeId, observe])

  // The last activity disappearing removes this control; close first so focus
  // does not vanish from an unmounting node.
  useEffect(() => {
    if (rows.length === 0 && open) setOpen(false)
  }, [rows.length, open])

  // An expanded row that left the roster (owner disposal) folds its panel.
  useEffect(() => {
    if (expandedId !== undefined && !rows.some(row => String(row.id) === expandedId)) {
      setExpandedId(undefined)
    }
  }, [rows, expandedId])

  if (rows.length === 0) return null

  const countKey = liveCount > 0
    ? (liveCount === 1 ? 'count.live.one' : 'count.live.other')
    : (rows.length === 1 ? 'count.idle.one' : 'count.idle.other')
  const countLabel = t(countKey, { count: liveCount > 0 ? liveCount : rows.length })

  /* jscpd:ignore-start -- mirrors JobListAction's dismiss/trigger interaction by design. */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => { setOpen(current => !current) }}
      >
        {liveCount > 0 ? <StateDot state="ongoing" className={css.triggerDot} /> : null}
        <span className={css.count}>{countLabel}</span>
        <IconChevronDownOutline14 className={open ? css.triggerOpen : undefined} />
      </button>
      {/* jscpd:ignore-end */}
      {open
        ? (
          <ul ref={menuRef} className={css.menu} style={{ left: menuShift }} aria-label={t('list.aria')}>
            {rows.map(row => (
              <ActivityItem
                key={row.id}
                row={row}
                view={observedViews[String(row.id)]}
                expanded={expandedId === String(row.id)}
                onToggle={() => {
                  setExpandedId(current => current === String(row.id) ? undefined : String(row.id))
                }}
                t={t}
              />
            ))}
          </ul>
        )
        : null}
    </div>
  )
}
