/**
 * Tree-wide row-id ownership across the profile stack: built-in layers claim
 * first and fail loud on a duplicate, an external bundle that collides is left
 * out and recorded, a user insert of a taken id is dropped, and the conflict
 * records replace the registry's earlier ones on every composition.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  claimLayerIds, composeProfileStack, CONTAINED_GROUP_MODULE, ensurePluginFailures, formatRowConflict,
  recordRowConflicts, type ProfileLayer,
} from '../src/index.ts'

const NAME = 'dsh-test-bin'

function layer(
  packageName: string, trust: ProfileLayer['trust'], patches: PatchOptions[], stage: ProfileLayer['stage'] = 'runtime',
): ProfileLayer {
  return { packageName, version: '1.0.0', packageDir: '/nowhere', patchPath: '/nowhere/cordis.patch.yml', trust, stage, patches }
}

const base = layer('@deepseek-ai/dsh-base', 'builtin', [{ insert: [
  { id: 'settings', name: 'settings' },
  { id: 'tools', name: 'cordis:group', group: true, config: [{ id: 'tool-bash', name: 'bash' }] },
] }])

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('claimLayerIds', () => {
  it('lets built-in layers own their ids, including group children, before any external layer', () => {
    const ext = layer('ext', 'external', [{ insert: [{ id: 'tool-bash', name: 'ext' }] }])
    const { owners, skipped } = claimLayerIds([ext, base])
    expect(owners.get('tool-bash')?.packageName).toBe('@deepseek-ai/dsh-base')
    expect(owners.get('tools')?.packageName).toBe('@deepseek-ai/dsh-base')
    expect(skipped.get('ext')).toEqual([
      { rowId: 'tool-bash', moduleName: 'ext', layer: 'ext', packageName: 'ext', declaredBy: '@deepseek-ai/dsh-base' },
    ])
  })

  it('throws when two built-in or boot-staged layers declare one id', () => {
    const twin = layer('twin', 'external', [{ insert: [{ id: 'settings', name: 'twin' }] }], 'boot')
    expect(() => claimLayerIds([base, twin])).toThrow(/row "settings" is declared by both @deepseek-ai\/dsh-base and twin/)
  })

  it('gives the earlier external bundle the id and leaves the later one out whole', () => {
    const first = layer('first', 'external', [{ insert: [{ id: 'hello', name: 'first' }, { id: 'only-first', name: 'first/x' }] }])
    const second = layer('second', 'external', [{ insert: [{ id: 'hello', name: 'second' }, { id: 'only-second', name: 'second/x' }] }])
    const { owners, skipped } = claimLayerIds([base, first, second])
    expect(owners.get('hello')?.packageName).toBe('first')
    expect(owners.get('bundle/first')?.packageName).toBe('first')
    expect(owners.has('only-second')).toBe(false)
    expect(skipped.get('second')?.map(conflict => conflict.rowId)).toEqual(['hello'])
  })
})

describe('composeProfileStack', () => {
  it('mounts owning layers in manifest order and drops a user insert of a taken id', () => {
    const ext = layer('ext', 'external', [{ insert: [{ id: 'ext-tool', name: 'ext' }] }])
    const stack = composeProfileStack(NAME, [base, ext], [
      { label: '/p/cordis.patch.yml', patches: [
        { id: 'settings', config: { path: '/x' } },
        { insert: [{ id: 'mine', name: 'mine' }, { id: 'ext-tool', name: 'clash' }] },
        { insert: [{ id: 'g', name: 'cordis:group', group: true, config: [{ id: 'tool-bash', name: 'nested-clash' }] }] },
      ] },
      { label: '/home/cordis.patch.yml', patches: [
        { insert: [{ id: 'mine', name: 'twice' }] },
        { insert: [{ id: 'clean', name: 'clean' }, { name: 'anonymous' } as EntryOptions] },
      ] },
    ])
    expect(stack.layers.map(current => current.label)).toEqual(['@deepseek-ai/dsh-base', 'ext', '/p/cordis.patch.yml', '/home/cordis.patch.yml'])
    expect(stack.layers[1]?.patches[0]?.insert?.[0]).toMatchObject({ id: 'bundle/ext', name: CONTAINED_GROUP_MODULE })
    expect(stack.layers[2]?.patches).toEqual([
      { id: 'settings', config: { path: '/x' } },
      { insert: [{ id: 'mine', name: 'mine' }] },
    ])
    // An insert with no conflict passes through as the same object; an anonymous row claims nothing.
    expect(stack.layers[3]?.patches).toEqual([{ insert: [{ id: 'clean', name: 'clean' }, { name: 'anonymous' }] }])
    expect(stack.patches).toEqual(stack.layers.flatMap(current => current.patches))
    expect(stack.skippedBundles).toEqual([])
    expect(stack.conflicts).toEqual([
      { rowId: 'ext-tool', moduleName: 'clash', layer: '/p/cordis.patch.yml', declaredBy: 'ext' },
      { rowId: 'tool-bash', moduleName: 'cordis:group', layer: '/p/cordis.patch.yml', declaredBy: '@deepseek-ai/dsh-base' },
      { rowId: 'mine', moduleName: 'twice', layer: '/home/cordis.patch.yml', declaredBy: '/p/cordis.patch.yml' },
    ])
  })

  it('leaves a colliding external bundle out of the stack and reports it', () => {
    const clash = layer('clash', 'external', [{ insert: [{ id: 'settings', name: 'clash' }] }])
    const stack = composeProfileStack(NAME, [base, clash], [])
    expect(stack.layers.map(current => current.label)).toEqual(['@deepseek-ai/dsh-base'])
    expect(stack.skippedBundles).toEqual(['clash'])
    expect(stack.conflicts).toEqual([
      { rowId: 'settings', moduleName: 'clash', layer: 'clash', packageName: 'clash', declaredBy: '@deepseek-ai/dsh-base' },
    ])
  })

  it('prefixes a built-in duplicate with the binary name', () => {
    const twin = layer('twin', 'builtin', [{ insert: [{ id: 'settings', name: 'twin' }] }])
    expect(() => composeProfileStack(NAME, [base, twin], [])).toThrow(/^dsh-test-bin: row "settings" is declared by both/)
  })
})

describe('formatRowConflict', () => {
  it('names the bundle left out, or the user layer whose insert was skipped', () => {
    expect(formatRowConflict({ rowId: 'x', moduleName: 'm', layer: 'pkg', packageName: 'pkg', declaredBy: 'base' }))
      .toBe('bundle pkg left out — row "x" is already declared by base')
    expect(formatRowConflict({ rowId: 'x', moduleName: 'm', layer: '/p/cordis.patch.yml', declaredBy: 'base' }))
      .toBe('/p/cordis.patch.yml: insert of m skipped — row "x" is already declared by base')
  })
})

describe('recordRowConflicts', () => {
  it('replaces the conflict records of the previous composition and keeps other stages', () => {
    const ctx = new Context()
    contexts.push(ctx)
    const registry = ensurePluginFailures(ctx)
    registry.record({ entryId: 'include:ext/bad', rowId: 'bad', moduleName: 'ext', groupId: 'include:bundle/ext', stage: 'apply', message: 'boom' })
    recordRowConflicts(ctx, [
      { rowId: 'hello', moduleName: 'second', layer: 'second', packageName: 'second', declaredBy: 'first' },
      { rowId: 'mine', moduleName: 'twice', layer: '/home/cordis.patch.yml', declaredBy: '/p/cordis.patch.yml' },
    ])
    expect(registry.list()).toEqual([
      expect.objectContaining({ entryId: 'include:ext/bad', stage: 'apply' }),
      {
        entryId: 'conflict:bundle/second:hello', rowId: 'hello', moduleName: 'second', groupId: 'bundle/second',
        packageName: 'second', stage: 'conflict', message: 'row "hello" is already declared by first',
      },
      {
        entryId: 'conflict:/home/cordis.patch.yml:mine', rowId: 'mine', moduleName: 'twice', groupId: '/home/cordis.patch.yml',
        stage: 'conflict', message: 'row "mine" is already declared by /p/cordis.patch.yml',
      },
    ])
    recordRowConflicts(ctx, [])
    expect(registry.list().map(failure => failure.stage)).toEqual(['apply'])
  })
})
