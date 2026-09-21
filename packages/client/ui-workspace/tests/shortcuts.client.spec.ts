/** Workspace commands capture their business target before the dispatcher executes them. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { SessionListState, SessionSummary, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationTimelineSnapshot, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq, type SessionId } from '@deepseek-ai/dsh-session/types'
import type { ShortcutCommand, ShortcutGesture } from '@deepseek-ai/dsh-client-shortcuts/client'
import { ShortcutRegistry } from '../../shortcuts/src/client/registry.ts'
import { createWorkspaceShortcutControls, installWorkspaceShortcuts } from '../src/client/shortcuts.ts'
import type { UiWorkspace } from '../src/client/navigation.ts'
import { en, zh } from '../src/client/locales.ts'

const sid = (value: string) => value as SessionId
const context = { region: 'page', modal: null, target: null } as const
const key = (code: string, rest: Partial<ShortcutGesture> = {}): ShortcutGesture => ({
  code, control: false, alt: false, shift: false, meta: true, repeat: false,
  composing: false, defaultPrevented: false, ...rest,
})
const row = (id: string, main = false): SessionSummary => ({
  id: sid(id), title: id, displayTitle: id, cwd: `/workspace/${id}`, blank: false,
  running: false, updatedAt: 0, retainedBy: main ? { mainView: 1 } : {},
})
function turns(ended: number | undefined, open = false): ConversationTimelineSnapshot {
  const rows: [number, TurnLocation][] = ended === undefined ? [] : [[1, {
    turn: 1, status: 'closed', start: undefined,
    end: { type: 'turn/end', seq: SessionSeq(ended), time: 0, data: { turn: 1, reason: { kind: 'completed' } } },
    steps: [], data: { get: () => undefined, source: () => createSnapshotStore(undefined) },
  }]]
  if (open) rows.push([2, { turn: 2, status: 'open', start: {
    type: 'turn/start', seq: SessionSeq(10), time: 0, data: { turn: 2 },
  }, end: undefined, steps: [], data: { get: () => undefined, source: () => createSnapshotStore(undefined) } }])
  return { turnOrder: rows.map(([turn]) => turn), turns: new Map(rows) }
}

async function bench(runtime: 'web' | 'desktop' = 'desktop') {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const registry = new ShortcutRegistry(runtime, 'macos')
  const commands = new Map<string, ShortcutCommand>()
  ctx.provide('shortcuts', { register: (command: ShortcutCommand) => {
    commands.set(command.id, command)
    return registry.register(command)
  }, catalog: registry.catalog })
  const list = createSnapshotStore<SessionListState>({
    ids: [sid('a'), sid('b')], byId: { [sid('a')]: row('a', true), [sid('b')]: row('b') },
    phase: 'ready', projectionsBySession: {},
  })
  const timeline = createSnapshotStore(turns(undefined))
  const history = createSnapshotStore({ openState: 'open', hasMore: false, loadingOlder: false } as SessionSnapshot)
  const loadOlder = vi.fn(async () => {})
  const bindings = new Map(['a', 'b'].map(id => [sid(id), {
    sessionId: sid(id), session: { ...history, loadOlder },
  }]))
  ctx.provide('sessions', { list, binding: (id: SessionId) => bindings.get(id) })
  const historyStart = createSnapshotStore(SessionSeq(100))
  ctx.provide('uiConversation', { binding: () => ({ timeline, historyStart }) })
  const directory = createSnapshotStore(true)
  ctx.provide('slots', { entries: () => directory.getSnapshot() ? [{}] : [], subscribe: (_name: string, listener: () => void) => directory.subscribe(listener) })
  const locale = new LocaleRuntime(ctx)
  locale.register('workspace', { en, zh })
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const navigation = { startSession: vi.fn(), forkSession: vi.fn(async () => {}), archiveSession: vi.fn(async () => {}) }
  const controls = createWorkspaceShortcutControls()
  const fiber = ctx.plugin((scoped) => { installWorkspaceShortcuts(scoped, navigation as unknown as UiWorkspace, controls, navigation.archiveSession) })
  await fiber.await()
  const select = (id: string) => { list.set({ ...list.getSnapshot(), byId: {
    [sid('a')]: row('a', id === 'a'), [sid('b')]: row('b', id === 'b'),
  } }) }
  return { ctx, fiber, registry, commands, navigation, controls, list, timeline, directory, select, history, loadOlder, historyStart }
}

afterEach(() => { vi.restoreAllMocks() })

describe('workspace shortcut ownership', () => {
  it('registers six commands with Desktop and Web defaults and removes registrations with the plugin', async () => {
    const b = await bench()
    expect(b.registry.catalog.getSnapshot().map(row => row.id)).toEqual([
      'session.new', 'session.search', 'workspace.add', 'session.rename', 'session.fork', 'session.archive',
    ])
    expect(b.registry.catalog.getSnapshot().every(row => row.keys.length > 0)).toBe(true)
    const web = await bench('web')
    expect(web.registry.catalog.getSnapshot().map(row => row.aria)).toEqual([
      'Alt+Meta+N', 'Alt+Meta+K', 'Alt+Meta+O', 'Shift+Meta+R', 'Shift+Meta+F', 'Alt+Meta+A',
    ])
    await b.fiber.dispose()
    expect(b.registry.catalog.getSnapshot()).toEqual([])
  })

  it('uses the owner for new/search/add from terminals and modals while preserving repeat and directory occupancy', async () => {
    const b = await bench()
    const consume = vi.fn()
    expect(b.registry.dispatch(key('KeyN'), context, consume).status).toBe('handled')
    b.registry.dispatch(key('KeyN', { repeat: true }), context, consume)
    expect(b.navigation.startSession).toHaveBeenCalledOnce()
    expect(b.registry.dispatch(key('KeyN'), { ...context, modal: 'settings' }, consume).status).toBe('handled')
    expect(b.registry.dispatch(key('KeyN'), { ...context, region: 'terminal' }, consume).status).toBe('handled')
    expect(b.navigation.startSession).toHaveBeenCalledTimes(3)
    b.registry.dispatch(key('KeyK'), context, consume)
    expect(b.controls.state.getSnapshot().searchRequest).toBe(1)
    b.registry.dispatch(key('KeyO'), context, consume)
    expect(b.controls.state.getSnapshot().addRequested).toBe(true)
    b.controls.closeAdd()
    b.controls.directoryBusy(true)
    expect(b.registry.dispatch(key('KeyO'), context, consume).status).toBe('blocked')
    expect(b.controls.state.getSnapshot().addRequested).toBe(false)
    b.controls.directoryBusy(false)
    b.directory.set(false)
    expect(b.registry.dispatch(key('KeyO'), context, consume).status).toBe('blocked')
  })

  it('captures rename and archive targets while the main Session changes', async () => {
    const b = await bench()
    for (const command of ['session.rename', 'session.archive']) {
      b.select('a')
      const resolution = b.commands.get(command)!.resolve(context)
      b.select('b')
      expect(resolution.status).toBe('handled')
      if (resolution.status === 'handled') resolution.run()
    }
    expect(b.controls.state.getSnapshot().renameTarget).toEqual({ sessionId: 'a', currentTitle: 'a' })
    expect(b.navigation.archiveSession).toHaveBeenCalledWith('a')
  })

  it('loads older pages until a completed turn is found without treating the tail as complete history', async () => {
    const b = await bench()
    b.timeline.set(turns(undefined, true))
    b.loadOlder.mockImplementationOnce(async () => { b.historyStart.set(SessionSeq(50)) })
      .mockImplementationOnce(async () => { b.timeline.set(turns(5, true)) })
    b.history.set({ ...b.history.getSnapshot(), hasMore: true })
    await vi.waitFor(() => { expect(b.loadOlder).toHaveBeenCalledTimes(2) })
    expect(b.registry.dispatch(key('KeyF', { alt: true }), context, vi.fn()).status).toBe('handled')
    expect(b.navigation.forkSession).toHaveBeenCalledWith('a', 5)
  })

  it('stops history paging after navigation or a page that made no progress', async () => {
    const b = await bench()
    b.history.set({ ...b.history.getSnapshot(), hasMore: true })
    await vi.waitFor(() => { expect(b.loadOlder).toHaveBeenCalledOnce() })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.loadOlder).toHaveBeenCalledOnce()
    const c = await bench()
    let finish!: () => void
    c.loadOlder.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    c.history.set({ ...c.history.getSnapshot(), hasMore: true })
    c.select('b')
    finish()
    await vi.waitFor(() => { expect(c.loadOlder).toHaveBeenCalledTimes(2) })

  })

  it('refuses a first open turn and captures the last ended turn before another turn ends', async () => {
    const b = await bench()
    b.timeline.set(turns(undefined, true))
    expect(b.registry.dispatch(key('KeyF', { alt: true }), context, vi.fn()).status).toBe('blocked')
    b.timeline.set(turns(5, true))
    const resolution = b.commands.get('session.fork')!.resolve(context)
    b.timeline.set(turns(20))
    b.select('b')
    if (resolution.status !== 'handled') throw new Error('completed turn was unavailable')
    resolution.run()
    expect(b.navigation.forkSession).toHaveBeenCalledWith('a', 5)
  })
})
