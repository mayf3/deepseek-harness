import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type {
  ActivityFeedSnapshot, ActivityId, ActivityRow, ObservedActivity,
} from '@deepseek-ai/dsh-api-activity-controller/client'
import type { SessionJob } from '@deepseek-ai/dsh-api-session-controller/types'
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

/** Full props for the session-header task-list action. */
export type ActivityListActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof NS>
  & InjectFace<ActivityListInjected>

/**
 * One merged task row. Jobs and activities are separate planes — the control
 * plane the model interacts with, and the transient observation plane — so
 * this list joins them per row: a job carries identity, lifecycle, and the
 * model-visible detail; its correlated activity contributes the observable
 * live output; an activity without a job (a workflow run) stands alone.
 */
interface TaskRow {
  /** Stable row identity: the job id when one exists, else the activity id. */
  key: string
  kind: string
  label: string
  /** Job lifecycle vocabulary; activity-only rows never reach `stopping`. */
  status: SessionJob['status']
  detail?: string
  startedAt: number
  finishedAt?: number
  /** Present when this row's live output can be observed. */
  activityId?: ActivityId
}

/** Stable empty lists so a session with no work keeps one array identity. */
const NO_ROWS: readonly ActivityRow[] = []
const NO_JOBS: readonly SessionJob[] = []

/** Minimum gap kept between the popover and the viewport edges (the Menu primitive's portal margin). */
const VIEWPORT_MARGIN = 12


function isLive(row: TaskRow): boolean {
  return row.status === 'running' || row.status === 'stopping'
}

/** Closed-union exhaustiveness fence for the wire status set. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a status is forged */
function assertNever(value: never): never {
  throw new Error(`unhandled task status: ${JSON.stringify(value)}`)
}

/**
 * Status marker semantics. `stopping` and `killed` share the attention color:
 * both mean the work ended (or is ending) on request rather than on its own.
 */
function dotState(status: TaskRow['status']): StateDotState {
  switch (status) {
    case 'running': return 'ongoing'
    case 'stopping': return 'warning'
    case 'completed': return 'done'
    case 'killed': return 'warning'
    case 'failed': return 'error'
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

function statusLabel(status: TaskRow['status'], t: TranslateNS<typeof NS>): string {
  switch (status) {
    case 'running': return t('status.running')
    case 'stopping': return t('status.stopping')
    case 'completed': return t('status.completed')
    case 'killed': return t('status.killed')
    case 'failed': return t('status.failed')
    /* v8 ignore next -- closed wire status union */
    default: return assertNever(status)
  }
}

/**
 * Elapsed time in at most two adjacent units. A task that outlives an hour is
 * already exceptional, so hours is the widest unit — beyond that the figure
 * stays in hours rather than growing a day/month vocabulary no producer
 * currently reaches.
 */
function formatDuration(elapsedMs: number, t: TranslateNS<typeof NS>): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return t('duration.hours', { hours, minutes })
  if (minutes > 0) return t('duration.minutes', { minutes, seconds })
  return t('duration.seconds', { seconds })
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
    // The panel never caps lines (it scrolls), so the fold controls that
    // would invoke these stay unrendered.
    /* v8 ignore next */
    expandAria: hidden => t('terminal.expandAria', { n: hidden }),
    /* v8 ignore next */
    expand: hidden => t('terminal.expand', { n: hidden }),
  }
}

/** Project one standalone activity into the merged row vocabulary. */
function activityTask(activity: ActivityRow): TaskRow {
  return {
    key: String(activity.id),
    kind: activity.kind,
    label: activity.label,
    status: activity.status,
    ...activity.detail !== undefined ? { detail: activity.detail } : {},
    startedAt: activity.startedAt,
    ...activity.finishedAt !== undefined ? { finishedAt: activity.finishedAt } : {},
    activityId: activity.id,
  }
}

/**
 * Join this session's jobs with their correlated activities and append the
 * activities that stand alone. A job row keeps the job's lifecycle and detail
 * (what the model sees) and gains observability from its activity; an
 * activity whose job is not in the projection keeps its own row rather than
 * disappearing.
 */
function mergeRows(
  jobs: readonly SessionJob[],
  activities: readonly ActivityRow[],
): TaskRow[] {
  const byJob = new Map<string, ActivityRow>()
  const standalone: ActivityRow[] = []
  for (const activity of activities) {
    const jobId = activity.correlation?.jobId
    if (jobId === undefined) standalone.push(activity)
    // One activity per job: every shipped producer opens at most one, so a
    // duplicate jobId keeps only the newest row rather than growing the list.
    else byJob.set(String(jobId), activity)
  }
  const rows: TaskRow[] = jobs.map((job) => {
    const activity = byJob.get(String(job.id))
    byJob.delete(String(job.id))
    return {
      key: String(job.id),
      kind: job.kind,
      label: job.label,
      status: job.status,
      ...job.detail !== undefined ? { detail: job.detail } : {},
      startedAt: job.startedAt,
      ...job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {},
      ...activity !== undefined ? { activityId: activity.id } : {},
    }
  })
  for (const activity of byJob.values()) rows.push(activityTask(activity))
  for (const activity of standalone) rows.push(activityTask(activity))
  return rows
}

/**
 * Live rows first in start order, then settled rows newest-first. Two rows
 * that settled in the same millisecond fall back to start order, so the sort
 * never depends on the host's map iteration.
 */
function ordered(rows: readonly TaskRow[]): TaskRow[] {
  return [...rows].sort((left, right) => {
    const liveLeft = isLive(left)
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1
    if (liveLeft) return left.startedAt - right.startedAt
    const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    return finished !== 0 ? finished : left.startedAt - right.startedAt
  })
}

/** One task row plus, when observable and expanded, its live output panel. */
function TaskItem({ row, view, expanded, now, onToggle, t }: {
  row: TaskRow
  view: ObservedActivity | undefined
  expanded: boolean
  /** Clock sample live rows derive their running duration from. */
  now: number
  onToggle: () => void
  t: TranslateNS<typeof NS>
}) {
  const live = isLive(row)
  const status = statusLabel(row.status, t)
  const observable = row.activityId !== undefined
  const labels = useMemo(() => terminalLabels(t), [t])
  const elapsed = live ? now - row.startedAt : (row.finishedAt ?? row.startedAt) - row.startedAt
  const duration = formatDuration(elapsed, t)
  const durationCell = (
    <span
      className={css.duration}
      title={t(live ? 'duration.title.live' : 'duration.title.done', { duration })}
    >
      {duration}
    </span>
  )
  const body = live
    ? (
      <>
        <StateDot state={dotState(row.status)} className={css.rowDot} />
        <span className={css.main}>
          <span className={css.primary}>
            <span className={css.label} title={row.label}>{row.label}</span>
            {durationCell}
          </span>
          <span className={css.secondary}>
            <span className={css.kind}>{row.kind}</span>
            <span className={css.status} title={row.detail ?? status}>{row.detail ?? status}</span>
          </span>
        </span>
        {observable ? <IconChevronDownOutline14 className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} /> : null}
      </>
    )
    : (
      <>
        <StateDot state={dotState(row.status)} className={css.rowDot} />
        <span className={css.kind}>{row.kind}</span>
        <span className={css.label} title={row.label}>{row.label}</span>
        <span className={css.status} title={row.detail ?? status}>{row.detail ?? status}</span>
        {durationCell}
        {observable ? <IconChevronDownOutline14 className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} /> : null}
      </>
    )
  return (
    <li className={css.item}>
      {observable
        ? (
          <button
            type="button"
            className={live ? css.row : `${css.row} ${css.rowSettled}`}
            aria-expanded={expanded}
            aria-label={t(expanded ? 'row.collapseAria' : 'row.expandAria', { label: row.label })}
            onClick={onToggle}
          >
            {body}
          </button>
        )
        : (
          <span className={live ? `${css.row} ${css.rowStatic}` : `${css.row} ${css.rowSettled} ${css.rowStatic}`}>
            {body}
          </span>
        )}
      {expanded && view !== undefined
        ? (
          <div className={css.panel}>
            {view.gapBefore ? <div className={css.notice}>{t('output.gap')}</div> : null}
            {view.error !== undefined
              ? <div className={`${css.notice} ${css.noticeError}`}>{t('output.error', { error: view.error })}</div>
              : null}
            <TerminalBlock
              command={row.label}
              output={view.text}
              running={live}
              copyText={row.label}
              // The row above the panel already carries the state dot.
              runStateDot={false}
              // The panel scrolls its output (a stylesheet height cap) instead
              // of collapsing the middle.
              maxLines={Number.POSITIVE_INFINITY}
              labels={labels}
            />
          </div>
        )
        : null}
    </li>
  )
}

/**
 * Session-header entry point for this session's tasks: background jobs joined
 * with their live-output activities, plus standalone activities such as
 * workflow runs. It renders nothing at all until the session can see at least
 * one task; expanding an observable row starts its observation stream, and
 * collapsing (or closing the popover) stops it — output only flows while
 * someone is watching.
 * @param props - runtime slot currency, the session and activity snapshot
 *   hooks, the observation control, and the namespace translator.
 * @returns the trigger and its popover list, or null when there is nothing to show.
 */
export function ActivityListAction({ sessionId, useSessions, useActivity, observe, t }: ActivityListActionProps) {
  const jobs = useSessions(state => state.jobsBySession[sessionId]) ?? NO_JOBS
  const owned = useActivity(state => state.rowsBySession[sessionId]) ?? NO_ROWS
  const unowned = useActivity(state => state.rowsBySession['']) ?? NO_ROWS
  const observedViews = useActivity(state => state.observed)
  const [open, setOpen] = useState(false)
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  // Horizontal shift applied to the trigger-anchored popover so it stays
  // inside the viewport (the stylesheet alone cannot see the anchor offset).
  const [menuShift, setMenuShift] = useState(0)

  const rows = useMemo(
    () => ordered(mergeRows(jobs, [...owned, ...unowned])),
    [jobs, owned, unowned],
  )
  const liveRows = useMemo(() => rows.filter(isLive), [rows])
  const settledRows = useMemo(() => rows.filter(row => !isLive(row)), [rows])

  useDismissOnOutsidePointer(rootRef, open, setOpen)

  // The clock only runs while an open list is showing something that moves.
  useEffect(() => {
    if (!open || liveRows.length === 0) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [open, liveRows.length])

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

  // Observation follows visibility: the stream opens when an observable panel
  // expands and closes when it collapses, unmounts, or the popover closes.
  const activeActivity = open && expandedKey !== undefined
    ? rows.find(row => row.key === expandedKey)?.activityId
    : undefined
  useEffect(() => {
    if (activeActivity === undefined) return
    return observe(activeActivity)
  }, [activeActivity, observe])

  // The last task disappearing removes this control; close first so focus
  // does not vanish from an unmounting node.
  useEffect(() => {
    if (rows.length === 0 && open) setOpen(false)
  }, [rows.length, open])

  // An expanded row that left the list (owner disposal) folds its panel.
  useEffect(() => {
    if (expandedKey !== undefined && !rows.some(row => row.key === expandedKey)) {
      setExpandedKey(undefined)
    }
  }, [rows, expandedKey])

  if (rows.length === 0) return null

  const countKey = liveRows.length > 0
    ? (liveRows.length === 1 ? 'count.live.one' : 'count.live.other')
    : (rows.length === 1 ? 'count.idle.one' : 'count.idle.other')
  const countLabel = t(countKey, { count: liveRows.length > 0 ? liveRows.length : rows.length })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  const item = (row: TaskRow) => (
    <TaskItem
      key={row.key}
      row={row}
      view={row.activityId !== undefined ? observedViews[String(row.activityId)] : undefined}
      expanded={expandedKey === row.key}
      now={now}
      onToggle={() => {
        setExpandedKey(current => current === row.key ? undefined : row.key)
      }}
      t={t}
    />
  )

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => {
          // Sample the clock in the same commit that opens the list: the
          // mount-time value predates every task, so the first painted frame
          // would otherwise clamp a long-running row to zero until the
          // open effect corrects it a frame later.
          setNow(Date.now())
          setOpen(current => !current)
        }}
      >
        {liveRows.length > 0 ? <StateDot state="ongoing" className={css.triggerDot} /> : null}
        <span className={css.count}>{countLabel}</span>
        <IconChevronDownOutline14 className={open ? css.triggerOpen : undefined} />
      </button>
      {open
        ? (
          <ul ref={menuRef} className={css.menu} style={{ left: menuShift }} aria-label={t('list.aria')}>
            {liveRows.length > 0
              ? <li className={css.sectionHeader} aria-hidden="true">{t('section.live')}</li>
              : null}
            {liveRows.map(item)}
            {settledRows.length > 0
              ? <li className={css.sectionHeader} aria-hidden="true">{t('section.settled')}</li>
              : null}
            {settledRows.map(item)}
          </ul>
        )
        : null}
    </div>
  )
}
