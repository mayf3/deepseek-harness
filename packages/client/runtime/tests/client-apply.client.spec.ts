/**
 * Runtime plugin browser-half apply: slots + object services mounting over the
 * connection handle, Remote stream wiring into the object layer, and
 * fiber-scoped stream teardown.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-api-session-controller/client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import * as RuntimeClient from '../src/client/index.ts'
import type { ConversationNodeDefinition } from '../src/client/contract/conversation.ts'
import { scopeOf } from '../src/client/agents/scope.ts'
import { Session } from '../src/client/sessions/session.ts'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import { FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'

interface Bench {
  ctx: Context
  api: FakeApiClient
  runtime: { dispose(): Promise<void> }
  start: ReturnType<typeof vi.fn<ConnectionHandle['start']>>
  dispatchRemote(event: string, args: readonly unknown[]): void
}

async function mount(configure?: (api: FakeApiClient) => void): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  const api = new FakeApiClient()
  configure?.(api)
  const listeners = new Map<string, Set<(...args: never[]) => void>>()
  const dispatchRemote = (event: string, args: readonly unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args as never[])
  }
  const start = vi.fn<ConnectionHandle['start']>(() => ({ stop: () => {} }))
  const handle: ConnectionHandle = {
    api,
    isLoopback: true,
    hostDescription: {
      getSnapshot: () => undefined,
      subscribe: () => () => {},
    },
    rpc: {
      call: () => Promise.reject(new Error('unexpected generic RPC call')),
    },
    registerGenerationSource: () => () => {},
    start,
  }
  const remote = fakeRemote(api)
  ctx.reflect.provide('connection', handle)
  ctx.reflect.provide('remote', {
    ...remote,
    $on: (event: string, listener: (...args: never[]) => void) => {
      const eventListeners = listeners.get(event) ?? new Set()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
      return () => { eventListeners.delete(listener) }
    },
  })
  ctx.reflect.provide('remote.commands', remote.commands)
  ctx.reflect.provide('remote.session', remote.session)
  ctx.reflect.provide('remote.workspace', remote.workspace)
  const runtime = await ctx.plugin(RuntimeClient).await()
  return { ctx, api, runtime, start, dispatchRemote }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}

describe('runtime client apply', () => {
  it('materializes Host-addressed Agent scopes before the Session list arrives', async () => {
    const bench = await mount()
    const adapter = bench.ctx.typert.contexts.getClient('agent')
    const first = adapter?.resolve('s-early')

    expect(first).toBeDefined()
    expect(scopeOf(first as Context)).toBe('s-early')
    expect(adapter?.resolve('s-early')).toBe(first)
  })

  it('refreshes Sessions on every Gateway connection generation', async () => {
    const refresh = vi.spyOn(SessionRuntime.prototype, 'handleConnected')
    const bench = await mount()

    bench.ctx.emit('connection/reset')
    bench.ctx.emit('connection/reset')

    expect(refresh).toHaveBeenCalledTimes(2)
    refresh.mockRestore()
  })

  it('mounts slots, Sessions, and Workspaces and routes their independent streams', async () => {
    const bench = await mount()
    expect(bench.ctx.get('slots') !== undefined).toBe(true)
    // The built-in 'root' declaration ships with this package's SlotRegistry
    // (the SlotMap 'root' merge lives here).
    expect(bench.ctx.slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
    const sessions = bench.ctx.get('sessions')
    const workspaces = bench.ctx.get('workspaces')
    expect(sessions !== undefined).toBe(true)
    expect(workspaces !== undefined).toBe(true)
    // The bound the wire schema enforces, not a per-connection negotiation.
    expect((sessions as SessionRuntime).searchResultLimit).toBe(SESSION_SEARCH_RESULT_LIMIT)
    if (workspaces === undefined) throw new Error('WorkspaceRuntime missing after runtime apply')
    expect(bench.start).not.toHaveBeenCalled()

    // Session Remote events reach the object layer and land in the list store.
    bench.dispatchRemote('api-session/added', [{
      sessionId: 's-new', updatedAt: 1, running: false, blank: true,
    }])
    await Promise.resolve()
    expect((sessions as { list: { getSnapshot(): { ids: string[] } } }).list.getSnapshot().ids).toContain('s-new')
    await flushMicrotasks()
    bench.api.pushWorkspace({
      type: 'upsert',
      workspace: {
        workspaceId: 'w-new' as never, path: '/w/new', title: 'new', sessionIds: [],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    await flushMicrotasks()
    expect(workspaces.list.getSnapshot().items[0]?.workspaceId).toBe('w-new')
    // Gateway generation publication routes without throwing.
    bench.ctx.emit('connection/reset')
  })

  it('selects the recent Workspace once when the first baselines have no current session', async () => {
    const bench = await mount((api) => {
      api.workspaceBaseline = {
        items: [{
          workspaceId: 'w-recent', path: '/w/recent', title: 'recent', sessionIds: [],
          createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        }] as never[],
        archivedSessionIds: [],
      }
      api.onList = () => Promise.resolve(ok({ items: [] }))
    })

    bench.ctx.emit('connection/reset')

    const sessions = bench.ctx.get('sessions') as SessionRuntime
    await vi.waitFor(() => {
      expect(bench.api.callsOf('session.create')).toEqual([{ workspaceId: 'w-recent' }])
    })
    expect(sessions.list.getSnapshot().current).toBe('fk-new')

    sessions.clear()
    bench.api.pushWorkspace({
      type: 'upsert',
      workspace: bench.api.workspaceBaseline.items[0] as never,
    })
    await flushMicrotasks()
    expect(sessions.list.getSnapshot().current).toBeUndefined()
    expect(bench.api.callsOf('session.create')).toHaveLength(1)
  })

  it('wires registry changes into resident Sessions during the runtime apply pass', async () => {
    const bench = await mount()
    const sessions = bench.ctx.get('sessions') as SessionRuntime
    bench.dispatchRemote('api-session/added', [{
      sessionId: 's-registry', updatedAt: 1, running: false, blank: true,
    }])
    await flushMicrotasks()
    expect(sessions.binding('s-registry' as never)).toBeDefined()
    const rebuild = vi.spyOn(Session.prototype, 'rebuildConversationRegistry')
    const definition: ConversationNodeDefinition<null> = {
      kind: 'registry-probe',
      target: 'chat',
      match: () => null,
      start: () => null,
      update: context => context.state,
      buildViewNode: () => null,
    }

    bench.ctx.conversationEvents.register(definition)
    await flushMicrotasks()

    expect(rebuild).toHaveBeenCalledOnce()
    rebuild.mockRestore()
  })

  it('does not own the Connection loop and closes its Remote streams on unload', async () => {
    const bench = await mount()
    const sessions = bench.ctx.get('sessions') as SessionRuntime
    bench.dispatchRemote('api-session/added', [{
      sessionId: 's-open', updatedAt: 1, running: false, blank: false,
    }])
    await flushMicrotasks()
    sessions.open('s-open' as never)
    await vi.waitFor(() => { expect(bench.api.activeFollows('s-open' as never)).toBe(1) })

    await bench.runtime.dispose()

    expect(bench.start).not.toHaveBeenCalled()
    expect(bench.api.activeFollows('s-open' as never)).toBe(0)
  })
})
