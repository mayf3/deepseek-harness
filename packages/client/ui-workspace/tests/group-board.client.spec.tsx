// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { GroupBoard } from '../src/client/GroupBoard.tsx'
import { zh } from '../src/client/locales.ts'

const t = makeTranslate(zh, commonZh) as never
const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const summary = (id: string, updatedAt: number): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt,
})
const state = (items: SessionSummary[]): SessionListState => ({
  ids: items.map(item => item.id), byId: Object.fromEntries(items.map(item => [item.id, item])),
  current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
})
const hook = <T,>(snapshot: T) => <U,>(selector: (value: T) => U): U => selector(snapshot)
const workspace: WorkspaceView = {
  workspaceId: wid('work'), path: '/projects/work', title: 'Work',
  sessionIds: [sid('a'), sid('b'), sid('c')],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

afterEach(cleanup)

function props(overrides: Partial<Parameters<typeof GroupBoard>[0]> = {}): Parameters<typeof GroupBoard>[0] {
  return {
    open: true,
    onClose: vi.fn(),
    useSessions: hook(state([summary('a', 3), summary('b', 2), summary('c', 1)])),
    workspaces: [workspace],
    archivedSessionIds: [],
    sessionMeta: { a: { group: '前端' }, b: { group: '前端' }, c: { group: '后端' } },
    knownGroups: ['前端', '后端'],
    sessionOrderByAccount: { 'group:前端': ['b', 'a'], 'group:后端': ['c'] },
    setSessionGroup: vi.fn(),
    setSessionOrder: vi.fn(),
    removeGroup: vi.fn(),
    onOpenSession: vi.fn(),
    onAddGroup: vi.fn(),
    t,
    ...overrides,
  }
}

describe('GroupBoard', () => {
  it('renders exclusive group columns, opens cards, and exposes group actions', () => {
    const p = props()
    render(<GroupBoard {...p} />)
    expect(screen.getByRole('dialog', { name: '任务看板' })).toBeTruthy()
    expect(screen.getByText('前端')).toBeTruthy()
    expect(screen.getByText('后端')).toBeTruthy()
    expect(screen.getByText('未分组')).toBeTruthy()
    // Stored order is shared with the group list: b precedes a.
    expect(screen.getAllByText(/^[abc]$/).map(item => item.textContent)).toEqual(['b', 'a', 'c'])
    fireEvent.click(screen.getByText('a'))
    expect(p.onOpenSession).toHaveBeenCalledWith(sid('a'))
    expect(p.onClose).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '新建分组' }))
    expect(p.onAddGroup).toHaveBeenCalledOnce()
    fireEvent.click(screen.getAllByRole('button', { name: '删除分组' })[0]!)
    expect(p.removeGroup).toHaveBeenCalledWith('前端')
  })

  it('reorders inside a column and moves a card across columns', () => {
    const setSessionGroup = vi.fn()
    const setSessionOrder = vi.fn()
    render(<GroupBoard {...props({ setSessionGroup, setSessionOrder })} />)
    const a = screen.getByText('a').closest('article') as HTMLElement
    const b = screen.getByText('b').closest('article') as HTMLElement
    b.getBoundingClientRect = () => ({
      top: 100, bottom: 180, left: 0, right: 200, width: 200, height: 80,
      x: 0, y: 100, toJSON: () => ({}),
    })
    fireEvent.dragStart(a, { dataTransfer: { effectAllowed: '', setData: vi.fn() } })
    fireEvent.dragOver(b, { clientY: 110 })
    fireEvent.drop(b)
    expect(setSessionOrder).toHaveBeenCalledWith('group:前端', ['a', 'b'])
    expect(setSessionGroup).not.toHaveBeenCalled()

    setSessionOrder.mockClear()
    const aAgain = screen.getByText('a').closest('article') as HTMLElement
    fireEvent.dragStart(aAgain, { dataTransfer: { effectAllowed: '', setData: vi.fn() } })
    const cTarget = screen.getByText('c').closest('article') as HTMLElement
    cTarget.getBoundingClientRect = () => ({
      top: 200, bottom: 280, left: 0, right: 200, width: 200, height: 80,
      x: 0, y: 200, toJSON: () => ({}),
    })
    fireEvent.dragOver(cTarget, { clientY: 210 })
    fireEvent.drop(cTarget)
    expect(setSessionGroup).toHaveBeenCalledWith(sid('a'), '后端')
    expect(setSessionOrder).toHaveBeenCalledWith('group:前端', ['b'])
    expect(setSessionOrder).toHaveBeenCalledWith('group:后端', ['c', 'a'])
  })
})
