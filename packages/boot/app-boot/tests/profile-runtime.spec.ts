/**
 * The `profileRuntime` service: profile facts, row provenance, user-disabled
 * rows, and recomposition through the root include entry.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { ProfileRuntime, type Profile, type ProfileLayer } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function layer(packageName: string, trust: ProfileLayer['trust'], patches: PatchOptions[], stage: ProfileLayer['stage'] = 'runtime'): ProfileLayer {
  return { packageName, version: '2.0.0', packageDir: '/nowhere', patchPath: '/nowhere/p.yml', trust, stage, patches }
}

function profile(layers: ProfileLayer[]): Profile {
  return { name: 'web', dir: '/profiles/web', layers, patchPath: '/profiles/web/cordis.patch.yml', patches: [], patchReload: 'live' }
}

async function harness(
  layers: ProfileLayer[],
  options: { rootEntry?: () => Entry | undefined; userPatches?: PatchOptions[]; reloaded?: Profile } = {},
): Promise<{ ctx: Context; runtime: ProfileRuntime; compose: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  contexts.push(ctx)
  const compose = vi.fn((current: Profile) => [{ id: `composed-for-${current.layers.length}` }] as PatchOptions[])
  await ctx.plugin(ProfileRuntime, {
    profile: profile(layers),
    loadProfile: () => options.reloaded ?? profile(layers),
    compose,
    rootEntry: options.rootEntry ?? (() => undefined),
    readUserPatches: () => options.userPatches ?? [],
  })
  return { ctx, runtime: ctx.profileRuntime, compose }
}

describe('ProfileRuntime', () => {
  it('exposes the booted profile\'s facts', async () => {
    const { runtime } = await harness([layer('@deepseek-ai/dsh-base', 'builtin', [])])
    expect(runtime.profileName).toBe('web')
    expect(runtime.dir).toBe('/profiles/web')
    expect(runtime.patchPath).toBe('/profiles/web/cordis.patch.yml')
    expect(runtime.patchReload).toBe('live')
    expect(runtime.layers.map(l => l.packageName)).toEqual(['@deepseek-ai/dsh-base'])
    expect(runtime.current.name).toBe('web')
  })

  it('attributes rows to the layer that inserted them, prefixed for external layers', async () => {
    const { runtime } = await harness([
      layer('@deepseek-ai/dsh-base', 'builtin', [{ insert: [{ id: 'settings', name: 'x' }, { name: 'anonymous' } as EntryOptions, { id: 'grp', name: 'cordis:group', group: true, config: [{ id: 'child', name: 'y' }] }] }]),
      layer('ext', 'external', [{ insert: [{ id: 'tool', name: 'ext' }] }]),
      layer('boot-ext', 'external', [{ insert: [{ id: 'svc', name: 'boot-ext' }] }], 'boot'),
    ])
    expect(runtime.originOf('settings')).toEqual({ trust: 'builtin', packageName: '@deepseek-ai/dsh-base', version: '2.0.0' })
    expect(runtime.originOf('child')).toEqual({ trust: 'builtin', packageName: '@deepseek-ai/dsh-base', version: '2.0.0' })
    expect(runtime.originOf('ext/tool')).toEqual({ trust: 'external', packageName: 'ext', version: '2.0.0', originalId: 'tool' })
    expect(runtime.originOf('bundle/ext')).toEqual({ trust: 'external', packageName: 'ext', version: '2.0.0', originalId: 'bundle/ext' })
    // A boot-stage external layer mounts unprefixed, like a built-in one.
    expect(runtime.originOf('svc')).toEqual({ trust: 'external', packageName: 'boot-ext', version: '2.0.0' })
    expect(runtime.originOf('user-row')).toBeUndefined()
  })

  it('does not descend into a group row whose config is not a list', async () => {
    const { runtime } = await harness([
      layer('odd', 'builtin', [{ insert: [{ id: 'g', name: 'cordis:group', group: true, config: {} as never }] }]),
    ])
    expect(runtime.originOf('g')?.packageName).toBe('odd')
  })

  it('omits the version when the layer has none', async () => {
    const { runtime } = await harness([{ ...layer('local', 'builtin', [{ insert: [{ id: 'r', name: 'local' }] }]), version: undefined }])
    expect(runtime.originOf('r')).toEqual({ trust: 'builtin', packageName: 'local' })
  })

  it('reads user-disabled rows from literal disabled: true items only', async () => {
    const { runtime } = await harness([], {
      userPatches: [
        { id: 'a', disabled: true },
        { id: 'b', disabled: { __jsExpr: 'true' } as unknown as boolean },
        { id: 'c', config: {} },
        { insert: [{ id: 'd', name: 'x', disabled: true }] },
      ],
    })
    expect([...runtime.userDisabledRowIds()]).toEqual(['a'])
  })

  it('recomposes through the root include, optionally re-reading the profile first', async () => {
    const update = vi.fn(async () => {})
    const entry = { options: { config: { path: 'file:///root/cordis.yml', patches: [{ id: 'old' }] } }, update } as unknown as Entry
    const reloaded = profile([layer('a', 'builtin', []), layer('b', 'external', [])])
    const { runtime, compose } = await harness([layer('a', 'builtin', [])], { rootEntry: () => entry, reloaded })

    await runtime.recompose()
    expect(compose).toHaveBeenLastCalledWith(expect.objectContaining({ layers: expect.any(Array) as ProfileLayer[] }))
    expect(update).toHaveBeenLastCalledWith({ config: { path: 'file:///root/cordis.yml', patches: [{ id: 'composed-for-1' }] } })

    await runtime.recompose({ reloadBundles: true })
    expect(runtime.layers).toHaveLength(2)
    expect(update).toHaveBeenLastCalledWith({ config: { path: 'file:///root/cordis.yml', patches: [{ id: 'composed-for-2' }] } })
    // Provenance follows the reloaded profile.
    expect(runtime.originOf('bundle/b')).toEqual({ trust: 'external', packageName: 'b', version: '2.0.0', originalId: 'bundle/b' })
  })

  it('refuses to recompose before the root include is mounted', async () => {
    const { runtime } = await harness([])
    await expect(runtime.recompose()).rejects.toThrow(/root include is not mounted/)
  })
})
