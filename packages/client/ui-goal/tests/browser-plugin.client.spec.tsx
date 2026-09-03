// @vitest-environment jsdom
/**
 * ui-goal browser half on a real cordis Context with fake slots/api/
 * sessions faces: the plugin registers the GoalBar dock entry at
 * conversation.input.dock, the inject face's four verbs read the CAS ref
 * from the session's CURRENT projected value at call time (no fence — the
 * Remote method's compare-and-set is the guard), a missing projection short-circuits
 * to the no-current-goal error without touching the wire, and a Remote failure
 * reaches the strip verbatim. Registration disposal rides the
 * plugin fiber (HMR safety), and the node half stays inert.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GoalActivation, GoalProjection, GoalView } from '@deepseek-ai/dsh-goal/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { GoalBarActions, GoalBarInjected } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { GoalDock } from '../src/client/GoalBar.tsx'
import { zh } from '../src/client/locales.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

const sid = (k: string): SessionId => k as SessionId

function makeProjection(revision = 3): GoalProjection {
  return {
    goal: {
      id: 'g-1' as GoalProjection['goal']['id'],
      revision,
      objective: 'Ship it',
      phase: 'active',
      maxGoalRounds: 8,
    },
    roundsStarted: 1,
    createdAt: 10,
    updatedAt: 20,
  }
}

/** Boot the plugin over fake faces; Goal Remote methods record arguments and answer per the script. */
async function bench(options: {
  projection?: GoalProjection | null | undefined
  activation?: GoalActivation
  failWith?: RemoteFailure
} = {}) {
  const ctx = new Context()
  const calls: { method: string; args: unknown[] }[] = []
  const sessions = {
    binding: (id: SessionId) => ({
      sessionId: id,
      session: { projections: { faceOf: (key: string) => ({
        getSnapshot: () => (key === 'goal' ? options.projection : undefined),
        subscribe: () => () => {},
      }) } },
      ctx,
    }),
  }
  ctx.provide('sessions', sessions)
  const conversationEvents = new UiConversation(ctx, sessions as never).events
  function answer<T>(method: string, value: T) {
    return (...args: unknown[]) => {
      calls.push({ method, args })
      if (options.failWith !== undefined) return Promise.resolve({ ok: false, error: options.failWith })
      return Promise.resolve({ ok: true, value })
    }
  }
  const ref = { id: 'g-1', revision: 3 }
  const goalView = (): GoalView | undefined => {
    if (options.projection === null || options.projection === undefined) return undefined
    return {
      ...options.projection.goal,
      roundsStarted: options.projection.roundsStarted,
      createdAt: options.projection.createdAt,
      updatedAt: options.projection.updatedAt,
      activation: options.activation ?? 'armed',
    }
  }
  const goals = (prefix: string) => ({
    get: answer(`${prefix}/get`, goalView()),
    edit: answer(`${prefix}/edit`, { ref }),
    pause: answer(`${prefix}/pause`, { ref }),
    resume: answer(`${prefix}/resume`, { ref }),
    clear: answer(`${prefix}/clear`, ref),
  })
  let activeGoals: ReturnType<typeof goals> | undefined = goals('goals')
  class RemoteService extends Service {
    readonly activationListeners = new Set<(event: {
      sessionId: SessionId
      goal?: { id: string; revision: number; activation: GoalActivation }
    }) => void>()

    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }

    $on(_event: string, listener: (event: {
      sessionId: SessionId
      goal?: { id: string; revision: number; activation: GoalActivation }
    }) => void): () => void {
      this.activationListeners.add(listener)
      return () => { this.activationListeners.delete(listener) }
    }

    emitActivation(
      sessionId: SessionId,
      goal: { id: string; revision: number; activation: GoalActivation } | undefined,
    ): void {
      for (const listener of this.activationListeners) {
        listener({ sessionId, ...goal === undefined ? {} : { goal } })
      }
    }
  }
  const remote = new RemoteService(ctx)
  ctx.provide('remote.goals', {
    get get() { return activeGoals?.get },
    get edit() { return activeGoals?.edit },
    get pause() { return activeGoals?.pause },
    get resume() { return activeGoals?.resume },
    get clear() { return activeGoals?.clear },
  })
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root', children: {
      'conversation.input.dock': { kind: 'list', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    },
  } as never, (() => null) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx,
    fiber,
    calls,
    emitActivation: remote.emitActivation.bind(remote),
    definitions: () => conversationEvents.entries(),
    remountGoals: () => { activeGoals = goals('remounted-goals') },
    unmountGoals: () => { activeGoals = undefined },
    entry: () => {
      const entry = ctx.slots.entries('conversation.input.dock')[0]
      if (entry === undefined) return undefined
      return {
        ...entry.options,
        locale: entry.locale,
        inject: entry.inject as unknown as ((sessionId: SessionId) => GoalBarInjected) | undefined,
      }
    },
    chatEntry: () => ctx.slots.entries('conversation.chat.node')[0],
  }
}

describe('ui-goal browser plugin', () => {
  it('registers the GoalBar dock, command input Definition, and keyed Chat renderer', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()).toMatchObject({ id: 'goal', order: 10, locale: 'goal' })
    expect(b.entry()?.inject).toBeTypeOf('function')
    expect(b.definitions().map(definition => definition.kind)).toEqual(['goal-command-input'])
    expect(b.chatEntry()?.options).toMatchObject({ key: 'command-input' })
    expect(b.chatEntry()?.locale).toBe('goal')
  })

  it('verbs read the CAS ref from the current projected value at call time', async () => {
    const b = await bench({ projection: makeProjection(5) })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    // The strip forwards the Remote value verbatim; `answered` is the fake's
    // reply, unrelated to the CAS ref the call carries.
    const answered = { id: 'g-1', revision: 3 }
    expect(await verbs.onEdit('New objective')).toEqual({ ok: true, value: { ref: answered } })
    expect(await verbs.onPause()).toEqual({ ok: true, value: { ref: answered } })
    expect(await verbs.onResume()).toEqual({ ok: true, value: { ref: answered } })
    expect(await verbs.onClear()).toEqual({ ok: true, value: answered })
    expect(b.calls.map(c => c.method)).toEqual(['goals/edit', 'goals/pause', 'goals/resume', 'goals/clear'])
    const ref = { id: 'g-1', revision: 5 }
    expect(b.calls[0]?.args).toEqual(['s1', ref, { objective: 'New objective' }])
    expect(b.calls[1]?.args).toEqual(['s1', ref])
    expect(b.calls[2]?.args).toEqual(['s1', ref])
    expect(b.calls[3]?.args).toEqual(['s1', ref])
  })

  it('verbs read a remounted Remote namespace at action time', async () => {
    const b = await bench({ projection: makeProjection() })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    b.remountGoals()

    expect(await verbs.onPause()).toEqual({ ok: true, value: { ref: { id: 'g-1', revision: 3 } } })
    expect(b.calls).toMatchObject([{ method: 'remounted-goals/pause' }])
  })

  it('reads the live goal and forwards only this session activation events', async () => {
    const b = await bench({ projection: makeProjection(), activation: 'disarmed' })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))

    expect(await verbs.getGoal()).toMatchObject({
      ok: true,
      value: { id: 'g-1', revision: 3, activation: 'disarmed' },
    })
    expect(b.calls.at(-1)).toMatchObject({ method: 'goals/get', args: ['s1'] })

    const seen: Array<{ id: string; revision: number; activation: GoalActivation } | undefined> = []
    const dispose = verbs.subscribeActivation((goal) => { seen.push(goal) })
    b.emitActivation(sid('s2'), { id: 'g-1', revision: 3, activation: 'armed' })
    expect(seen).toEqual([])
    b.emitActivation(sid('s1'), { id: 'g-1', revision: 3, activation: 'armed' })
    b.emitActivation(sid('s1'), undefined)
    expect(seen).toEqual([
      { id: 'g-1', revision: 3, activation: 'armed' },
      undefined,
    ])
    dispose()
    b.emitActivation(sid('s1'), { id: 'g-1', revision: 3, activation: 'disarmed' })
    expect(seen).toHaveLength(2)
  })

  it('rejects every verb once the Remote namespace is gone', async () => {
    const b = await bench({ projection: makeProjection() })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    b.unmountGoals()

    // A missing namespace is an assembly fault, not a call outcome: this plugin
    // declares remote.goals in `inject`, so cordis disposes the dock entry along
    // with the namespace. Only a React closure that outlived that disposal can
    // reach these verbs, so no consumer-side guard renders it as an error.
    for (const verb of [() => verbs.onEdit('x'), () => verbs.onPause(), () => verbs.onResume(), () => verbs.onClear()]) {
      await expect(verb()).rejects.toThrow(TypeError)
    }
    expect(b.calls).toHaveLength(0)
  })

  it('a null or absent projection short-circuits every verb without touching the wire', async () => {
    for (const projection of [null, undefined]) {
      const b = await bench({ projection })
      await b.fiber.await()
      const verbs = b.entry()!.inject!(sid('s1'))
      for (const result of [await verbs.onEdit('x'), await verbs.onPause(), await verbs.onResume(), await verbs.onClear()]) {
        expect(result).toEqual({ ok: false, error: { code: 'no-current-goal', message: 'no current goal to mutate' } })
      }
      expect(b.calls).toHaveLength(0)
    }
  })

  it('forwards a Remote failure to the strip verbatim', async () => {
    const b = await bench({
      projection: makeProjection(),
      failWith: new RemoteError('gateway/internal', 'stale revision', {}),
    })
    await b.fiber.await()
    const verbs = b.entry()!.inject!(sid('s1'))
    expect(await verbs.onEdit('x')).toMatchObject({ ok: false, error: { code: 'gateway/internal', message: 'stale revision' } })
  })

  it('drops the dock entry when the plugin fiber unloads (HMR safety)', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()).toBeDefined()
    expect(b.chatEntry()).toBeDefined()
    expect(b.definitions()).toHaveLength(1)
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
    expect(b.chatEntry()).toBeUndefined()
    expect(b.definitions()).toHaveLength(0)
  })
})

describe('GoalDock adapter', () => {
  it('renders the projected goal snapshot and nothing for absent/null', () => {
    const projection = makeProjection()
    const useProjection = vi.fn(() => projection)
    const useSession = vi.fn((selector: (snapshot: { running: boolean }) => boolean) => selector({ running: true }))
    const actions: GoalBarActions = {
      onEdit: () => Promise.resolve({ ok: true, value: undefined }),
      onPause: () => Promise.resolve({ ok: true, value: undefined }),
      onResume: () => Promise.resolve({ ok: true, value: undefined }),
      onClear: () => Promise.resolve({ ok: true, value: undefined }),
    }
    const subscribeActivation = vi.fn(() => () => {})
    const getGoal = vi.fn(() => Promise.resolve({
      ok: true as const,
      value: {
        ...projection.goal,
        roundsStarted: projection.roundsStarted,
        createdAt: projection.createdAt,
        updatedAt: projection.updatedAt,
        activation: 'armed' as const,
      },
    }))
    const t = makeTranslate(zh, commonZh)
    const dockProps = (up: () => GoalProjection | null | undefined) =>
      ({ useProjection: up, useSession, getGoal, subscribeActivation, ...actions, t }) as unknown as Parameters<typeof GoalDock>[0]
    const shown = render(<GoalDock {...dockProps(useProjection)} />)
    expect(shown.getByText('Ship it')).toBeTruthy()
    cleanup()

    const empty = render(<GoalDock {...dockProps(() => null)} />)
    expect(empty.container.firstChild).toBeNull()
    cleanup()

    const absent = render(<GoalDock {...dockProps(() => undefined)} />)
    expect(absent.container.firstChild).toBeNull()
  })

  it('overlays live activation from reads and subscriptions', async () => {
    const projection = makeProjection()
    const actions: GoalBarActions = {
      onEdit: () => Promise.resolve({ ok: true, value: undefined }),
      onPause: () => Promise.resolve({ ok: true, value: undefined }),
      onResume: () => Promise.resolve({ ok: true, value: undefined }),
      onClear: () => Promise.resolve({ ok: true, value: undefined }),
    }
    const t = makeTranslate(zh, commonZh)
    const useProjection = vi.fn(() => projection)
    const useSession = vi.fn((selector: (snapshot: { running: boolean }) => boolean) => selector({ running: false }))
    let pushActivation: ((goal: { id: string; revision: number; activation: GoalActivation } | undefined) => void) | undefined
    const subscribeActivation = vi.fn((
      listener: (goal: { id: string; revision: number; activation: GoalActivation } | undefined) => void,
    ) => {
      pushActivation = listener
      return () => { pushActivation = undefined }
    })
    const getGoal = vi.fn()
    const props = () => ({
      useProjection, useSession, getGoal, subscribeActivation, ...actions, t,
    }) as unknown as Parameters<typeof GoalDock>[0]

    let resolveRead!: (value: unknown) => void
    getGoal.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve }))
    const abandoned = render(<GoalDock {...props()} />)
    abandoned.unmount()
    await act(async () => {
      resolveRead({ ok: true, value: undefined })
    })

    getGoal.mockResolvedValueOnce({
      ok: false,
      error: new RemoteError('gateway/internal', 'read failed', {}),
    })
    const failed = render(<GoalDock {...props()} />)
    await waitFor(() => { expect(getGoal).toHaveBeenCalledTimes(2) })
    expect(failed.getByText('进行中的目标')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '暂停目标' })).toBeNull()
    failed.unmount()

    getGoal.mockResolvedValueOnce({
      ok: true,
      value: {
        ...projection.goal,
        revision: 4,
        roundsStarted: projection.roundsStarted,
        createdAt: projection.createdAt,
        updatedAt: projection.updatedAt,
        activation: 'armed',
      },
    })
    const stale = render(<GoalDock {...props()} />)
    await waitFor(() => { expect(getGoal).toHaveBeenCalledTimes(3) })
    expect(stale.queryByRole('button', { name: '暂停目标' })).toBeNull()
    stale.unmount()

    getGoal.mockResolvedValueOnce({
      ok: true,
      value: {
        ...projection.goal,
        roundsStarted: projection.roundsStarted,
        createdAt: projection.createdAt,
        updatedAt: projection.updatedAt,
        activation: 'armed',
      },
    })
    const rendered = render(<GoalDock {...props()} />)
    await waitFor(() => { expect(screen.getByRole('button', { name: '暂停目标' })).toBeTruthy() })

    act(() => {
      pushActivation?.({ id: 'g-1', revision: 4, activation: 'disarmed' })
    })
    expect(rendered.getByRole('button', { name: '暂停目标' })).toBeTruthy()

    act(() => {
      pushActivation?.({ id: 'g-1', revision: 3, activation: 'disarmed' })
    })
    expect(rendered.getByText('未运行的目标')).toBeTruthy()
    expect(rendered.getByRole('button', { name: '恢复目标' })).toBeTruthy()

    act(() => {
      pushActivation?.(undefined)
    })
    expect(rendered.getByText('进行中的目标')).toBeTruthy()
    expect(rendered.queryByRole('button', { name: '恢复目标' })).toBeNull()
  })
})

describe('ui-goal node half', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
