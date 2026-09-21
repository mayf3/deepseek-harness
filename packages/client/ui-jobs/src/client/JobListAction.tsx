import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { JobsSnapshot, JobView, ObservedJob } from '@deepseek-ai/dsh-api-job-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  IconChevronDownOutlineRegular, StateDot, TerminalBlock, useDismissOnOutsidePointer,
  type StateDotState, type TerminalBlockLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './JobListAction.module.css'

/** Registration-side business face for the job list. */
export interface JobListInjected {
  hooks: {
    /** Client jobs snapshot (rosters and observations) bound by the renderer as useJobs. */
    jobs: {
      getSnapshot(): JobsSnapshot
      subscribe(listener: () => void): () => void
    }
  }
  /**
   * Keep one session's roster current while the list is mounted; returns the
   * stop function. Reference-counted by the client service.
   */
  watchRows: (sessionId: SessionId) => () => void
  /**
   * Start observing one job's live output; returns the stop function.
   * Reference-counted by the client service, so panels can overlap safely.
   */
  observe: (sessionId: SessionId | undefined, id: JobView['id']) => () => void
}

/** Full props for the session-header job-list action. */
export type JobListActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<typeof NS>
  & InjectFace<JobListInjected>

/** Stable empty list so a session with no jobs keeps one array identity. */
const NO_JOBS: readonly JobView[] = []

/** Minimum gap kept between the popover and the viewport edges (the Menu primitive's portal margin). */
const VIEWPORT_MARGIN = 12


function isLive(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/**
 * Whether the row offers an output panel: every live job (its output may
 * still arrive) and a settled one that left retained output behind.
 */
function isObservable(job: JobView): boolean {
  return isLive(job) || job.output.total > 0
}

/** The one-line qualifier beside the status: live progress while running, the terminal reason once settled. */
function jobDetail(job: JobView): string | undefined {
  return job.progress ?? job.detail
}

/** Closed-union exhaustiveness fence for the wire status set. */
/* v8 ignore next 3 -- closed-union backstop; only reached if a status is forged */
function assertNever(value: never): never {
  throw new Error(`unhandled job status: ${JSON.stringify(value)}`)
}

/**
 * Status marker semantics. `stopping` and `killed` share the attention color:
 * both mean the work ended (or is ending) on request rather than on its own.
 */
function dotState(status: JobView['status']): StateDotState {
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

function statusLabel(status: JobView['status'], t: TranslateNS<typeof NS>): string {
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
 * Elapsed time in at most two adjacent units. A job that outlives an hour is
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
    noExitCode: t('terminal.noExitCode'),
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

/**
 * Live rows first in start order, then settled rows newest-first. Two rows
 * that settled in the same millisecond fall back to start order, so the sort
 * never depends on the host's map iteration.
 */
function ordered(jobs: readonly JobView[]): JobView[] {
  return [...jobs].sort((left, right) => {
    const liveLeft = isLive(left)
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1
    if (liveLeft) return left.startedAt - right.startedAt
    const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    return finished !== 0 ? finished : left.startedAt - right.startedAt
  })
}

/** One job row plus, when observable and expanded, its live output panel. */
function JobItem({ job, view, expanded, now, onToggle, t }: {
  job: JobView
  view: ObservedJob | undefined
  expanded: boolean
  /** Clock sample live rows derive their running duration from. */
  now: number
  onToggle: () => void
  t: TranslateNS<typeof NS>
}) {
  const live = isLive(job)
  const status = statusLabel(job.status, t)
  const detail = jobDetail(job)
  const observable = isObservable(job)
  const labels = useMemo(() => terminalLabels(t), [t])
  const elapsed = live ? now - job.startedAt : (job.finishedAt ?? job.startedAt) - job.startedAt
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
        <StateDot state={dotState(job.status)} className={css.rowDot} />
        <span className={css.main}>
          <span className={css.primary}>
            <span className={css.label} title={job.label}>{job.label}</span>
            {durationCell}
          </span>
          <span className={css.secondary}>
            <span className={css.kind}>{job.kind}</span>
            <span className={css.status} title={detail ?? status}>{detail ?? status}</span>
          </span>
        </span>
        {/* A live row is always observable: its output may still arrive. */}
        <IconChevronDownOutlineRegular size={14} className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} />
      </>
    )
    : (
      <>
        <StateDot state={dotState(job.status)} className={css.rowDot} />
        <span className={css.kind}>{job.kind}</span>
        <span className={css.label} title={job.label}>{job.label}</span>
        <span className={css.status} title={detail ?? status}>{detail ?? status}</span>
        {durationCell}
        {observable ? <IconChevronDownOutlineRegular size={14} className={expanded ? `${css.chevron} ${css.chevronOpen}` : css.chevron} /> : null}
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
            aria-label={t(expanded ? 'row.collapseAria' : 'row.expandAria', { label: job.label })}
            onClick={onToggle}
          >
            {body}
          </button>
        )
        : (
          <span className={`${css.row} ${css.rowSettled} ${css.rowStatic}`}>
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
              command={job.label}
              output={view.text}
              running={live}
              copyText={job.label}
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
 * Session-header entry point for this session's background jobs. Mounting it
 * keeps the session's roster stream open; it renders nothing at all until the
 * session can see at least one job. Expanding an observable row (a live job,
 * or a settled one with retained output) starts its observation stream, and
 * collapsing (or closing the popover) stops it — output only flows while
 * someone is watching.
 * @param props - runtime slot currency, the jobs snapshot hook, the roster
 *   and observation controls, and the namespace translator.
 * @returns the trigger and its popover list, or null when there is nothing to show.
 */
export function JobListAction({ sessionId, useJobs, watchRows, observe, t }: JobListActionProps) {
  const jobs = useJobs(state => state.rows[sessionId]) ?? NO_JOBS
  const observedViews = useJobs(state => state.observed)
  const [open, setOpen] = useState(false)
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  // Horizontal shift applied to the trigger-anchored popover so it stays
  // inside the viewport (the stylesheet alone cannot see the anchor offset).
  const [menuShift, setMenuShift] = useState(0)

  const rows = useMemo(() => ordered(jobs), [jobs])
  const liveRows = useMemo(() => rows.filter(isLive), [rows])
  const settledRows = useMemo(() => rows.filter(job => !isLive(job)), [rows])

  useDismissOnOutsidePointer(rootRef, open, setOpen)

  // The roster follows the mounted session: one stream while this control
  // lives, released with it.
  useEffect(() => watchRows(sessionId), [sessionId, watchRows])

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
  const expandedRow = open && expandedKey !== undefined
    ? rows.find(job => String(job.id) === expandedKey)
    : undefined
  const activeJob = expandedRow !== undefined && isObservable(expandedRow) ? expandedRow.id : undefined
  useEffect(() => {
    if (activeJob === undefined) return
    return observe(sessionId, activeJob)
  }, [sessionId, activeJob, observe])

  // The last job disappearing removes this control; close first so focus
  // does not vanish from an unmounting node.
  useEffect(() => {
    if (rows.length === 0 && open) setOpen(false)
  }, [rows.length, open])

  // An expanded row that left the list (owner disposal) folds its panel.
  useEffect(() => {
    if (expandedKey !== undefined && !rows.some(job => String(job.id) === expandedKey)) {
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

  const item = (job: JobView) => (
    <JobItem
      key={String(job.id)}
      job={job}
      view={isObservable(job) ? observedViews[String(job.id)] : undefined}
      expanded={expandedKey === String(job.id)}
      now={now}
      onToggle={() => {
        setExpandedKey(current => current === String(job.id) ? undefined : String(job.id))
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
          // mount-time value predates every job, so the first painted frame
          // would otherwise clamp a long-running row to zero until the
          // open effect corrects it a frame later.
          setNow(Date.now())
          setOpen(current => !current)
        }}
      >
        {liveRows.length > 0 ? <StateDot state="ongoing" className={css.triggerDot} /> : null}
        <span className={css.count}>{countLabel}</span>
        <IconChevronDownOutlineRegular size={12} className={open ? css.triggerOpen : undefined} />
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
