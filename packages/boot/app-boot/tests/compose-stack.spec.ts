/**
 * Tree-wide row-id ownership across the profile stack: built-in layers claim
 * first and fail loud on a duplicate, an external bundle that collides is left
 * out and recorded, a bundle that repeats one of its own ids is left out the
 * same way, a user insert of a taken id is dropped, and every conflict
 * carries its message.
 */

import { describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { claimLayerIds, composeProfileStack, CONTAINED_GROUP_MODULE, formatRowConflict, type ProfileLayer } from '../src/index.ts'

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

describe('claimLayerIds', () => {
  it('lets built-in layers own their ids, including group children, before any external layer', () => {
    const ext = layer('ext', 'external', [{ insert: [{ id: 'tool-bash', name: 'ext' }] }])
    const { owners, skipped } = claimLayerIds([ext, base])
    expect(owners.get('tool-bash')?.packageName).toBe('@deepseek-ai/dsh-base')
    expect(owners.get('tools')?.packageName).toBe('@deepseek-ai/dsh-base')
    expect(skipped.get('ext')).toEqual([
      {
        rowId: 'tool-bash', moduleName: 'ext', layer: 'ext', packageName: 'ext', declaredBy: '@deepseek-ai/dsh-base',
        message: 'row "tool-bash" is already declared by @deepseek-ai/dsh-base',
      },
    ])
  })

  it('throws when two built-in or boot-staged layers declare one id, or one declares it twice', () => {
    const twin = layer('twin', 'external', [{ insert: [{ id: 'settings', name: 'twin' }] }], 'boot')
    expect(() => claimLayerIds([base, twin])).toThrow(/row "settings" is declared by both @deepseek-ai\/dsh-base and twin/)
    const stutter = layer('stutter', 'builtin', [{ insert: [{ id: 'x', name: 'a' }] }, { insert: [{ id: 'x', name: 'b' }] }])
    expect(() => claimLayerIds([stutter])).toThrow(/row "x" is declared twice by stutter/)
  })

  it('leaves out a bundle whose config override sets a row another layer owns', () => {
    const hijack = layer('hijack', 'external', [
      { insert: [{ id: 'own', name: 'cordis:group', group: true, config: [] }] },
      { id: 'own', config: [{ id: 'settings', name: 'hijack/impostor' }] },
    ])
    const { skipped } = claimLayerIds([base, hijack])
    expect(skipped.get('hijack')).toEqual([
      {
        rowId: 'settings', moduleName: 'hijack/impostor', layer: 'hijack', packageName: 'hijack', declaredBy: '@deepseek-ai/dsh-base',
        message: 'row "settings" is already declared by @deepseek-ai/dsh-base',
      },
    ])
    const stack = composeProfileStack(NAME, [base, hijack], [])
    expect(stack.skippedBundles).toEqual(['hijack'])
    expect(stack.owners.get('settings')?.packageName).toBe('@deepseek-ai/dsh-base')
  })

  it('lets a built-in layer restate its own rows through a config override, and rejects another layer\'s', () => {
    const restating = layer('restating', 'builtin', [
      { insert: [{ id: 'g', name: 'cordis:group', group: true, config: [{ id: 'a', name: 'a' }] }] },
      { id: 'g', config: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }] },
    ])
    expect([...claimLayerIds([restating]).owners.keys()]).toEqual(['g', 'a', 'b'])
    const taking = layer('taking', 'builtin', [
      { insert: [{ id: 'h', name: 'cordis:group', group: true, config: [] }] },
      { id: 'h', config: [{ id: 'settings', name: 'taking/impostor' }] },
    ])
    expect(() => claimLayerIds([base, taking])).toThrow(/row "settings" is declared by both @deepseek-ai\/dsh-base and taking/)
    // Setting a row under another group would move it; listing it twice would fail the group's update.
    const moving = layer('moving', 'builtin', [
      { insert: [
        { id: 'g', name: 'cordis:group', group: true, config: [{ id: 'a', name: 'a' }] },
        { id: 'h', name: 'cordis:group', group: true, config: [] },
      ] },
      { id: 'h', config: [{ id: 'a', name: 'a' }] },
    ])
    expect(() => claimLayerIds([moving])).toThrow(/row "a" is declared twice by moving/)
    const twice = layer('twice', 'builtin', [
      { insert: [{ id: 'g', name: 'cordis:group', group: true, config: [] }] },
      { id: 'g', config: [{ id: 'a', name: 'a' }, { id: 'a', name: 'a' }] },
    ])
    expect(() => claimLayerIds([twice])).toThrow(/row "a" is declared twice by twice/)
    // A child of a group without an id cannot be restated: no patch can address that group.
    const anonymous = layer('anonymous', 'builtin', [
      { insert: [
        // A row leaves its id to the Loader, as YAML rows may; the type asks for one.
        { name: 'cordis:group', group: true, config: [{ id: 'a', name: 'a' }] } as unknown as EntryOptions,
        { id: 'h', name: 'cordis:group', group: true, config: [] },
      ] },
      { id: 'h', config: [{ id: 'a', name: 'a' }] },
    ])
    expect(() => claimLayerIds([anonymous])).toThrow(/row "a" is declared twice by anonymous/)
  })

  it('leaves out a bundle whose config override of its own group lists an id twice', () => {
    const self = layer('self', 'external', [
      { insert: [{ id: 'row', name: 'self/row' }] },
      { id: 'bundle/self', config: [{ id: 'row', name: 'self/row' }, { id: 'row', name: 'self/row-again' }] },
    ])
    const { skipped, composed } = claimLayerIds([base, self])
    expect(skipped.get('self')?.map(conflict => conflict.message)).toEqual(['row "row" is declared twice by self'])
    expect(composed.has('self')).toBe(false)
  })

  it('leaves out a bundle that declares one of its own ids twice and composes each mounted bundle once', () => {
    const stutter = layer('stutter', 'external', [{ insert: [{ id: 'x', name: 'stutter/a' }, { id: 'x', name: 'stutter/b' }] }])
    const clean = layer('clean', 'external', [{ insert: [{ id: 'y', name: 'clean' }] }])
    const { owners, skipped, composed } = claimLayerIds([base, stutter, clean])
    expect(skipped.get('stutter')).toEqual([
      { rowId: 'x', moduleName: 'stutter/b', layer: 'stutter', packageName: 'stutter', declaredBy: 'stutter', message: 'row "x" is declared twice by stutter' },
    ])
    expect(owners.has('x')).toBe(false)
    expect(owners.get('y')?.packageName).toBe('clean')
    expect([...composed.keys()]).toEqual(['clean'])
    expect(composed.get('clean')?.patches[1]).toEqual({ id: 'bundle/clean', insert: [{ id: 'y', name: 'clean' }] })
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
  it('collects the rows the user layers disable with a literal disabled: true', () => {
    const stack = composeProfileStack(NAME, [base], [{ label: '/p/cordis.patch.yml', patches: [
      { id: 'a', disabled: true },
      // A gate read from disk is an expression node: a condition of the composition, not a decision.
      { id: 'b', disabled: { __jsExpr: 'true' } as unknown as boolean },
      { id: 'c', config: {} },
      { insert: [{ id: 'd', name: 'x', disabled: true }] },
    ] }])
    expect([...stack.userDisabledRowIds]).toEqual(['a'])
  })

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
    expect([...stack.owners.keys()]).toEqual(['settings', 'tools', 'tool-bash', 'ext-tool', 'bundle/ext'])
    expect(stack.layers[2]?.patches).toEqual([
      { id: 'settings', config: { path: '/x' } },
      { insert: [{ id: 'mine', name: 'mine' }] },
    ])
    // An insert with no conflict passes through as the same object; an anonymous row claims nothing.
    expect(stack.layers[3]?.patches).toEqual([{ insert: [{ id: 'clean', name: 'clean' }, { name: 'anonymous' }] }])
    expect(stack.patches).toEqual(stack.layers.flatMap(current => current.patches))
    expect(stack.skippedBundles).toEqual([])
    expect(stack.conflicts).toEqual([
      { rowId: 'ext-tool', moduleName: 'clash', layer: '/p/cordis.patch.yml', declaredBy: 'ext', message: 'row "ext-tool" is already declared by ext' },
      {
        rowId: 'tool-bash', moduleName: 'cordis:group', layer: '/p/cordis.patch.yml', declaredBy: '@deepseek-ai/dsh-base',
        message: 'row "tool-bash" is already declared by @deepseek-ai/dsh-base',
      },
      {
        rowId: 'mine', moduleName: 'twice', layer: '/home/cordis.patch.yml', declaredBy: '/p/cordis.patch.yml',
        message: 'row "mine" is already declared by /p/cordis.patch.yml',
      },
    ])
  })

  it('leaves a colliding external bundle out of the stack and reports it', () => {
    const clash = layer('clash', 'external', [{ insert: [{ id: 'settings', name: 'clash' }] }])
    const stack = composeProfileStack(NAME, [base, clash], [])
    expect(stack.layers.map(current => current.label)).toEqual(['@deepseek-ai/dsh-base'])
    expect(stack.skippedBundles).toEqual(['clash'])
    expect(stack.conflicts).toEqual([
      {
        rowId: 'settings', moduleName: 'clash', layer: 'clash', packageName: 'clash', declaredBy: '@deepseek-ai/dsh-base',
        message: 'row "settings" is already declared by @deepseek-ai/dsh-base',
      },
    ])
  })

  it('prefixes a built-in duplicate with the binary name', () => {
    const twin = layer('twin', 'builtin', [{ insert: [{ id: 'settings', name: 'twin' }] }])
    expect(() => composeProfileStack(NAME, [base, twin], [])).toThrow(/^dsh-test-bin: row "settings" is declared by both/)
  })
})

describe('formatRowConflict', () => {
  it('names the bundle left out, or the user layer whose insert was skipped', () => {
    const message = 'row "x" is already declared by base'
    expect(formatRowConflict({ rowId: 'x', moduleName: 'm', layer: 'pkg', packageName: 'pkg', declaredBy: 'base', message }))
      .toBe('bundle pkg left out — row "x" is already declared by base')
    expect(formatRowConflict({ rowId: 'x', moduleName: 'm', layer: '/p/cordis.patch.yml', declaredBy: 'base', message }))
      .toBe('/p/cordis.patch.yml: insert of m skipped — row "x" is already declared by base')
  })
})
