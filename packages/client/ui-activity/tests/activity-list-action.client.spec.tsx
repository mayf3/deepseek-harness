// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  ActivityFeedSnapshot, ActivityId, ActivityRow, ObservedActivity,
} from '@deepseek-ai/dsh-api-activity-controller/client'
import type { SessionJob } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ActivityListAction, type ActivityListActionProps } from '../src/client/ActivityListAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const SESSION = 'session' as SessionId
const t: ActivityListActionProps['t'] = makeTranslate(zh)

function row(over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'bash-1' as ActivityId,
    kind: 'bash',
    label: 'pnpm run build',
    sessionId: SESSION,
    status: 'running',
    startedAt: 1_700_000_000_000,
    outputTotal: 0,
    ...over,
  }
}

/** A row with no owner session, as the unowned bucket carries them. */
function unownedRow(over: Partial<ActivityRow> = {}): ActivityRow {
  const { sessionId: _drop, ...rest } = row(over)
  return rest
}

function job(over: Partial<SessionJob> = {}): SessionJob {
  return {
    id: 'bash-1' as SessionJob['id'],
    kind: 'bash',
    label: 'pnpm run build',
    status: 'running',
    startedAt: 1_700_000_000_000,
    ...over,
  }
}

function props(
  snapshot: Partial<ActivityFeedSnapshot>,
  observe: ActivityListActionProps['observe'] = () => () => {},
  jobs: readonly SessionJob[] = [],
  killJob: ActivityListActionProps['killJob'] = async () => true,
): ActivityListActionProps {
  const state: ActivityFeedSnapshot = {
    rowsBySession: {},
    observed: {},
    phase: 'ready',
    ...snapshot,
  }
  function useActivity<T>(select: (value: ActivityFeedSnapshot) => T): T {
    return select(state)
  }
  const sessionsState = { jobsBySession: jobs.length > 0 ? { [SESSION]: jobs } : {} }
  function useSessions<T>(select: (value: typeof sessionsState) => T): T {
    return select(sessionsState)
  }
  return { sessionId: SESSION, useSessions, useActivity, observe, killJob, t } as unknown as ActivityListActionProps
}

function openList(): void {
  fireEvent.click(screen.getAllByRole('button')[0]!)
}

describe('ActivityListAction visibility', () => {
  it('renders nothing while the session sees no tasks', () => {
    const { container } = render(<ActivityListAction {...props({})} />)
    expect(container.innerHTML).toBe('')
  })

  it('counts live tasks on the trigger, merging owned and unowned activity rows', () => {
    render(<ActivityListAction {...props({
      rowsBySession: {
        [SESSION]: [row()],
        '': [unownedRow({ id: 'workflow-1' as ActivityId, kind: 'workflow' })],
      },
    })} />)
    expect(screen.getByRole('button', { name: '2 个任务进行中' })).toBeDefined()
  })

  it('falls back to the total when nothing is live and hides foreign sessions', () => {
    render(<ActivityListAction {...props({
      rowsBySession: {
        [SESSION]: [row({ status: 'completed', finishedAt: 1_700_000_003_000 })],
        other: [row({ id: 'bash-9' as ActivityId, sessionId: 'other' as SessionId })],
      },
    })} />)
    expect(screen.getByRole('button', { name: '1 个任务' })).toBeDefined()
  })
})

describe('ActivityListAction merged rows', () => {
  it('joins a job with its correlated activity: job lifecycle, activity output', () => {
    const observe = vi.fn(() => () => {})
    render(<ActivityListAction {...props({
      rowsBySession: {
        [SESSION]: [row({
          id: 'bash-act-7' as ActivityId,
          label: 'activity-side label',
          correlation: { jobId: 'bash-1' as never },
        })],
      },
    }, observe, [job({ status: 'stopping', detail: 'winding down' })])} />)
    openList()
    const list = screen.getByRole('list', { name: zh['list.aria'] })
    // One merged row: the job's label and lifecycle word, not the activity's.
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('pnpm run build')).toBeDefined()
    expect(screen.queryByText('activity-side label')).toBeNull()
    expect(within(list).getByText('winding down')).toBeDefined()
    // Expansion observes the correlated activity's stream.
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    expect(observe).toHaveBeenCalledWith('bash-act-7')
  })

  it('renders a bare job row without expansion affordances', () => {
    render(<ActivityListAction {...props({}, undefined, [
      job({ id: 'subagent-1' as SessionJob['id'], kind: 'subagent', label: 'explore the repo' }),
    ])} />)
    expect(screen.getByRole('button', { name: '1 个任务进行中' })).toBeDefined()
    openList()
    expect(screen.getByText('explore the repo')).toBeDefined()
    expect(screen.queryByRole('button', { name: zh['row.expandAria'].replace('{label}', 'explore the repo') })).toBeNull()
  })

  it('keeps an activity whose job is not in the projection', () => {
    render(<ActivityListAction {...props({
      rowsBySession: {
        [SESSION]: [row({ correlation: { jobId: 'bash-9' as never } })],
      },
    })} />)
    openList()
    expect(screen.getByText('pnpm run build')).toBeDefined()
  })

  it('labels each non-empty section and drops the heading of an empty one', () => {
    const settled = [job({ id: 'bash-2' as SessionJob['id'], status: 'completed', finishedAt: 1_700_000_012_000 })]
    const { rerender } = render(<ActivityListAction {...props({}, undefined, [job(), ...settled])} />)
    openList()
    expect(screen.getByText(zh['section.live'])).toBeDefined()
    expect(screen.getByText(zh['section.settled'])).toBeDefined()
    // A live-only list keeps its own heading and drops the settled one.
    rerender(<ActivityListAction {...props({}, undefined, [job()])} />)
    expect(screen.getByText(zh['section.live'])).toBeDefined()
    expect(screen.queryByText(zh['section.settled'])).toBeNull()
  })

  it('shows a settled duration and ticks a live one', () => {
    vi.useFakeTimers({ now: 1_700_000_020_000 })
    render(<ActivityListAction {...props({}, undefined, [
      job({ startedAt: 1_700_000_015_000 }),
      job({ id: 'bash-2' as SessionJob['id'], status: 'completed', startedAt: 1_700_000_000_000, finishedAt: 1_700_000_012_000 }),
      job({ id: 'bash-3' as SessionJob['id'], status: 'completed', startedAt: 1_699_996_200_000, finishedAt: 1_700_000_000_000 }),
      job({ id: 'bash-4' as SessionJob['id'], status: 'completed', startedAt: 1_699_999_900_000, finishedAt: 1_699_999_972_000 }),
    ])} />)
    openList()
    expect(screen.getByText('5秒')).toBeDefined()
    expect(screen.getByText('12秒')).toBeDefined()
    expect(screen.getByText('1小时3分')).toBeDefined()
    expect(screen.getByText('1分12秒')).toBeDefined()
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(screen.getByText('6秒')).toBeDefined()
  })
})

describe('ActivityListAction rows and observation', () => {
  it('lists rows with kind, label, and detail-or-status', () => {
    render(<ActivityListAction {...props({
      rowsBySession: {
        [SESSION]: [
          row(),
          row({ id: 'bash-2' as ActivityId, status: 'failed', detail: 'exit code: 3', finishedAt: 1_700_000_002_000 }),
        ],
      },
    })} />)
    openList()
    const list = screen.getByRole('list', { name: zh['list.aria'] })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('pnpm run build')
    expect(items[0]?.textContent).toContain(zh['status.running'])
    expect(items[1]?.textContent).toContain('exit code: 3')
  })

  it('marks killed rows, renders every output line unfolded, and copies the command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const lines = Array.from({ length: 24 }, (_value, index) => `line ${index + 1}`).join('\n')
    const view: ObservedActivity = {
      activityId: 'bash-1' as ActivityId,
      text: lines,
      gapBefore: false,
      status: 'killed',
      streaming: false,
    }
    render(<ActivityListAction {...props({
      rowsBySession: { [SESSION]: [row({ status: 'killed', finishedAt: 1_700_000_001_000 })] },
      observed: { 'bash-1': view },
    })} />)
    openList()
    expect(screen.getByText(zh['status.killed'])).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    // The panel scrolls instead of folding: every line renders, no fold control.
    expect(screen.getByText('line 1')).toBeDefined()
    expect(screen.getByText('line 24')).toBeDefined()
    expect(screen.queryByRole('button', { name: zh['terminal.expandAria'].replace('{n}', '8') })).toBeNull()
    // The panel draws no state dot or label of its own — the row carries it.
    expect(screen.queryByText(zh['terminal.done'])).toBeNull()
    // The copy control carries the command, not the output.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh['terminal.copy'] })) })
    expect(writeText).toHaveBeenCalledWith('pnpm run build')
  })

  it('orders live rows first by start and settled rows newest-first with tie-breaks', () => {
    const settled = (id: string, label: string, startedAt: number, finishedAt?: number): ActivityRow =>
      row({
        id: id as ActivityId,
        label,
        status: 'completed',
        startedAt,
        ...finishedAt !== undefined ? { finishedAt } : {},
      })
    render(<ActivityListAction {...props({
      rowsBySession: {
        [SESSION]: [
          settled('bash-a', 'settled-a', 10, 100),
          settled('bash-c', 'settled-c', 80, 100),
          settled('bash-b', 'settled-b', 90),
          settled('bash-e', 'settled-e', 95, 50),
          settled('bash-d', 'settled-d', 10, 200),
          row({ id: 'bash-l1' as ActivityId, label: 'live-1', startedAt: 5 }),
          row({ id: 'bash-l2' as ActivityId, label: 'live-2', startedAt: 3 }),
        ],
      },
    })} />)
    openList()
    const labels = within(screen.getByRole('list', { name: zh['list.aria'] }))
      .getAllByRole('listitem')
      .map(item => item.querySelector('[title]')?.getAttribute('title'))
    expect(labels).toEqual([
      'live-2', 'live-1', 'settled-d', 'settled-a', 'settled-c', 'settled-b', 'settled-e',
    ])
    expect(screen.getAllByText(zh['status.completed']).length).toBeGreaterThan(0)
  })

  it('shifts an overflowing popover back inside the viewport and follows resizes', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(440)
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 344 } as DOMRect)
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 700, configurable: true, writable: true })
    try {
      render(<ActivityListAction {...props({ rowsBySession: { [SESSION]: [row()] } })} />)
      openList()
      const menu = screen.getByRole('list', { name: zh['list.aria'] })
      // 700 - 12 - 440 - 344 = -96: the popover moves left to keep the margin.
      expect(menu.style.left).toBe('-96px')

      window.innerWidth = 900
      fireEvent(window, new Event('resize'))
      // 900 - 12 - 440 - 344 = 104 > 0: the anchored position fits again.
      expect(menu.style.left).toBe('0px')
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true, writable: true })
    }
  })

  it('never crosses the left viewport margin for an oversized popover', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800)
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 4 } as DOMRect)
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 700, configurable: true, writable: true })
    try {
      render(<ActivityListAction {...props({ rowsBySession: { [SESSION]: [row()] } })} />)
      openList()
      const menu = screen.getByRole('list', { name: zh['list.aria'] })
      // max(12 - 4, min(0, 700 - 12 - 800 - 4)) = 8: clamped at the left margin.
      expect(menu.style.left).toBe('8px')
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true, writable: true })
    }
  })

  it('ignores other keys while open and closes once the roster empties', () => {
    const settledPair = [
      row({ id: 'bash-1' as ActivityId, status: 'completed', finishedAt: 2 }),
      row({ id: 'bash-2' as ActivityId, status: 'completed', finishedAt: 3 }),
    ]
    const { rerender } = render(<ActivityListAction {...props({
      rowsBySession: { [SESSION]: settledPair },
    })} />)
    expect(screen.getByRole('button', { name: '2 个任务' })).toBeDefined()
    openList()
    const list = screen.getByRole('list', { name: zh['list.aria'] })
    fireEvent.keyDown(list, { key: 'a' })
    expect(screen.getByRole('list', { name: zh['list.aria'] })).toBeDefined()
    // The roster emptying unmounts the control entirely; the open flag resets first.
    rerender(<ActivityListAction {...props({ rowsBySession: {} })} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('starts observing on expand, renders the live text, and stops on collapse', () => {
    const stop = vi.fn()
    const observe = vi.fn(() => stop)
    const view: ObservedActivity = {
      activityId: 'bash-1' as ActivityId,
      text: 'compiling…\n',
      gapBefore: false,
      status: 'running',
      streaming: true,
    }
    render(<ActivityListAction {...props({
      rowsBySession: { [SESSION]: [row()] },
      observed: { 'bash-1': view },
    }, observe)} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    expect(observe).toHaveBeenCalledWith('bash-1')
    expect(screen.getByText('compiling…')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: zh['row.collapseAria'].replace('{label}', 'pnpm run build') }))
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('surfaces retention gaps and stream failures above the panel', () => {
    const view: ObservedActivity = {
      activityId: 'bash-1' as ActivityId,
      text: 'tail only',
      gapBefore: true,
      status: 'running',
      streaming: false,
      error: 'connection lost',
    }
    render(<ActivityListAction {...props({
      rowsBySession: { [SESSION]: [row()] },
      observed: { 'bash-1': view },
    })} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    expect(screen.getByText(zh['output.gap'])).toBeDefined()
    expect(screen.getByText('实时输出流中断：connection lost')).toBeDefined()
  })

  it('stops observation when the popover closes via Escape', () => {
    const stop = vi.fn()
    render(<ActivityListAction {...props({
      rowsBySession: { [SESSION]: [row()] },
    }, () => stop)} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    fireEvent.keyDown(screen.getByRole('list', { name: zh['list.aria'] }), { key: 'Escape' })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('list', { name: zh['list.aria'] })).toBeNull()
  })

  it('folds an expanded panel whose row left the roster', () => {
    const stop = vi.fn()
    // One stable observe identity across renders, as the inject face provides.
    const observe = () => stop
    const first = props({ rowsBySession: { [SESSION]: [row()] } }, observe)
    const { rerender } = render(<ActivityListAction {...first} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    rerender(<ActivityListAction {...props({
      rowsBySession: { [SESSION]: [row({ id: 'bash-2' as ActivityId, label: 'other' })] },
    }, observe)} />)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: zh['row.collapseAria'].replace('{label}', 'other') })).toBeNull()
  })
})

describe('ActivityListAction human kill', () => {
  const stopTitle = (label: string): string => zh['kill.stop'].replace('{label}', label)

  it('offers the stop control only on running job rows', () => {
    render(<ActivityListAction {...props({
      rowsBySession: { [SESSION]: [row({ id: 'wf-1' as ActivityId, kind: 'workflow', label: 'standalone' })] },
    }, undefined, [job(), job({ id: 'bash-2' as SessionJob['id'], label: 'done', status: 'completed', finishedAt: 1_700_000_100_000 })])} />)
    openList()
    // The running job row offers it; the settled job and the standalone
    // activity row (workflow) have no kill handle.
    expect(screen.getByTitle(stopTitle('pnpm run build'))).toBeDefined()
    expect(screen.queryByTitle(stopTitle('done'))).toBeNull()
    expect(screen.queryByTitle(stopTitle('standalone'))).toBeNull()
  })

  it('arms on the first press and kills on the confirming press', async () => {
    const killJob = vi.fn(async () => true)
    render(<ActivityListAction {...props({}, undefined, [job()], killJob)} />)
    openList()
    const stop = screen.getByTitle(stopTitle('pnpm run build'))
    fireEvent.click(stop)
    expect(killJob).not.toHaveBeenCalled()
    expect(stop.getAttribute('data-kill-state')).toBe('armed')
    expect(screen.getByTitle(zh['kill.confirm'])).toBe(stop)
    await act(async () => { fireEvent.click(stop) })
    expect(killJob).toHaveBeenCalledWith(SESSION, 'bash-1')
    // The accepted kill leaves row convergence to the jobs frames; the local
    // phase resets so the control does not stick in pending.
    expect(stop.getAttribute('data-kill-state')).toBe('idle')
  })

  it('an armed press disarms after the confirmation window', () => {
    vi.useFakeTimers()
    const killJob = vi.fn(async () => true)
    render(<ActivityListAction {...props({}, undefined, [job()], killJob)} />)
    openList()
    const stop = screen.getByTitle(stopTitle('pnpm run build'))
    fireEvent.click(stop)
    expect(stop.getAttribute('data-kill-state')).toBe('armed')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(stop.getAttribute('data-kill-state')).toBe('idle')
    expect(killJob).not.toHaveBeenCalled()
  })

  it('a rejected kill shows its hint and then resets', async () => {
    // Fake timers from the start so the failed-hint reset arms on the fake clock.
    vi.useFakeTimers()
    const killJob = vi.fn(async () => false)
    render(<ActivityListAction {...props({}, undefined, [job()], killJob)} />)
    openList()
    const stop = screen.getByTitle(stopTitle('pnpm run build'))
    fireEvent.click(stop)
    await act(async () => { fireEvent.click(stop) })
    expect(stop.getAttribute('data-kill-state')).toBe('failed')
    expect(screen.getByTitle(zh['kill.failed'])).toBe(stop)
    act(() => { vi.advanceTimersByTime(4_000) })
    expect(stop.getAttribute('data-kill-state')).toBe('idle')
  })

  it('arming a second row disarms the first', () => {
    render(<ActivityListAction {...props({}, undefined, [
      job(),
      job({ id: 'bash-2' as SessionJob['id'], label: 'pnpm run watch' }),
    ])} />)
    openList()
    const first = screen.getByTitle(stopTitle('pnpm run build'))
    fireEvent.click(first)
    expect(first.getAttribute('data-kill-state')).toBe('armed')
    const second = screen.getByTitle(stopTitle('pnpm run watch'))
    fireEvent.click(second)
    expect(second.getAttribute('data-kill-state')).toBe('armed')
    expect(first.getAttribute('data-kill-state')).toBe('idle')
  })

  it('a kill resolving after another row armed leaves the newer phase alone', async () => {
    let resolveKill!: (ok: boolean) => void
    const killJob = vi.fn(() => new Promise<boolean>((resolve) => { resolveKill = resolve }))
    render(<ActivityListAction {...props({}, undefined, [
      job(),
      job({ id: 'bash-2' as SessionJob['id'], label: 'pnpm run watch' }),
    ], killJob)} />)
    openList()
    const first = screen.getByTitle(stopTitle('pnpm run build'))
    fireEvent.click(first)
    fireEvent.click(first)
    expect(killJob).toHaveBeenCalledTimes(1)
    // While the first kill is in flight, the user arms the second row; the
    // late resolution must not clobber that newer phase.
    const second = screen.getByTitle(stopTitle('pnpm run watch'))
    fireEvent.click(second)
    expect(second.getAttribute('data-kill-state')).toBe('armed')
    await act(async () => { resolveKill(false) })
    expect(second.getAttribute('data-kill-state')).toBe('armed')
    expect(first.getAttribute('data-kill-state')).toBe('idle')
  })

  it('clears an armed phase whose row stopped being killable', () => {
    const { rerender } = render(<ActivityListAction {...props({}, undefined, [job()])} />)
    openList()
    const stop = screen.getByTitle(stopTitle('pnpm run build'))
    fireEvent.click(stop)
    expect(stop.getAttribute('data-kill-state')).toBe('armed')
    rerender(<ActivityListAction {...props({}, undefined, [job({ status: 'stopping' })])} />)
    // The stopping row offers no kill control any more, and the stale phase is gone.
    expect(screen.queryByTitle(stopTitle('pnpm run build'))).toBeNull()
    expect(document.querySelector('[data-kill-state]')).toBeNull()
  })
})
