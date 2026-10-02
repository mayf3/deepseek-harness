import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { LoadedMod } from '../src/chain.ts'
import { ModsEngine, OpDenied } from '../src/engine.ts'
import { readModManifest } from '../src/manifest.ts'
import { createOn, HookRegistry, loadHooksModule } from '../src/module.ts'
import type { AnyHook, HookRegistration, ModsApi } from '../src/types.ts'

const FIXTURES = resolve(import.meta.dirname, 'fixtures')
const mod = (name: string, order = 0): LoadedMod => ({ name, version: undefined, root: '/mods/' + name, modulePath: '', options: {}, order })
const noop: AnyHook = (_$, e, next) => next(e)

describe('createOn', () => {
  it('collects registrations in order, with matchers and .catch handlers', () => {
    const owner = mod('a')
    const { on, hooks } = createOn(owner)
    const handler: AnyHook = () => ({ deny: 'closed' })
    on('tool.call', noop).catch(handler)
    on('tool.call', { tool: 'Bash' }, noop)
    on('ui.render', { component: 'Spinner' }, noop)
    expect(hooks.map(hook => [hook.event, hook.matcher])).toEqual([['tool.call', undefined], ['tool.call', { tool: 'Bash' }], ['ui.render', { component: 'Spinner' }]])
    expect(hooks[0]?.catchHandler).toBe(handler)
    expect(hooks.every(hook => hook.mod === owner)).toBe(true)
  })

  it('refuses what claude plugin validate refuses', () => {
    const { on } = createOn(mod('a'))
    // A JavaScript mod can pass anything, so the checks are exercised through an untyped call.
    const loose = on as (...args: unknown[]) => HookRegistration
    expect(() => on('tool.call', noop)).not.toThrow()
    expect(() => loose(42, noop)).toThrow(/not a string literal/)
    expect(() => on('tool.calls', noop)).toThrow(/"tool.calls" is not an event/)
    expect(() => on('session.start', noop)).not.toThrow()
    expect(() => on('session.start', noop)).toThrow(/on\("session.start"\) is registered twice without a matcher/)
    expect(() => on('session.start', { cwd: '/x' }, noop)).not.toThrow()
    expect(() => loose('turn.start', 'nope')).toThrow(/needs a hook function/)
    expect(() => loose('turn.start', 'nope', noop)).toThrow(/matcher must be an object/)
    const registration = on('turn.complete', noop)
    const attach = registration.catch.bind(registration) as (handler: unknown) => void
    expect(() => { attach('nope') }).toThrow(/needs a handler function/)
  })
})

describe('HookRegistry', () => {
  it('orders hooks by mod load then registration, scopes op events to earlier mods, and describes a mod', () => {
    const registry = new HookRegistry()
    const a = mod('a', 0)
    const b = mod('b', 1)
    const onA = createOn(a)
    onA.on('tool.call', noop)
    onA.on('fs.read', noop)
    const onB = createOn(b)
    onB.on('tool.call', { tool: 'Bash' }, noop)
    onB.on('fs.read', noop)
    onB.on('*', noop)
    registry.add(b, onB.hooks)
    registry.add(a, onA.hooks)
    expect(registry.list().map(m => m.name)).toEqual(['b', 'a'])
    expect(registry.select('tool.call').map(hook => hook.mod.name)).toEqual(['a', 'b', 'b'])
    expect(registry.select('fs.read', b).map(hook => hook.mod.name)).toEqual(['a'])
    expect(registry.select('fs.read', a).map(hook => hook.mod.name)).toEqual([])
    const c = mod('c', 2)
    expect(registry.select('fs.read', c).map(hook => hook.mod.name)).toEqual(['a', 'b', 'b'])
    expect(registry.describe(b)).toBe('tool.call{tool=Bash}, fs.read, *')
    expect(() => { registry.add(mod('a', 5), []) }).toThrow(/another plugin of that name loads first/)
    registry.remove('b')
    registry.remove('nobody')
    expect(registry.select('tool.call').map(hook => hook.mod.name)).toEqual(['a'])
    expect(registry.list().map(m => m.name)).toEqual(['a'])
  })
})

describe('loadHooksModule', () => {
  it('imports the fixture module and runs register with the resolved options', async () => {
    const directory = readModManifest('first-mod', FIXTURES)
    const { mod: loaded, hooks } = await loadHooksModule(directory, { greeting: 'hi' }, 3)
    expect(loaded).toMatchObject({ name: 'first-mod', version: '0.1.0', root: directory.root, modulePath: directory.modulePath, order: 3, options: { greeting: 'hi' } })
    expect(hooks.map(hook => hook.event)).toEqual(['session.start', 'tool.call', 'command.run', 'ui.render'])
  })

  it('reports a module without register, a register that throws, and an import that fails', async () => {
    await expect(loadHooksModule(readModManifest('no-register', FIXTURES), {}, 0)).rejects.toThrow(/does not export a register function/)
    await expect(loadHooksModule(readModManifest('broken-mod', FIXTURES), {}, 0)).rejects.toThrow(/register threw .*"tool.calls" is not an event/)
    const missing = { ...readModManifest('first-mod', FIXTURES), modulePath: resolve(FIXTURES, 'first-mod/hooks/absent.js') }
    await expect(loadHooksModule(missing, {}, 0)).rejects.toThrow(/hooks module did not load/)
  })
})

describe('ModsEngine', () => {
  function engine(ops: Record<string, (input: unknown) => unknown> = {}, report = vi.fn()) {
    return {
      engine: new ModsEngine<{ key: string }>({ ops: op => ops[op], stateKey: b => b.key, budgetMs: 200, catchBudgetMs: 100, report }),
      report,
    }
  }

  it('keeps $.state per session key and answers clock.now and clock.sleep itself', async () => {
    const { engine: e } = engine()
    const owner = mod('a')
    const first = e.api(owner, undefined, { key: 's1' }, new AbortController().signal)
    const second = e.api(owner, undefined, { key: 's2' }, new AbortController().signal)
    const ref = { plugin: 'a', key: 'readings' }
    expect(await first.state.get(ref)).toEqual({ value: undefined })
    await first.state.set(ref, [1, 2])
    await first.state.set({ plugin: 'a', key: 'other' }, 'o')
    expect(await first.state.get(ref)).toEqual({ value: [1, 2] })
    expect(await second.state.get(ref)).toEqual({ value: undefined })
    e.forgetState('s1')
    expect(await first.state.get(ref)).toEqual({ value: undefined })
    await expect(e.invoke(owner, 'state.get', { plugin: 1, key: 'x' }, { key: 's1' }, new AbortController().signal))
      .rejects.toThrow(/needs \{ plugin, key \} strings/)
    const before = Date.now()
    expect(await first.clock.now()).toBeGreaterThanOrEqual(before)
    await first.clock.sleep(1)
    await expect(first.clock.sleep(-1)).rejects.toThrow(/non-negative/)
    await expect(first.fs.read('x')).rejects.toThrow('no implementation for fs.read')
  })

  it('serves ops from the resolver, lets earlier mods intercept, and maps deny answers to rejections', async () => {
    const calls: string[] = []
    const { engine: e } = engine({
      'fs.read': (input) => { calls.push(JSON.stringify(input)); return 'contents' },
      'fs.write': () => { throw new OpDenied('read-only deployment') },
    })
    const policy = mod('policy', 0)
    const user = mod('user', 1)
    const onPolicy = createOn(policy)
    onPolicy.on('fs.read', (_$, event, next) => {
      const input = event as { path: string }
      if (input.path === '/secret') return { deny: 'policy: no secrets' }
      if (input.path === '/junk') return { nonsense: true }
      return next({ ...input, path: input.path + '.redirected' })
    })
    e.registry.add(policy, onPolicy.hooks)
    e.registry.add(user, [])
    const signal = new AbortController().signal
    const $ = e.api(user, undefined, { key: 's' }, signal)
    expect(await $.fs.read('/notes')).toBe('contents')
    expect(calls).toEqual(['{"path":"/notes.redirected","as":"text"}'])
    await expect($.fs.read('/secret')).rejects.toThrow('fs.read refused: policy: no secrets')
    await expect($.fs.read('/junk')).rejects.toThrow(/returned neither \{ value \} nor \{ deny \}/)
    await expect($.fs.write('/x', 'y')).rejects.toThrow('fs.write refused: read-only deployment')
    const $policy = e.api(policy, undefined, { key: 's' }, signal)
    expect(await $policy.fs.read('/secret')).toBe('contents')
    await expect(e.invoke(user, 'fs.read', { path: '/p' }, { key: 's' }, signal)).resolves.toBe('contents')
  })

  it('owns timers per mod: callbacks run and report failures, cancel stops them, unload and dispose clear them', async () => {
    vi.useFakeTimers()
    try {
      const { engine: e, report } = engine()
      const owner = mod('a')
      e.registry.add(owner, [])
      const $ = e.api(owner, undefined, { key: 's' }, new AbortController().signal)
      const ticks: string[] = []
      const once = $.clock.after(10, () => { ticks.push('after') })
      const every = $.clock.every(10, () => { ticks.push('every') })
      $.clock.after(10, () => { throw new Error('tick failed') })
      const cancelled = $.clock.after(5, () => { ticks.push('cancelled') })
      cancelled.cancel()
      await vi.advanceTimersByTimeAsync(25)
      expect(ticks).toEqual(['after', 'every', 'every'])
      expect(report).toHaveBeenCalledWith('a: timer callback failed: tick failed')
      once.cancel()
      every.cancel()
      await vi.advanceTimersByTimeAsync(20)
      expect(ticks).toEqual(['after', 'every', 'every'])
      $.clock.every(10, () => { ticks.push('late') })
      await e.unload('a')
      await vi.advanceTimersByTimeAsync(30)
      expect(ticks).toEqual(['after', 'every', 'every'])
      const again = mod('b')
      e.registry.add(again, [])
      const $b = e.api(again, undefined, { key: 's' }, new AbortController().signal)
      $b.clock.every(10, () => { ticks.push('b') })
      await e.dispose()
      // A `$` a mod kept schedules nothing after its mod unloaded.
      $b.clock.after(1, () => { ticks.push('late after') }).cancel()
      $b.clock.every(1, () => { ticks.push('late every') }).cancel()
      await vi.advanceTimersByTimeAsync(30)
      expect(ticks).toEqual(['after', 'every', 'every'])
      expect(e.registry.list()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('raises engine events through selected hooks with the engine origin and describes mods', async () => {
    const { engine: e } = engine()
    const owner = mod('a')
    const { on, hooks } = createOn(owner)
    let origin: unknown
    on('turn.start', ($: ModsApi, event, next) => {
      origin = next.origin
      expect($.plugin).toEqual({ name: 'a', root: '/mods/a' })
      return next(event)
    })
    e.registry.add(owner, hooks)
    const result = await e.raise('turn.start', { turnId: '1', text: 'hi' }, event => ({ turnId: (event as { turnId: string }).turnId }), { binding: { key: 's' } })
    expect(result).toEqual({ turnId: '1' })
    expect(origin).toEqual({ plugin: 'engine', tier: 'core' })
    expect(e.describe(owner)).toBe('turn.start')
  })
})
