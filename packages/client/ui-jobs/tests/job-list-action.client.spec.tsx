// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { JobOutputSnapshot, ObservedJob } from '@deepseek-ai/dsh-api-job-controller/client'
import type { SessionJob } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { JobListAction, type JobListActionProps } from '../src/client/JobListAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const SESSION = 'session' as SessionId
const t: JobListActionProps['t'] = makeTranslate(zh)

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

/** A job that declared an observation record, so its row offers a panel. */
function recordJob(over: Partial<SessionJob> = {}): SessionJob {
  return job({ record: true, ...over })
}

function props(
  jobs: readonly SessionJob[],
  observe: JobListActionProps['observe'] = () => () => {},
  observed: Readonly<Record<string, ObservedJob>> = {},
): JobListActionProps {
  const outputState: JobOutputSnapshot = { observed }
  function useJobOutput<T>(select: (value: JobOutputSnapshot) => T): T {
    return select(outputState)
  }
  const sessionsState = { jobsBySession: jobs.length > 0 ? { [SESSION]: jobs } : {} }
  function useSessions<T>(select: (value: typeof sessionsState) => T): T {
    return select(sessionsState)
  }
  return { sessionId: SESSION, useSessions, useJobOutput, observe, t } as unknown as JobListActionProps
}

function openList(): void {
  fireEvent.click(screen.getAllByRole('button')[0]!)
}

describe('JobListAction visibility', () => {
  it('renders nothing while the session sees no jobs', () => {
    const { container } = render(<JobListAction {...props([])} />)
    expect(container.innerHTML).toBe('')
  })

  it('counts live jobs on the trigger', () => {
    render(<JobListAction {...props([
      recordJob(),
      job({ id: 'subagent-1' as SessionJob['id'], kind: 'subagent', label: 'explore' }),
    ])} />)
    expect(screen.getByRole('button', { name: '2 个后台任务运行中' })).toBeDefined()
  })

  it('falls back to the total when nothing is live', () => {
    render(<JobListAction {...props([
      job({ status: 'completed', finishedAt: 1_700_000_003_000 }),
    ])} />)
    expect(screen.getByRole('button', { name: '1 个后台任务' })).toBeDefined()
  })
})

describe('JobListAction rows', () => {
  it('renders a record-less job row without expansion affordances', () => {
    render(<JobListAction {...props([
      job({ id: 'subagent-1' as SessionJob['id'], kind: 'subagent', label: 'explore the repo' }),
    ])} />)
    expect(screen.getByRole('button', { name: '1 个后台任务运行中' })).toBeDefined()
    openList()
    expect(screen.getByText('explore the repo')).toBeDefined()
    expect(screen.queryByRole('button', { name: zh['row.expandAria'].replace('{label}', 'explore the repo') })).toBeNull()
  })

  it('shows the live detail line in place of the status word', () => {
    render(<JobListAction {...props([recordJob({ status: 'stopping', detail: 'winding down' })])} />)
    openList()
    const list = screen.getByRole('list', { name: zh['list.aria'] })
    expect(within(list).getAllByRole('listitem')).toHaveLength(1)
    expect(within(list).getByText('pnpm run build')).toBeDefined()
    expect(within(list).getByText('winding down')).toBeDefined()
  })

  it('labels each non-empty section and drops the heading of an empty one', () => {
    const settled = [job({ id: 'bash-2' as SessionJob['id'], status: 'completed', finishedAt: 1_700_000_012_000 })]
    const { rerender } = render(<JobListAction {...props([job(), ...settled])} />)
    openList()
    expect(screen.getByText(zh['section.live'])).toBeDefined()
    expect(screen.getByText(zh['section.settled'])).toBeDefined()
    // A live-only list keeps its own heading and drops the settled one.
    rerender(<JobListAction {...props([job()])} />)
    expect(screen.getByText(zh['section.live'])).toBeDefined()
    expect(screen.queryByText(zh['section.settled'])).toBeNull()
  })

  it('shows a settled duration and ticks a live one', () => {
    vi.useFakeTimers({ now: 1_700_000_020_000 })
    render(<JobListAction {...props([
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

  it('lists rows with kind, label, and detail-or-status', () => {
    render(<JobListAction {...props([
      recordJob(),
      recordJob({ id: 'bash-2' as SessionJob['id'], status: 'failed', detail: 'exit code: 3', finishedAt: 1_700_000_002_000 }),
    ])} />)
    openList()
    const list = screen.getByRole('list', { name: zh['list.aria'] })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('pnpm run build')
    expect(items[0]?.textContent).toContain(zh['status.running'])
    expect(items[1]?.textContent).toContain('exit code: 3')
  })

  it('orders live rows first by start and settled rows newest-first with tie-breaks', () => {
    const settled = (id: string, label: string, startedAt: number, finishedAt?: number): SessionJob =>
      job({
        id: id as SessionJob['id'],
        label,
        status: 'completed',
        startedAt,
        ...finishedAt !== undefined ? { finishedAt } : {},
      })
    render(<JobListAction {...props([
      settled('bash-a', 'settled-a', 10, 100),
      settled('bash-c', 'settled-c', 80, 100),
      settled('bash-b', 'settled-b', 90),
      settled('bash-e', 'settled-e', 95, 50),
      settled('bash-d', 'settled-d', 10, 200),
      job({ id: 'bash-l1' as SessionJob['id'], label: 'live-1', startedAt: 5 }),
      job({ id: 'bash-l2' as SessionJob['id'], label: 'live-2', startedAt: 3 }),
    ])} />)
    openList()
    const labels = within(screen.getByRole('list', { name: zh['list.aria'] }))
      .getAllByRole('listitem')
      .map(item => item.querySelector('[title]')?.getAttribute('title'))
    expect(labels).toEqual([
      'live-2', 'live-1', 'settled-d', 'settled-a', 'settled-c', 'settled-b', 'settled-e',
    ])
    expect(screen.getAllByText(zh['status.completed']).length).toBeGreaterThan(0)
  })
})

describe('JobListAction observation', () => {
  it('marks killed rows, renders every output line unfolded, and copies the command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const lines = Array.from({ length: 24 }, (_value, index) => `line ${index + 1}`).join('\n')
    const view: ObservedJob = {
      jobId: 'bash-1' as SessionJob['id'],
      text: lines,
      gapBefore: false,
      status: 'killed',
      streaming: false,
    }
    render(<JobListAction {...props(
      [recordJob({ status: 'killed', finishedAt: 1_700_000_001_000 })],
      undefined,
      { 'bash-1': view },
    )} />)
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

  it('shifts an overflowing popover back inside the viewport and follows resizes', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(440)
    vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 344 } as DOMRect)
    const originalWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 700, configurable: true, writable: true })
    try {
      render(<JobListAction {...props([recordJob()])} />)
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
      render(<JobListAction {...props([recordJob()])} />)
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
      recordJob({ id: 'bash-1' as SessionJob['id'], status: 'completed', finishedAt: 2 }),
      recordJob({ id: 'bash-2' as SessionJob['id'], status: 'completed', finishedAt: 3 }),
    ]
    const { rerender } = render(<JobListAction {...props(settledPair)} />)
    expect(screen.getByRole('button', { name: '2 个后台任务' })).toBeDefined()
    openList()
    const list = screen.getByRole('list', { name: zh['list.aria'] })
    fireEvent.keyDown(list, { key: 'a' })
    expect(screen.getByRole('list', { name: zh['list.aria'] })).toBeDefined()
    // The roster emptying unmounts the control entirely; the open flag resets first.
    rerender(<JobListAction {...props([])} />)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('starts observing on expand with the session identity, renders the live text, and stops on collapse', () => {
    const stop = vi.fn()
    const observe = vi.fn(() => stop)
    const view: ObservedJob = {
      jobId: 'bash-1' as SessionJob['id'],
      text: 'compiling…\n',
      gapBefore: false,
      status: 'running',
      streaming: true,
    }
    render(<JobListAction {...props([recordJob()], observe, { 'bash-1': view })} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    expect(observe).toHaveBeenCalledWith(SESSION, 'bash-1')
    expect(screen.getByText('compiling…')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: zh['row.collapseAria'].replace('{label}', 'pnpm run build') }))
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('surfaces retention gaps and stream failures above the panel', () => {
    const view: ObservedJob = {
      jobId: 'bash-1' as SessionJob['id'],
      text: 'tail only',
      gapBefore: true,
      status: 'running',
      streaming: false,
      error: 'connection lost',
    }
    render(<JobListAction {...props([recordJob()], undefined, { 'bash-1': view })} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    expect(screen.getByText(zh['output.gap'])).toBeDefined()
    expect(screen.getByText('实时输出流中断：connection lost')).toBeDefined()
  })

  it('stops observation when the popover closes via Escape', () => {
    const stop = vi.fn()
    render(<JobListAction {...props([recordJob()], () => stop)} />)
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
    const { rerender } = render(<JobListAction {...props([recordJob()], observe)} />)
    openList()
    fireEvent.click(screen.getByRole('button', { name: zh['row.expandAria'].replace('{label}', 'pnpm run build') }))
    rerender(<JobListAction {...props([recordJob({ id: 'bash-2' as SessionJob['id'], label: 'other' })], observe)} />)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: zh['row.collapseAria'].replace('{label}', 'other') })).toBeNull()
  })
})
