// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  TeamMemberProjection, TeamProjection, TeamTaskId, TeamTaskView as TeamTask,
} from '@deepseek-ai/dsh-experimental-agent-team/client'
import type { SessionListState, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector, makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TeamAction, type TeamActionInjected, type TeamActionProps } from '../src/client/TeamAction.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const SESSION = 'lead' as SessionId
const WORKER = 'worker-id' as SessionId
const TASK_1 = 'task-1' as TeamTaskId
const TASK_2 = 'task-2' as TeamTaskId
const task: TeamTask = {
  id: TASK_1,
  revision: 1,
  subject: 'Implement runtime',
  description: 'Build the Team runtime',
  status: 'in_progress',
  ownerName: 'lead',
  blockedBy: [],
  writeScopes: ['src'],
  ready: false,
  writeScopeWarnings: ['write scopes overlap with task-2'],
}
const lead: TeamMemberProjection = { id: SESSION, name: 'lead', role: 'lead', phase: 'active' }
const worker: TeamMemberProjection = {
  id: WORKER, name: 'worker', role: 'teammate', phase: 'active', description: 'worker', provider: 'spawn', context: 'fresh',
}
const team: TeamProjection = { members: [lead, worker], tasks: [task] }

type Projections = SessionListState['projectionsBySession']

function bench(options: {
  projections?: Projections
  sessionId?: SessionId
  parentSessionId?: SessionId
  statuses?: SessionStatusSnapshot
  running?: Record<string, boolean>
} = {}) {
  const sessionId = options.sessionId ?? SESSION
  const byId = Object.fromEntries(Object.entries(options.running ?? {}).map(([id, running]) => [id, { sessionId: id, running }]))
  const sessions = createSnapshotStore<SessionListState>({
    ids: Object.keys(byId), byId, phase: 'ready',
    projectionsBySession: options.projections ?? { [SESSION]: { state: 'ready', error: null, values: { agentTeam: team } } },
  } as unknown as SessionListState)
  const statuses = createSnapshotStore<SessionStatusSnapshot>(options.statuses ?? new Map())
  const session = createSnapshotStore<SessionSnapshot>({
    sessionId,
    subagent: options.parentSessionId === undefined
      ? null
      : { address: { parentSessionId: options.parentSessionId, childSessionId: sessionId, mode: 'continuable' } },
  } as unknown as SessionSnapshot)
  const injected: TeamActionInjected = { loadProjections: vi.fn(), openTeammate: vi.fn() }
  const props = {
    sessionId,
    useSession: bindSnapshotSelector(session),
    useSessions: bindSnapshotSelector(sessions),
    useSessionStatus: bindSnapshotSelector(statuses),
    ...injected,
    t: makeTranslate(zh, commonZh),
  } as unknown as TeamActionProps
  return { props, injected, sessions, statuses, session }
}

function openPanel(): void {
  fireEvent.click(screen.getByRole('button', { name: /Agent Team/u }))
}

function setProjectionSnapshot(
  sessions: ReturnType<typeof bench>['sessions'],
  sessionId: SessionId,
  snapshot: Projections[SessionId],
): void {
  act(() => {
    const current = sessions.getSnapshot()
    sessions.set({ ...current, projectionsBySession: { ...current.projectionsBySession, [sessionId]: snapshot } })
  })
}

function setProjection(sessions: ReturnType<typeof bench>['sessions'], sessionId: SessionId, value: TeamProjection): void {
  setProjectionSnapshot(sessions, sessionId, { state: 'ready', error: null, values: { agentTeam: value } })
}

describe('TeamAction', () => {
  it('renders the Lead projection and applies later projection frames without any user action', async () => {
    const b = bench()
    render(<TeamAction {...b.props} />)
    expect(screen.getByRole('button', { name: /Agent Team/u }).textContent).toContain('1')
    openPanel()
    expect(await screen.findByText('Implement runtime')).toBeTruthy()
    expect(screen.getByText('write scopes overlap with task-2')).toBeTruthy()
    expect(b.injected.loadProjections).toHaveBeenCalledWith(SESSION)
    expect(screen.queryByRole('button', { name: /刷新|Refresh/u })).toBeNull()

    setProjection(b.sessions, SESSION, {
      members: [lead, worker, { id: 'worker-b' as SessionId, name: 'worker-b', role: 'teammate', phase: 'provisioning' }],
      tasks: [task, { ...task, id: TASK_2, subject: 'Pushed task', status: 'pending', ready: true, writeScopeWarnings: [] }],
    })
    expect(screen.getByText('Pushed task')).toBeTruthy()
    expect(screen.getByRole('button', { name: /worker-b/u })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: /Agent Team/u }).textContent).toContain('2')
  })

  it('overlays live Session status and the durable model selection on roster rows', () => {
    const statuses: SessionStatusSnapshot = new Map([[WORKER, { running: true, pendingInteraction: undefined, completionUnread: false }]])
    const b = bench({
      statuses,
      running: { [SESSION]: true },
      projections: {
        [SESSION]: {
          state: 'ready', error: null,
          values: { agentTeam: team, modelSelection: { lastUsed: null, next: { provider: 'p', model: 'lead-model' } } },
        },
        [WORKER]: {
          state: 'ready', error: null,
          values: { modelSelection: { lastUsed: { provider: 'p', model: 'worker-model' }, next: { provider: 'p', model: 'worker-model' } } },
        },
      },
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('button', { name: `lead${zh['memberStatus.running']} · ${zh.model}: lead-model` })).toBeTruthy()
    const row = screen.getByRole('button', { name: `worker${zh['memberStatus.running']} · ${zh.model}: worker-model` })
    expect(row.querySelector('[data-state="ongoing"]')).not.toBeNull()

    act(() => { b.statuses.set(new Map([[WORKER, { running: false, pendingInteraction: undefined, completionUnread: false }]])) })
    expect(screen.getByRole('button', { name: /^worker未运行/u })).toBeTruthy()

    act(() => {
      b.statuses.set(new Map())
      b.sessions.update((draft) => { draft.byId[WORKER] = { sessionId: WORKER, running: true } as never })
    })
    expect(screen.getByRole('button', { name: /^worker运行中/u })).toBeTruthy()
  })

  it('reads the Lead projection from an addressed teammate conversation', () => {
    const b = bench({ sessionId: WORKER, parentSessionId: SESSION })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByText('Implement runtime')).toBeTruthy()
    expect(b.injected.loadProjections).toHaveBeenCalledWith(SESSION)
    fireEvent.click(screen.getByRole('button', { name: /^worker/u }))
    expect(b.injected.openTeammate).toHaveBeenCalledWith(WORKER, worker)
  })

  it('shows loading until the projection arrives and a retryable read failure', () => {
    const b = bench({ projections: {} })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)

    setProjectionSnapshot(b.sessions, SESSION, { state: 'error', error: new RemoteError('gateway/internal', 'offline', {}), values: {} })
    expect(screen.getByRole('alert').textContent).toBe('offline (gateway/internal)')
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(b.injected.loadProjections).toHaveBeenCalledTimes(2)

    setProjectionSnapshot(b.sessions, SESSION, { state: 'idle', error: null, values: {} })
    expect(screen.getByRole('status').textContent).toBe(zh.loading)

    setProjection(b.sessions, SESSION, { members: [lead], tasks: [] })
    expect(screen.getByText(zh.empty)).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('surfaces a Team projection failure beside the last valid state', () => {
    const b = bench({
      projections: { [SESSION]: { state: 'ready', error: null, values: { agentTeam: { ...team, failure: 'revision is not contiguous' } } } },
    })
    render(<TeamAction {...b.props} />)
    openPanel()
    expect(screen.getByRole('alert').textContent).toBe('Team 持久记录无效：revision is not contiguous')
    expect(screen.getByText('Implement runtime')).toBeTruthy()
  })

  it('renders roster/task state variants and reports navigation failures', () => {
    const { ownerName: _ownerName, ...unownedTask } = task
    const b = bench({
      projections: {
        [SESSION]: {
          state: 'ready', error: null,
          values: {
            agentTeam: {
              members: [
                lead,
                worker,
                { id: 'failed-id' as SessionId, name: 'failed-worker', role: 'teammate', phase: 'failed', error: 'provider failed' },
                { id: 'provisioning-id' as SessionId, name: 'provisioning-worker', role: 'teammate', phase: 'provisioning' },
              ],
              tasks: [
                { ...unownedTask, id: 'ready-task' as TeamTaskId, status: 'pending', ready: true },
                { ...unownedTask, id: 'blocked-task' as TeamTaskId, status: 'pending', ready: false, blockedBy: [TASK_1] },
                { ...task, id: 'completed-task' as TeamTaskId, status: 'completed', ownerName: 'worker' },
              ],
            },
          },
        },
      },
    })
    b.injected.openTeammate = vi.fn(() => { throw new Error('navigation failed') })
    render(<TeamAction {...b.props} {...b.injected} />)
    openPanel()
    expect(screen.getByText('provider failed')).toBeTruthy()
    expect(screen.getByText(zh.ready)).toBeTruthy()
    expect(screen.getByText(zh.blocked)).toBeTruthy()
    expect(screen.getAllByText('Owner: 未分配')).toHaveLength(2)
    expect(screen.getByText('Owner: worker')).toBeTruthy()
    const failedMember = screen.getByRole<HTMLButtonElement>('button', { name: /failed-worker/u })
    const provisioningMember = screen.getByRole<HTMLButtonElement>('button', { name: /provisioning-worker/u })
    expect(failedMember.disabled).toBe(true)
    expect(failedMember.querySelector('[data-state="error"]')).not.toBeNull()
    expect(provisioningMember.disabled).toBe(true)
    expect(provisioningMember.querySelector('[data-state="ongoing"]')).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /^lead/u }).disabled).toBe(true)
    const tasks = [...document.querySelectorAll('article')]
    expect(tasks.map(card => card.querySelector('[data-state]')?.getAttribute('data-state')))
      .toEqual(['idle', 'warning', 'done'])
    for (const card of tasks) expect(card.querySelector('button, input, select, textarea')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^worker/u }))
    expect(screen.getByRole('alert').textContent).toBe('Error: navigation failed')
    fireEvent.click(screen.getByRole('button', { name: zh.close }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Agent Team/u }))
  })

  it('closes the panel and clears a navigation failure when the conversation switches sessions', () => {
    const b = bench()
    b.injected.openTeammate = vi.fn(() => { throw new Error('navigation failed') })
    const rendered = render(<TeamAction {...b.props} {...b.injected} />)
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: /^worker/u }))
    expect(screen.getByRole('alert')).toBeTruthy()

    const next = bench({ sessionId: 'next-lead' as SessionId, projections: {} })
    rendered.rerender(<TeamAction {...next.props} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    openPanel()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(zh.loading)
    expect(next.injected.loadProjections).toHaveBeenCalledWith('next-lead')
  })

  it('keeps panel interactions open and dismisses on outside pointer or Escape', () => {
    const b = bench()
    const rendered = render(<TeamAction {...b.props} />)
    const trigger = screen.getByRole('button', { name: /Agent Team/u })
    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog')
    expect(rendered.container.contains(panel)).toBe(false)
    expect(document.activeElement).toBe(panel)
    fireEvent.pointerDown(panel)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(trigger)
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('button', { name: zh.close }), { key: 'Enter' })
    expect(screen.queryByRole('dialog')).not.toBeNull()
    fireEvent.keyDown(screen.getByRole('button', { name: zh.close }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps focus within the trigger or panel and closes when focus moves elsewhere', () => {
    const b = bench()
    render(<><TeamAction {...b.props} /><button>Outside</button></>)
    const trigger = screen.getByRole('button', { name: /Agent Team/u })
    fireEvent.click(trigger)
    const panel = screen.getByRole('dialog')
    fireEvent.blur(panel, { relatedTarget: screen.getByRole('button', { name: zh.close }) })
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.blur(panel, { relatedTarget: trigger })
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.blur(panel, { relatedTarget: null })
    expect(screen.getByRole('dialog')).toBe(panel)
    fireEvent.blur(panel, { relatedTarget: screen.getByRole('button', { name: 'Outside' }) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
