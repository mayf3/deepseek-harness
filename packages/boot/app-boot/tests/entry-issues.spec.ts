/** Native entries preserve siblings and report requested options separately from live fibers. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, composeProfileStack, entryIssue, inspectEntryIssues, ProfileRuntime, rootIncludeEntry, warnNestedFiberFailures, type Profile, type ProfileLayer } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  roots.splice(0).forEach((root) => { rmSync(root, { recursive: true, force: true }) })
})
const good: Plugin.Function = () => {}
const bad: Plugin.Function = () => { throw new Error('apply failed') }
const asyncBad: Plugin.Function = async () => { await Promise.resolve(); throw new Error('async apply failed') }
const configured: Plugin.Object<{ value: number }> = {
  Config: { '~standard': { version: 1, vendor: 'entry-test', validate: (input) => {
    const config = input as { value: number }
    return config.value < 0 ? { issues: [{ message: 'negative value' }] } : { value: config }
  } } },
  apply() {},
}
const nested: Plugin.Function = (ctx) => { ctx.inject([], () => { throw new Error('nested failure') }) }
const waiting: Plugin.Object = { inject: ['testService'], apply() {} }
function layer(patches: PatchOptions[]): ProfileLayer {
  return { packageName: 'pkg', version: undefined, packageDir: '/pkg', patchPath: '/pkg/patch.yml', patches }
}
async function profileBoot(layers: ProfileLayer[], user: PatchOptions[] = []): Promise<Context> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-entry-policy-'))
  roots.push(dir)
  const path = join(dir, 'cordis.yml')
  writeFileSync(path, '[]\n')
  const profile: Profile = { name: 'test', dir, layers: [...layers], patches: [], patchPath: join(dir, 'cordis.patch.yml'), patchReload: 'live' }
  const compose = (current: Profile) => composeProfileStack(current.layers, [{ label: profile.patchPath, patches: user }])
  const stack = compose(profile)
  const ctx = await boot('test', path, stack.patches, async (ctx) => {
    Object.assign(ctx.loader.builtins, { good, bad, asyncBad, configured, waiting, nested })
    await ctx.plugin(ProfileRuntime, {
      profile, stack, compose, installAnchor: join(dir, 'package.json'), loadProfile: () => ({ ...profile, layers: [...layers] }), rootEntry: () => rootIncludeEntry(ctx),
    })
  })
  contexts.push(ctx)
  return ctx
}
const failures: EntryOptions[] = [
  { id: 'missing', name: './dsh-missing-fixture.mjs' },
  { id: 'bad', name: 'cordis:bad' },
  { id: 'asyncBad', name: 'cordis:asyncBad' },
  { id: 'configured', name: 'cordis:configured', config: { value: -1 } },
  { id: 'waiting', name: 'cordis:waiting' },
  { id: 'gate', name: 'cordis:good', disabled: { __jsExpr: 'missing.disabled' } as unknown as boolean },
]
describe('entry startup policy', () => {
  it.each(failures)('keeps a failing bundle row and its successful sibling: $id', async (row) => {
    const ctx = await profileBoot([layer([{ insert: [row, { id: 'ok', name: 'cordis:good' }] }])])
    expect(ctx.loader.resolve('include:ok').fiber?.state).toBe(2)
    const entry = ctx.loader.resolve(`include:${row.id}`)
    expect((await entryIssue(entry))?.message).toBeTruthy()
    expect(ctx.profileRuntime.originOfEntry(entry)).toMatchObject({ packageName: 'pkg' })
    expect([...ctx.loader.entries()].some(e => e.options.name === 'cordis:contained-group')).toBe(false)
  })
  it.each(failures)('rejects a required id even when a bundle introduces it: $id', async (row) => {
    await expect(profileBoot([layer([{ insert: [{ ...row, id: 'webserver' }] }])])).rejects.toThrow('required startup failure')
  })
  it('keeps user rows and overrides of unlisted providers optional', async () => {
    const builtin = layer([{ insert: [{ id: 'provider', name: 'cordis:configured', config: { value: 1 } }] }])
    const ext = { ...layer([{ id: 'provider', config: { value: -1 } }]), packageName: 'ext' }
    const ctx = await profileBoot([builtin, ext], [{ insert: [{ id: 'user', name: 'cordis:bad' }, { id: 'ok', name: 'cordis:good' }] }])
    expect(ctx.loader.resolve('include:ok').fiber?.state).toBe(2)
    expect((await inspectEntryIssues(ctx)).map(issue => issue.entry.options.id)).toEqual(['provider', 'user'])
    expect(ctx.profileRuntime.originOf('provider')?.packageName).toBe('pkg')
  })
  it('rejects a required consumer left pending by an optional provider failure', async () => {
    await expect(profileBoot([
      layer([{ insert: [{ id: 'webserver', name: 'cordis:waiting' }] }]),
      { ...layer([{ insert: [{ id: 'provider', name: 'cordis:bad' }] }]), packageName: 'ext' },
    ])).rejects.toThrow('webserver')
  })
  it('preserves anonymous row ownership and nested Include ownership without matching unrelated root ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-nested-entry-'))
    roots.push(dir)
    const path = join(dir, 'nested.yml')
    writeFileSync(path, '- id: shared\n  name: cordis:bad\n')
    const ctx = await profileBoot([
      layer([{ insert: [{ id: 'shared', name: 'cordis:good' }] }]),
      { ...layer([{ insert: [
        { name: 'cordis:good' } as EntryOptions,
        { id: 'nested', name: 'cordis:include', config: { path: pathToFileURL(path).href } },
      ] }]), packageName: 'ext' },
    ])
    expect(ctx.profileRuntime.originOfEntry(ctx.loader.resolve('include:shared'))?.packageName).toBe('pkg')
    expect(ctx.profileRuntime.originOfEntry(ctx.loader.resolve('include:nested:shared'))?.packageName).toBe('ext')
    const anonymous = [...ctx.loader.entries()].find(e => e.options.id.startsWith('anonymous/'))!
    expect(ctx.profileRuntime.originOfEntry(anonymous)?.packageName).toBe('ext')
  })
})
describe('entry diagnostics', () => {
  it('disables every part of a bundle layer and restores overrides while preserving user row choices', async () => {
    const base = layer([{ insert: [
      { id: 'webserver', name: 'cordis:configured', config: { value: 1 } },
      { id: 'tools', name: 'cordis:group', group: true, config: [] },
      { id: 'ui', name: 'cordis:group', group: true, config: [] },
    ] }])
    const ext = { ...layer([
      { insert: [{ id: 'own', name: 'cordis:group', group: true, config: [{ id: 'child', name: 'cordis:good' }] }] },
      { id: 'tools', insert: [{ id: 'tool', name: 'cordis:good' }] },
      { id: 'ui', insert: [{ id: 'panel', name: 'cordis:good' }] },
      { id: 'webserver', config: { value: 2 } },
    ]), packageName: 'ext' }
    const layers = [base, ext]
    const ctx = await profileBoot(layers, [{ id: 'tool', disabled: true }])
    expect(ctx.loader.resolve('include:webserver').fiber?.config).toEqual({ value: 2 })
    expect(ctx.loader.resolve('include:tool').disabled).toBe(true)
    layers.pop()
    expect(await ctx.profileRuntime.recompose({ reloadBundles: true })).toEqual([])
    const ids = [...ctx.loader.entries()].map(entry => entry.options.id)
    for (const id of ['own', 'child', 'tool', 'panel']) expect(ids).not.toContain(id)
    expect(ctx.loader.resolve('include:webserver').fiber?.config).toEqual({ value: 1 })
    layers.push(ext)
    expect(await ctx.profileRuntime.recompose({ reloadBundles: true })).toEqual([])
    expect(ctx.loader.resolve('include:panel').fiber?.state).toBe(2)
    expect(ctx.loader.resolve('include:child').fiber?.state).toBe(2)
    expect(ctx.loader.resolve('include:tool').disabled).toBe(true)
    expect(ctx.loader.resolve('include:webserver').fiber?.config).toEqual({ value: 2 })
  })

  it('retains an active old config on invalid update, reports the failure, and clears it on a valid change', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.configured = configured
    const id = await ctx.loader.create({ name: 'cordis:configured', config: { value: 1 } })
    const entry = ctx.loader.resolve(id)
    await expect(entry.update({ config: { value: -1 } })).rejects.toThrow('negative value')
    expect(entry.options.config).toEqual({ value: -1 })
    expect(entry.fiber?.config).toEqual({ value: 1 })
    expect(entry.fiber?.state).toBe(2)
    expect((await entryIssue(entry))?.stage).toBe('update')
    expect((await entryIssue(entry))?.message).toContain('negative value')
    await entry.update({ config: { value: 2 } })
    await ctx.loader.await()
    expect(entry.fiber?.config).toEqual({ value: 2 })
    expect(await entryIssue(entry)).toBeUndefined()
  })
  it('clears import and pending issues after recovery and ignores disabled failures', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins.waiting = waiting
    const broken = await ctx.loader.create({ name: './dsh-missing-fixture.mjs' })
    const pending = await ctx.loader.create({ name: 'cordis:waiting' })
    expect((await inspectEntryIssues(ctx)).map(issue => issue.stage).sort()).toEqual(['import', 'inject-pending'])
    ctx.loader.builtins.later = good
    await ctx.loader.resolve(broken).update({ disabled: true })
    expect(await entryIssue(ctx.loader.resolve(broken))).toBeUndefined()
    await ctx.loader.resolve(broken).update({ name: 'cordis:later', disabled: false })
    ctx.provide('testService', {})
    await ctx.loader.await()
    expect(await entryIssue(ctx.loader.resolve(pending))).toBeUndefined()
    expect(await inspectEntryIssues(ctx)).toEqual([])
  })
  it('reports partial recompose, preserves successful siblings, and waits for removed fibers', async () => {
    const patches: PatchOptions[] = [{ insert: [
      { id: 'config', name: 'cordis:configured', config: { value: 1 } },
      { id: 'ok', name: 'cordis:good' },
    ] }]
    const ctx = await profileBoot([layer(patches)])
    let release!: () => void
    let started!: () => void
    const removing = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    ctx.loader.builtins.slow = (ctx: Context) => { ctx.effect(() => async () => { started(); await gate }) }
    patches[0]!.insert!.push({ id: 'slow', name: 'cordis:slow' })
    await ctx.profileRuntime.recompose({ reloadBundles: true })
    patches[0]!.insert![0]!.config = { value: -1 }
    patches[0]!.insert!.pop()
    const done = vi.fn()
    const updating = ctx.profileRuntime.recompose({ reloadBundles: true }).then((issues) => { done(); return issues })
    try {
      await removing
      expect(done).not.toHaveBeenCalled()
    } finally { release() }
    expect((await updating).map(issue => issue.stage)).toContain('update')
    expect(ctx.loader.resolve('include:ok').fiber?.state).toBe(2)
    expect(ctx.loader.resolve('include:config').fiber?.config).toEqual({ value: 1 })
  })
})

describe('nested continuation diagnostics', () => {
  it('reports nested failures without treating them as entry activation failures', async () => {
    const ctx = await profileBoot([
      layer([{ insert: [{ id: 'required', name: 'cordis:nested' }] }]),
      { ...layer([{ insert: [
        { id: 'optional', name: 'cordis:nested' }, { id: 'failed-entry', name: 'cordis:bad' },
      ] }]), packageName: 'ext' },
    ])
    await expect(ctx.plugin(() => { throw new Error('unowned failure') })).rejects.toThrow('unowned failure')
    await Promise.allSettled([...ctx.registry.values()].flatMap(runtime => [...runtime.fibers].map(fiber => fiber.await())))
    const lines: string[] = []
    const count = warnNestedFiberFailures(ctx, 'test', (line) => { lines.push(line) })
    expect(count, lines.join('\n')).toBe(2)
    expect(lines[0]).toContain('cordis:nested')
    expect(ctx.loader.resolve('include:required').fiber?.state).toBe(2)
    expect(warnNestedFiberFailures(ctx, 'test')).toBe(2)
  })
})
