import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ClientWorkspaceModel } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import { DirectoryBrowseError, WorkspaceCreateError, WorkspaceRuntime } from '../src/client/workspaces/service.ts'
import {
  FakeApiClient, err, fakeRemote, ok, remoteOk, workspaceErr,
} from './fake-api.client.ts'

const sid = (id: string): SessionId => id as SessionId
const wid = (id: string): WorkspaceId => id as WorkspaceId

function workspace(id: string, sessionIds: SessionId[] = [], createdAt = '2026-01-01T00:00:00.000Z'): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/w/${id}`, title: id, sessionIds,
    createdAt, updatedAt: createdAt,
  }
}

const runtimeModels = new WeakMap<WorkspaceRuntime, ClientWorkspaceModel>()

function runtimeFor(
  ctx: Context,
  api: FakeApiClient,
  sessions: SessionRuntime,
): WorkspaceRuntime {
  const model = new ClientWorkspaceModel(fakeRemote(api).workspace)
  const runtime = new WorkspaceRuntime(ctx, api, model, sessions)
  runtimeModels.set(runtime, model)
  return runtime
}

function baseline(
  target: WorkspaceRuntime,
  items: readonly WorkspaceView[] = [],
  archivedSessionIds: readonly SessionId[] = [],
): void {
  modelOf(target).replaceBaseline({ items, archivedSessionIds })
}

function modelOf(runtime: WorkspaceRuntime): ClientWorkspaceModel {
  const model = runtimeModels.get(runtime)
  if (model === undefined) throw new Error('WorkspaceRuntime test model missing')
  return model
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('WorkspaceRuntime', () => {
  it('feeds readiness and recent-Workspace targeting without changing Host order', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote(api))
    const workspaces = runtimeFor(ctx, api, sessions)
    baseline(workspaces, [
      workspace('stable-first', [], '2026-01-03T00:00:00.000Z'),
      workspace('active', [sid('s-active')], '2026-01-01T00:00:00.000Z'),
    ])
    await flush()
    expect(workspaces.list.getSnapshot()).toMatchObject({ baselinesReady: false, recentWorkspaceId: undefined })

    api.onList = () => Promise.resolve(ok({
      items: [{ sessionId: sid('s-active'), updatedAt: Date.parse('2026-02-01'), running: false, blank: false }] as never[],
    }))
    await sessions.refresh()
    await Promise.resolve()
    await Promise.resolve()
    expect(workspaces.list.getSnapshot()).toMatchObject({
      baselinesReady: true,
      recentWorkspaceId: 'active',
    })
    expect(workspaces.list.getSnapshot().items.map(item => item.workspaceId)).toEqual(['stable-first', 'active'])
  })

  it('connectWorkspace reuses the workspace-member blank session and creates otherwise', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote(api))
    const workspaces = runtimeFor(ctx, api, sessions)
    baseline(workspaces, [
      workspace('alpha', [sid('s-blank')]), workspace('beta'), workspace('gamma'),
    ])
    api.onList = () => Promise.resolve(ok({
      items: [
        // Stray blank at alpha's path but NOT accounted under alpha (a CLI
        // session birthed at the host cwd), sorted before the member blank:
        // the scan must skip it and keep looking for a member hit.
        { sessionId: sid('s-stray-alpha'), updatedAt: 1, running: false, blank: true, cwd: '/w/alpha' },
        // Blank session parked in alpha (cwd == workspace path canon AND
        // accounted under alpha): the reuse hit.
        { sessionId: sid('s-blank'), updatedAt: 2, running: false, blank: true, cwd: '/w/alpha' },
        // Non-blank sibling in beta must never be reused.
        { sessionId: sid('s-active'), updatedAt: 3, running: false, blank: false, cwd: '/w/beta' },
        // Stray blank at gamma's path but NOT accounted under gamma (a CLI
        // session birthed at the host cwd): cwd alone must not hijack it —
        // reuse would open a session gamma cannot show, so New Session mints
        // a fresh accounted one instead.
        { sessionId: sid('s-stray'), updatedAt: 4, running: false, blank: true, cwd: '/w/gamma' },
      ] as never[],
    }))
    await sessions.refresh()
    await flush()

    // Hit: same workspace → the parked member blank comes back (the earlier
    // cwd-matching non-member stray is skipped), no create RPC.
    await expect(workspaces.connectWorkspace(wid('alpha'))).resolves.toBe('s-blank')
    expect(api.callsOf('session.create')).toEqual([])
    // Resolution guarantee: the id is binding-resolvable synchronously.
    expect(sessions.binding(sid('s-blank'))).toBeDefined()

    // Miss: beta has only a non-blank session → host create with workspaceId.
    api.onCreate = () => Promise.resolve(ok({ sessionId: sid('s-fresh') }))
    await expect(workspaces.connectWorkspace(wid('beta'))).resolves.toBe('s-fresh')
    expect(api.callsOf('session.create')).toEqual([{ workspaceId: 'beta' }])
    // Same guarantee on the create arm (draft hand-off writes the machine pre-open).
    expect(sessions.binding(sid('s-fresh'))).toBeDefined()

    // Miss: the stray blank matches gamma's path but is not a gamma member →
    // never reused, a fresh accounted session is created instead.
    api.onCreate = () => Promise.resolve(ok({ sessionId: sid('s-fresh-3') }))
    await expect(workspaces.connectWorkspace(wid('gamma'))).resolves.toBe('s-fresh-3')
    expect(api.callsOf('session.create')).toEqual([{ workspaceId: 'beta' }, { workspaceId: 'gamma' }])

    // Unknown workspace fails loud instead of silently creating in nowhere.
    await expect(workspaces.connectWorkspace(wid('ghost'))).rejects.toThrow(/unknown workspace ghost/)

    // An archived blank is never reused: no surface can show it, so New
    // Session mints a fresh one for alpha instead.
    await workspaces.archiveSession(sid('s-blank'))
    api.onCreate = () => Promise.resolve(ok({ sessionId: sid('s-fresh-2') }))
    await expect(workspaces.connectWorkspace(wid('alpha'))).resolves.toBe('s-fresh-2')
  })

  it('a rejected first prompt keeps the blank session eligible for connectWorkspace reuse', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote(api))
    const workspaces = runtimeFor(ctx, api, sessions)
    baseline(workspaces, [workspace('alpha', [sid('s-blank')])])
    api.onList = () => Promise.resolve(ok({
      items: [{ sessionId: sid('s-blank'), updatedAt: 2, running: false, blank: true, cwd: '/w/alpha' }] as never[],
    }))
    await sessions.refresh()
    await flush()
    const session = sessions.binding(sid('s-blank'))!.session
    api.onPrompt = () => Promise.resolve(err({ code: 'internal', message: 'agent busy', details: {} }) as never)
    await session.prompt([{ type: 'text', text: 'hi' }], 'queue')
    await Promise.resolve()
    // Failure leaves blank intact, so the same session is still the reuse hit.
    await expect(workspaces.connectWorkspace(wid('alpha'))).resolves.toBe('s-blank')
    expect(api.callsOf('session.create')).toEqual([])
  })

  it('returns created Workspaces and preserves Host business errors', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote(api))
    const workspaces = runtimeFor(ctx, api, sessions)
    api.onWorkspaceCreate = () => Promise.resolve(remoteOk({
      workspace: { ...workspace('picked'), path: '/w/alpha', title: 'alpha' }, created: true,
    }))
    await expect(workspaces.create({ path: '/w/alpha' })).resolves.toMatchObject({ workspaceId: 'picked' })
    expect(workspaces.list.getSnapshot().items[0]).toMatchObject({ path: '/w/alpha', title: 'alpha' })
    expect(api.callsOf('workspace.create')).toEqual([{ path: '/w/alpha' }])
    api.onWorkspaceCreate = () => Promise.resolve(workspaceErr({
      code: 'workspace-invalid-path', message: 'missing', details: { path: '/missing' },
    }))
    const rejected = workspaces.create({ path: '/missing' })
    await expect(rejected).rejects.toThrow(/workspace-invalid-path: missing/)
    await expect(rejected).rejects.toBeInstanceOf(WorkspaceCreateError)
  })

  it('passes native directory selection and cancellation through without local state', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote(api))
    const workspaces = runtimeFor(ctx, api, sessions)
    api.onPickDirectory = () => Promise.resolve(ok({ path: '/w/alpha' }))
    await expect(workspaces.pickDirectory()).resolves.toBe('/w/alpha')
    api.onPickDirectory = () => Promise.resolve(ok({ path: null }))
    await expect(workspaces.pickDirectory()).resolves.toBeNull()
    expect(api.callsOf('host.pickDirectory')).toEqual([{}, {}])
    api.onPickDirectory = () => Promise.resolve(err({ code: 'internal', message: 'no chooser', details: {} }))
    await expect(workspaces.pickDirectory()).rejects.toThrow(/no chooser/)
  })

  it('passes listings and creation through the browse wire, wrapping business failures', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const workspaces = runtimeFor(ctx, api, new SessionRuntime(ctx, api, fakeRemote(api)))
    const listing = { path: '/home/u', home: '/home/u', crumbs: [{ name: '/', path: '/', hidden: false }], entries: [{ name: 'p', path: '/home/u/p', hidden: false }], truncated: false }
    api.onListDirectory = () => Promise.resolve(ok(listing))
    await expect(workspaces.listDirectory()).resolves.toEqual(listing)
    await expect(workspaces.listDirectory('/home/u')).resolves.toEqual(listing)
    // The optional path is omitted from the payload, not sent as undefined.
    expect(api.callsOf('host.listDirectory')).toEqual([{}, { path: '/home/u' }])
    api.onListDirectory = () => Promise.resolve(err({ code: 'directory-unreadable', message: 'denied', details: { path: '/x' } }))
    const listFailure = workspaces.listDirectory('/x')
    await expect(listFailure).rejects.toBeInstanceOf(DirectoryBrowseError)
    await expect(listFailure).rejects.toMatchObject({ rpcError: { code: 'directory-unreadable' } })

    await expect(workspaces.createDirectory('/home/u', 'fresh')).resolves.toBe('/home/fake/new')
    expect(api.callsOf('host.createDirectory')).toEqual([{ path: '/home/u', name: 'fresh' }])
    api.onCreateDirectory = () => Promise.resolve(err({ code: 'directory-exists', message: 'taken', details: { path: '/home/u/fresh' } }))
    await expect(workspaces.createDirectory('/home/u', 'fresh')).rejects.toMatchObject({ rpcError: { code: 'directory-exists' } })
  })

  it('opens a filesystem path through the host without local state', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote(api))
    const workspaces = runtimeFor(ctx, api, sessions)
    await expect(workspaces.openPath('/w/alpha/a.ts')).resolves.toBeUndefined()
    expect(api.callsOf('host.openPath')).toEqual([{ path: '/w/alpha/a.ts' }])
    api.onOpenPath = () => Promise.resolve(err({ code: 'internal', message: 'boom', details: {} }))
    await expect(workspaces.openPath('/missing')).rejects.toThrow(/path open failed/)
  })

  it('deletes a Workspace or preserves it when the Host rejects deletion', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote(api))
    const workspaces = runtimeFor(ctx, api, sessions)
    baseline(workspaces, [workspace('alpha')])
    await flush()
    await expect(workspaces.delete(wid('alpha'))).resolves.toBeUndefined()
    expect(workspaces.list.getSnapshot().items).toEqual([])

    api.onWorkspaceDelete = () => Promise.resolve(workspaceErr({
      code: 'workspace-not-found', message: 'gone', details: { workspaceId: wid('ghost') },
    }))
    await expect(workspaces.delete(wid('ghost'))).rejects.toThrow(/workspace-not-found: gone/)
  })

  it('moves a Workspace through the durable order RPC and surfaces Host rejection', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const workspaces = runtimeFor(ctx, api, new SessionRuntime(ctx, api, fakeRemote(api)))
    baseline(workspaces, [workspace('one'), workspace('two')])
    await flush()
    api.onWorkspaceInsertBefore = () => Promise.resolve(remoteOk({
      workspaceIds: [wid('two'), wid('one')],
    }))
    await expect(workspaces.insertBefore(wid('two'), wid('one'))).resolves.toBeUndefined()
    expect(api.callsOf('workspace.insertBefore')).toEqual([{
      workspaceId: 'two', beforeWorkspaceId: 'one',
    }])
    expect(workspaces.list.getSnapshot().items.map(item => item.workspaceId)).toEqual(['two', 'one'])

    api.onWorkspaceInsertBefore = () => Promise.resolve(workspaceErr({
      code: 'workspace-not-found', message: 'gone', details: { workspaceId: wid('ghost') },
    }))
    await expect(workspaces.insertBefore(wid('ghost'))).rejects.toThrow(/workspace-not-found: gone/)
  })

  it('targets New Session at explicit, current-session, then recent Workspaces and clears with none', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote(api))
    const workspaces = runtimeFor(ctx, api, sessions)
    baseline(workspaces, [
      workspace('current-home', [sid('current')]),
      workspace('recent-home', [sid('recent')]),
    ])
    api.onList = () => Promise.resolve(ok({ items: [
      { sessionId: sid('current'), updatedAt: 1, running: false, blank: false },
      { sessionId: sid('recent'), updatedAt: 2, running: false, blank: false },
    ] as never[] }))
    await sessions.refresh()
    await flush()
    sessions.open(sid('current'))
    const unresolved = new Promise<SessionId>(() => {})
    const connect = vi.spyOn(workspaces, 'connectWorkspace').mockReturnValue(unresolved)

    workspaces.startSession(wid('recent-home'))
    await Promise.resolve()
    expect(connect).toHaveBeenLastCalledWith(wid('recent-home'))

    workspaces.startSession()
    await Promise.resolve()
    expect(connect).toHaveBeenLastCalledWith(wid('current-home'))

    sessions.clear()
    workspaces.startSession()
    await Promise.resolve()
    expect(connect).toHaveBeenLastCalledWith(wid('recent-home'))

    const emptyCtx = new Context()
    const emptyApi = new FakeApiClient()
    const emptySessions = new SessionRuntime(emptyCtx, emptyApi, fakeRemote(emptyApi))
    const emptyWorkspaces = runtimeFor(emptyCtx, emptyApi, emptySessions)
    const clear = vi.spyOn(emptySessions, 'clear')
    emptyWorkspaces.startSession()
    expect(clear).toHaveBeenCalledOnce()
  })

  it('archives a session, projects unary and stream state, and clears only the current one', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote(api))
    const workspaces = runtimeFor(ctx, api, sessions)
    api.onList = () => Promise.resolve(ok({
      items: [
        { sessionId: sid('s-open'), updatedAt: 2, running: false, blank: false },
        { sessionId: sid('s-idle'), updatedAt: 1, running: false, blank: false },
      ],
    }) as never)
    await sessions.refresh()
    sessions.open(sid('s-open'))

    // Archiving a non-current session installs the unary echo and keeps the selection.
    await expect(workspaces.archiveSession(sid('s-idle'))).resolves.toBeUndefined()
    expect(api.callsOf('workspace.archiveSession')).toEqual([{ sessionId: 's-idle' }])
    expect(workspaces.list.getSnapshot().archivedSessionIds).toEqual(['s-idle'])
    expect(sessions.list.getSnapshot().current).toBe('s-open')

    // Archiving the current session clears it into the New Session view state.
    api.onWorkspaceArchiveSession = () => Promise.resolve(remoteOk({ archivedSessionIds: [sid('s-idle'), sid('s-open')] }))
    await workspaces.archiveSession(sid('s-open'))
    expect(workspaces.list.getSnapshot().archivedSessionIds).toEqual(['s-idle', 's-open'])
    expect(sessions.list.getSnapshot().current).toBeUndefined()

    // A Host failure leaves the set and the selection untouched.
    api.onWorkspaceArchiveSession = () => Promise.resolve(workspaceErr({
      code: 'session-not-found', message: 'no session ghost', details: { sessionId: sid('ghost') },
    }))
    await expect(workspaces.archiveSession(sid('ghost'))).rejects.toThrow(/session-not-found/)
    expect(workspaces.list.getSnapshot().archivedSessionIds).toEqual(['s-idle', 's-open'])

    modelOf(workspaces).replaceArchived([sid('s-idle')])
    await flush()
    expect(workspaces.list.getSnapshot().archivedSessionIds).toEqual(['s-idle'])
    baseline(workspaces, [], [sid('s-open')])
    await flush()
    expect(workspaces.list.getSnapshot().archivedSessionIds).toEqual(['s-open'])
  })

  it('clears a current archived by a stream increment and accepts the next baseline as authoritative', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote(api))
    const workspaces = runtimeFor(ctx, api, sessions)
    api.onList = () => Promise.resolve(ok({
      items: [{ sessionId: sid('s-open'), updatedAt: 1, running: false, blank: false }],
    }) as never)
    await sessions.refresh()
    sessions.open(sid('s-open'))

    modelOf(workspaces).replaceArchived([sid('s-open')])
    await flush()
    expect(sessions.list.getSnapshot().current).toBeUndefined()
    expect(workspaces.list.getSnapshot().archivedSessionIds).toEqual(['s-open'])
    baseline(workspaces)
    await flush()
    expect(workspaces.list.getSnapshot().archivedSessionIds).toEqual([])
  })
})

describe('startInitialSelection', () => {
  function bench() {
    const ctx = new Context()
    const api = new FakeApiClient()
    const sessions = new SessionRuntime(ctx, api, fakeRemote(api))
    const workspaces = runtimeFor(ctx, api, sessions)
    return { api, sessions, workspaces }
  }

  it('connects the recent Workspace blank session once baselines are ready and opens it', async () => {
    const b = bench()
    const stop = b.workspaces.startInitialSelection()
    // Nothing happens before both baselines land.
    expect(b.api.callsOf('session.create')).toHaveLength(0)

    b.api.onCreate = () => Promise.resolve(ok({ sessionId: sid('s-new') }))
    baseline(b.workspaces, [workspace('recent', [], '2026-01-02T00:00:00.000Z')])
    await b.sessions.refresh()
    // Store notifications and the connect round trip are microtask-batched.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.api.callsOf('session.create')).toEqual([{ workspaceId: 'recent' }])
    expect(b.sessions.list.getSnapshot().current).toBe('s-new')
    stop()
  })

  it('stays idle when a session is already current or no recent Workspace exists', async () => {
    const withCurrent = bench()
    withCurrent.api.onList = () => Promise.resolve(ok({
      items: [{ sessionId: sid('s1'), updatedAt: 1, running: false, blank: false }] as never[],
    }))
    await withCurrent.sessions.refresh()
    withCurrent.sessions.open(sid('s1'))
    const stopCurrent = withCurrent.workspaces.startInitialSelection()
    baseline(withCurrent.workspaces, [workspace('w1', [sid('s1')])])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(withCurrent.api.callsOf('session.create')).toHaveLength(0)
    stopCurrent()

    const noRecent = bench()
    const stopEmpty = noRecent.workspaces.startInitialSelection()
    baseline(noRecent.workspaces)
    await noRecent.sessions.refresh()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(noRecent.api.callsOf('session.create')).toHaveLength(0)
    expect(() => noRecent.workspaces.startInitialSelection()).toThrow(/already started/)
    stopEmpty()
  })

  it('a failed connect returns to waiting and retries on the next list change', async () => {
    const b = bench()
    b.api.onCreate = () => Promise.resolve(err({ code: 'internal', message: 'attach exploded', details: {} }))
    const stop = b.workspaces.startInitialSelection()
    baseline(b.workspaces, [workspace('recent', [], '2026-01-02T00:00:00.000Z')])
    await b.sessions.refresh()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.api.callsOf('session.create')).toHaveLength(1)
    expect(b.sessions.list.getSnapshot().current).toBeUndefined()

    // Recovery: the next Workspace stream change re-runs the reconcile.
    b.api.onCreate = () => Promise.resolve(ok({ sessionId: sid('s-retry') }))
    modelOf(b.workspaces).upsertView(workspace('recent', [], '2026-01-03T00:00:00.000Z'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.api.callsOf('session.create')).toHaveLength(2)
    expect(b.sessions.list.getSnapshot().current).toBe('s-retry')
    stop()
  })
})
