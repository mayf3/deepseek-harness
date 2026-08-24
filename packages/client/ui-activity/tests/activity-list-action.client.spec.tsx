// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  ActivityFeedSnapshot, ActivityId, ActivityRow, ObservedActivity,
} from '@deepseek-ai/dsh-api-activity-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ActivityListAction, type ActivityListActionProps } from '../src/client/ActivityListAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
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

function props(
  snapshot: Partial<ActivityFeedSnapshot>,
  observe: ActivityListActionProps['observe'] = () => () => {},
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
  return { sessionId: SESSION, useActivity, observe, t } as unknown as ActivityListActionProps
}

function openList(): void {
  fireEvent.click(screen.getAllByRole('button')[0]!)
}

describe('ActivityListAction visibility', () => {
  it('renders nothing while the session sees no activities', () => {
    const { container } = render(<ActivityListAction {...props({})} />)
    expect(container.innerHTML).toBe('')
  })

  it('counts live activities on the trigger, merging owned and unowned rows', () => {
    render(<ActivityListAction {...props({
      rowsBySession: {
        [SESSION]: [row()],
        '': [unownedRow({ id: 'workflow-1' as ActivityId, kind: 'workflow' })],
      },
    })} />)
    expect(screen.getByRole('button', { name: '2 个活动进行中' })).toBeDefined()
  })

  it('falls back to the total when nothing is live and hides foreign sessions', () => {
    render(<ActivityListAction {...props({
      rowsBySession: {
        [SESSION]: [row({ status: 'completed', finishedAt: 1_700_000_003_000 })],
        other: [row({ id: 'bash-9' as ActivityId, sessionId: 'other' as SessionId })],
      },
    })} />)
    expect(screen.getByRole('button', { name: '1 个活动' })).toBeDefined()
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

  it('marks killed rows and expands an overflowing panel through the collapse controls', () => {
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
    const expand = screen.getByRole('button', { name: zh['terminal.expandAria'].replace('{n}', '8') })
    fireEvent.click(expand)
    expect(screen.getByRole('button', { name: zh['terminal.collapseAria'] })).toBeDefined()
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

  it('ignores other keys while open and closes once the roster empties', () => {
    const settledPair = [
      row({ id: 'bash-1' as ActivityId, status: 'completed', finishedAt: 2 }),
      row({ id: 'bash-2' as ActivityId, status: 'completed', finishedAt: 3 }),
    ]
    const { rerender } = render(<ActivityListAction {...props({
      rowsBySession: { [SESSION]: settledPair },
    })} />)
    expect(screen.getByRole('button', { name: '2 个活动' })).toBeDefined()
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
