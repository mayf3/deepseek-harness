/**
 * The `profileRuntime` service: profile facts, row ownership, user-disabled
 * rows, and recomposition through the root include entry.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type Entry, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { claimLayerIds, ProfileRuntime, type ComposedStack, type Profile, type ProfileLayer } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function layer(packageName: string, patches: PatchOptions[]): ProfileLayer {
  return { packageName, version: '2.0.0', packageDir: '/nowhere', patchPath: '/nowhere/p.yml', patches }
}

function profile(layers: ProfileLayer[]): Profile {
  return { name: 'web', dir: '/profiles/web', layers, patchPath: '/profiles/web/cordis.patch.yml', patches: [], patchReload: 'live' }
}

async function harness(
  layers: ProfileLayer[],
  options: { rootEntry?: () => Entry | undefined; reloaded?: Profile; conflicts?: ComposedStack['conflicts'] } = {},
): Promise<{ ctx: Context; runtime: ProfileRuntime; compose: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  // The conflicts, when given, belong to the reloaded profile only.
  const compose = vi.fn((current: Profile): ComposedStack => {
    const patches = [{ id: `composed-for-${current.layers.length}` }] as PatchOptions[]
    return {
      patches,
      layers: [{ label: 'stack', patches }],
      owners: claimLayerIds(current.layers).owners,
      conflicts: current === options.reloaded ? options.conflicts ?? [] : [],
      skippedBundles: [],
      userDisabledRowIds: new Set(current === options.reloaded ? ['reloaded-off'] : ['booted-off']),
    }
  })
  const booted = profile(layers)
  await ctx.plugin(ProfileRuntime, {
    profile: booted,
    stack: compose(booted),
    loadProfile: () => options.reloaded ?? profile(layers),
    compose,
    rootEntry: options.rootEntry ?? (() => undefined),
  })
  return { ctx, runtime: ctx.profileRuntime, compose }
}

describe('ProfileRuntime', () => {
  it('exposes the booted profile\'s facts', async () => {
    const { runtime } = await harness([layer('@deepseek-ai/dsh-base', [])])
    expect(runtime.profileName).toBe('web')
    expect(runtime.dir).toBe('/profiles/web')
    expect(runtime.patchPath).toBe('/profiles/web/cordis.patch.yml')
    expect(runtime.patchReload).toBe('live')
    expect(runtime.layers.map(l => l.packageName)).toEqual(['@deepseek-ai/dsh-base'])
    expect(runtime.current.name).toBe('web')
  })

  it('attributes rows to the layer that owns their id', async () => {
    const { runtime } = await harness([
      layer('@deepseek-ai/dsh-base', [{ insert: [{ id: 'settings', name: 'x' }, { name: 'anonymous' } as EntryOptions, { id: 'grp', name: 'cordis:group', group: true, config: [{ id: 'child', name: 'y' }] }] }]),
      layer('ext', [{ insert: [{ id: 'tool', name: 'ext' }] }]),
      layer('provider-ext', [{ insert: [{ id: 'svc', name: 'provider-ext' }] }]),
      // Declares an id the first external layer owns: left out whole, so none of its rows has an origin.
      layer('late', [{ insert: [{ id: 'tool', name: 'late' }, { id: 'late-only', name: 'late/x' }] }]),
    ])
    expect(runtime.originOf('settings')).toEqual({ packageName: '@deepseek-ai/dsh-base', version: '2.0.0' })
    expect(runtime.originOf('child')).toEqual({ packageName: '@deepseek-ai/dsh-base', version: '2.0.0' })
    expect(runtime.originOf('tool')).toEqual({ packageName: 'ext', version: '2.0.0' })
    expect(runtime.originOf('bundle/ext')).toBeUndefined()
    expect(runtime.originOf('svc')).toEqual({ packageName: 'provider-ext', version: '2.0.0' })
    expect(runtime.originOf('late-only')).toBeUndefined()
    expect(runtime.originOf('user-row')).toBeUndefined()
  })

  it('does not descend into a group row whose config is not a list', async () => {
    const { runtime } = await harness([
      layer('odd', [{ insert: [{ id: 'g', name: 'cordis:group', group: true, config: {} as never }] }]),
    ])
    expect(runtime.originOf('g')?.packageName).toBe('odd')
  })

  it('omits the version when the layer has none', async () => {
    const { runtime } = await harness([{ ...layer('local', [{ insert: [{ id: 'r', name: 'local' }] }]), version: undefined }])
    expect(runtime.originOf('r')).toEqual({ packageName: 'local' })
  })

  it('reports the user-disabled rows of the committed composition and keeps them when the include rejects an update', async () => {
    const entry = { options: { config: { path: 'file:///root/cordis.yml' } }, update: vi.fn(async () => { throw new Error('rejected') }) } as unknown as Entry
    const reloaded = profile([layer('a', []), layer('b', [])])
    const { runtime } = await harness([layer('a', [])], { rootEntry: () => entry, reloaded })
    expect([...runtime.userDisabledRowIds()]).toEqual(['booted-off'])
    await expect(runtime.recompose({ reloadBundles: true })).rejects.toThrow('rejected')
    expect([...runtime.userDisabledRowIds()]).toEqual(['booted-off'])
  })

  it('tells a row the user disabled through a group holding it from one the composition gates', async () => {
    const { runtime } = await harness([layer('a', [])])
    const chain = (ids: string[]): Entry => ids.reduceRight<Entry | undefined>(
      (parent, id) => ({ options: { id }, parent: { ctx: { fiber: { entry: parent } } } } as unknown as Entry), undefined,
    ) as Entry
    // The booted composition disables 'booted-off'.
    expect(runtime.userDisables(chain(['kid', 'booted-off', 'root']))).toBe(true)
    expect(runtime.userDisables(chain(['booted-off', 'grp']))).toBe(true)
    expect(runtime.userDisables(chain(['kid', 'grp']))).toBe(false)
  })

  it('recomposes through the root include, optionally re-reading the profile first, and commits on acceptance', async () => {
    const update = vi.fn(async () => {})
    const entry = { options: { config: { path: 'file:///root/cordis.yml', patches: [{ id: 'old' }] } }, update } as unknown as Entry
    const reloaded = profile([layer('a', []), layer('b', [])])
    const conflicts = [{ rowId: 'x', moduleName: 'm', layer: 'late', packageName: 'late', declaredBy: 'a', message: 'row "x" is already declared by a' }]
    const { runtime, compose } = await harness([layer('a', [])], { rootEntry: () => entry, reloaded, conflicts })

    await runtime.recompose()
    expect(compose).toHaveBeenLastCalledWith(expect.objectContaining({ layers: expect.any(Array) as ProfileLayer[] }))
    expect(update).toHaveBeenLastCalledWith({ config: { path: 'file:///root/cordis.yml', patches: [{ id: 'composed-for-1' }] } })
    expect(runtime.conflicts).toEqual([])

    await runtime.recompose({ reloadBundles: true })
    expect(runtime.layers).toHaveLength(2)
    expect(update).toHaveBeenLastCalledWith({ config: { path: 'file:///root/cordis.yml', patches: [{ id: 'composed-for-2' }] } })
    // Row ownership, conflicts, and the user-disabled rows follow the reloaded profile once the update holds.
    expect(runtime.originOf('bundle/b')).toBeUndefined()
    expect(runtime.conflicts).toEqual(conflicts)
    expect([...runtime.userDisabledRowIds()]).toEqual(['reloaded-off'])
  })

  it('recomposes through a plugin context handle and publishes the accepted profile', async () => {
    const update = vi.fn(async () => {})
    const entry = { options: { config: { path: 'file:///root/cordis.yml' } }, update } as unknown as Entry
    const reloaded = profile([layer('external', [])])
    const { ctx, runtime } = await harness([], { rootEntry: () => entry, reloaded })
    const caller = ctx.plugin({ inject: ['loader'], apply() {} })
    await caller.await()

    const handle = caller.ctx.get('profileRuntime')!
    await expect(handle.recompose({ reloadBundles: true })).resolves.toEqual([])
    expect(update).toHaveBeenCalledOnce()
    expect(runtime.layers.map(current => current.packageName)).toEqual(['external'])
    await expect(handle.whenIdle()).resolves.toBeUndefined()
  })

  it('runs recompositions one at a time, each from what the previous one committed', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const applied: string[] = []
    const update = vi.fn(async (options: { config: { patches: PatchOptions[] } }) => {
      applied.push(options.config.patches[0]?.id ?? '')
      if (applied.length === 1) await gate
    })
    const entry = { options: { config: { path: 'file:///root/cordis.yml' } }, update } as unknown as Entry
    const reloaded = profile([layer('a', []), layer('b', [])])
    const { runtime, compose } = await harness([layer('a', [])], { rootEntry: () => entry, reloaded })
    // Enabling a bundle re-reads the profile and waits on the tree; a watcher fires meanwhile.
    const enabling = runtime.recompose({ reloadBundles: true })
    const watching = runtime.recompose()
    const observed = vi.fn()
    const idle = runtime.whenIdle().then(observed)
    await Promise.resolve()
    expect(applied).toEqual(['composed-for-2'])
    expect(observed).not.toHaveBeenCalled()
    release()
    await Promise.all([enabling, watching, idle])
    expect(observed).toHaveBeenCalledOnce()
    // The watcher composed from the profile the enable committed, not the one before it.
    expect(applied).toEqual(['composed-for-2', 'composed-for-2'])
    expect(compose.mock.calls.at(-1)?.[0]).toBe(reloaded)
    expect(runtime.layers.map(current => current.packageName)).toEqual(['a', 'b'])
  })

  it('lets a rejected recomposition fail its own caller without blocking the next', async () => {
    let calls = 0
    const update = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw new Error('rejected')
    })
    const entry = { options: { config: { path: 'file:///root/cordis.yml' } }, update } as unknown as Entry
    const { runtime } = await harness([layer('a', [])], { rootEntry: () => entry })
    const first = runtime.recompose()
    const second = runtime.recompose()
    await expect(first).rejects.toThrow('rejected')
    await expect(second).resolves.toEqual([])
    await expect(runtime.whenIdle()).resolves.toBeUndefined()
  })

  it('keeps the committed profile, row ownership, and conflicts when the root include rejects the update', async () => {
    const entry = { options: { config: { path: 'file:///root/cordis.yml' } }, update: vi.fn(async () => { throw new Error('rejected') }) } as unknown as Entry
    const reloaded = profile([layer('a', []), layer('b', [])])
    const conflicts = [{ rowId: 'x', moduleName: 'm', layer: 'late', packageName: 'late', declaredBy: 'a', message: 'row "x" is already declared by a' }]
    const { runtime } = await harness([layer('a', [])], { rootEntry: () => entry, reloaded, conflicts })
    await expect(runtime.recompose({ reloadBundles: true })).rejects.toThrow('rejected')
    expect(runtime.current.layers).toHaveLength(1)
    expect(runtime.layers.map(current => current.packageName)).toEqual(['a'])
    expect(runtime.originOf('bundle/b')).toBeUndefined()
    expect(runtime.conflicts).toEqual([])
  })

  it('refuses to recompose before the root include is mounted', async () => {
    const { runtime } = await harness([])
    await expect(runtime.recompose()).rejects.toThrow(/root include is not mounted/)
  })
})
