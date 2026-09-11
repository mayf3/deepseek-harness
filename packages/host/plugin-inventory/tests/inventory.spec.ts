import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState, type Plugin } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { ProfileRuntime, type ComposedStack, type Profile, type RowOrigin } from '@deepseek-ai/dsh-app-boot'
import PluginInventoryGateway from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const activePlugin: Plugin.Function = () => {}
const pendingPlugin: Plugin.Object = {
  inject: ['neverReady'],
  apply() {},
}

async function harness(): Promise<{
  ctx: Context
  inventory: PluginInventoryGateway
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  ctx.loader.builtins.active = activePlugin
  ctx.loader.builtins.pending = pendingPlugin
  await ctx.plugin(PluginInventoryGateway)
  const inventory = ctx.get('pluginInventory') as PluginInventoryGateway
  return { ctx, inventory }
}

describe('PluginInventoryGateway', () => {
  it('publishes one direct list method under the pluginInventory namespace', async () => {
    const { inventory } = await harness()
    expect(inventory.typertRemote).toMatchObject({
      serviceKey: 'pluginInventory',
      namespace: 'pluginInventory',
    })
    expect(remoteMethods(inventory)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
    ])
  })

  it('projects current non-group Loader entries without a second cache', async () => {
    const { ctx, inventory } = await harness()
    const activeId = await ctx.loader.create({ name: 'cordis:active' })
    const pendingId = await ctx.loader.create({ name: 'cordis:pending' })
    const disabledId = await ctx.loader.create({
      name: 'cordis:not-installed',
      disabled: true,
    })
    await ctx.loader.create({ name: 'cordis:active', group: true })

    const snapshot = await inventory.list()
    // No agent-preset roster is composed, so the snapshot carries no presets.
    expect(snapshot.agentPresets).toBeUndefined()
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries).toEqual(expect.arrayContaining([
      {
        entryId: activeId,
        moduleName: 'cordis:active',
        enabled: true,
        fiberPhase: 'active',
        trust: 'builtin',
      },
      {
        entryId: pendingId,
        moduleName: 'cordis:pending',
        enabled: true,
        fiberPhase: 'pending',
        trust: 'builtin',
        failure: { stage: 'inject-pending', message: 'pending (waiting for service: neverReady)' },
      },
      {
        entryId: disabledId,
        moduleName: 'cordis:not-installed',
        enabled: false,
        fiberPhase: null,
        trust: 'builtin',
        disabledBy: 'composition',
      },
    ]))

    await ctx.loader.update(activeId, { disabled: true })
    expect((await inventory.list()).entries.find(entry => entry.entryId === activeId)).toEqual({
      entryId: activeId,
      moduleName: 'cordis:active',
      enabled: false,
      fiberPhase: null,
      trust: 'builtin',
      disabledBy: 'composition',
    })

    ctx.loader.remove(pendingId)
    expect((await inventory.list()).entries.some(entry => entry.entryId === pendingId)).toBe(false)
  })

  it('attributes rows to their bundle through the profile runtime and lists recorded failures and conflicts', async () => {
    const { ctx, inventory } = await harness()
    // A bare Loader assigns ids; without a root include they are also the tree-wide ids.
    const versioned = await ctx.loader.create({ name: 'cordis:active' })
    const bare = await ctx.loader.create({ name: 'cordis:active' })
    const off = await ctx.loader.create({ name: 'cordis:active', disabled: true })
    const origins = new Map<string, RowOrigin>([
      [versioned, { trust: 'external', stage: 'runtime', packageName: 'ext', version: '1.2.3' }],
      [bare, { trust: 'external', stage: 'runtime', packageName: 'ext' }],
      [off, { trust: 'external', stage: 'runtime', packageName: 'ext' }],
      ['gone', { trust: 'external', stage: 'runtime', packageName: 'ext' }],
    ])
    ctx.provide('profileRuntime', {
      originOfEntry: (entry: { id: string }) => origins.get(entry.id),
      userDisables: (entry: { id: string }) => entry.id === off,
      layers: [{ packageName: 'late', version: '9.9.9' }],
      conflicts: [
        { rowId: 'tool', moduleName: 'late', layer: 'late', packageName: 'late', declaredBy: 'ext', message: 'row "tool" is already declared by ext' },
        { rowId: 'mine', moduleName: 'twice', layer: '/p/cordis.patch.yml', declaredBy: 'ext', message: 'row "mine" is already declared by ext' },
        { rowId: 'x', moduleName: 'gone/x', layer: 'gone', packageName: 'gone', declaredBy: 'gone', message: 'row "x" is declared twice by gone' },
      ],
    } as unknown as ProfileRuntime)
    await ctx.loader.create({ id: 'gone', name: './dsh-missing-fixture.mjs' } as Parameters<typeof ctx.loader.create>[0])
    await ctx.loader.create({ id: 'orphan', name: './dsh-missing-fixture.mjs' } as Parameters<typeof ctx.loader.create>[0])
    ctx.loader.resolve('gone').lastFailure = { stage: 'import', error: 'boom' }
    ctx.loader.resolve(bare).lastFailure = { stage: 'update', error: 'invalid config' }
    ctx.loader.resolve('orphan').lastFailure = { stage: 'import', error: 'lost' }

    const { entries } = await inventory.list()
    // Compared in id order: the Loader assigns ids, and one that comes out all
    // digits is listed first by the entry store regardless of creation order.
    const byId = (left: { entryId: string }, right: { entryId: string }): number => left.entryId.localeCompare(right.entryId)
    expect([...entries].sort(byId)).toEqual([
      { entryId: versioned, moduleName: 'cordis:active', enabled: true, fiberPhase: 'active', trust: 'external', package: { name: 'ext', version: '1.2.3' } },
      { entryId: bare, moduleName: 'cordis:active', enabled: true, fiberPhase: 'active', trust: 'external', package: { name: 'ext' }, failure: { stage: 'update', message: 'invalid config' } },
      { entryId: off, moduleName: 'cordis:active', enabled: false, fiberPhase: null, trust: 'external', package: { name: 'ext' }, disabledBy: 'user' },
      // A failed row the tree no longer holds is attributed through the runtime.
      { entryId: 'gone', moduleName: './dsh-missing-fixture.mjs', enabled: true, fiberPhase: 'failed', trust: 'external', package: { name: 'ext' }, failure: { stage: 'import', message: 'failed to import: boom' } },
      { entryId: 'orphan', moduleName: './dsh-missing-fixture.mjs', enabled: true, fiberPhase: 'failed', trust: 'builtin', failure: { stage: 'import', message: 'failed to import: lost' } },
      // A row the composition left out is listed from the runtime's conflicts, under the layer that lost.
      {
        entryId: 'conflict:late:tool', moduleName: 'late', enabled: true, fiberPhase: 'failed', trust: 'external',
        package: { name: 'late', version: '9.9.9' }, failure: { stage: 'conflict', message: 'row "tool" is already declared by ext' },
      },
      {
        entryId: 'conflict:/p/cordis.patch.yml:mine', moduleName: 'twice', enabled: true, fiberPhase: 'failed', trust: 'user',
        failure: { stage: 'conflict', message: 'row "mine" is already declared by ext' },
      },
      // A bundle the layer list no longer names keeps its package, without a version.
      {
        entryId: 'conflict:gone:x', moduleName: 'gone/x', enabled: true, fiberPhase: 'failed', trust: 'external',
        package: { name: 'gone' }, failure: { stage: 'conflict', message: 'row "x" is declared twice by gone' },
      },
    ].sort(byId))
  })

  it('attributes a row disabled through a group the user disabled to the user', async () => {
    const { ctx, inventory } = await harness()
    ctx.loader.builtins.group = Group
    const groupId = await ctx.loader.create({ name: 'cordis:group', group: true, config: [{ name: 'cordis:active' }] })
    const child = [...ctx.loader.entries()].find(entry => !entry.options.group && entry.parent.ctx.fiber.entry?.options.id === groupId)
    expect(child).toBeDefined()
    // The real runtime over a composition whose user layer disabled the group.
    const profile: Profile = { name: 'web', dir: '/p', layers: [], patchPath: '/p/cordis.patch.yml', patches: [], patchReload: 'live' }
    const stack: ComposedStack = {
      patches: [], layers: [], owners: new Map(), conflicts: [], skippedBundles: [], userDisabledRowIds: new Set([groupId]),
    }
    await ctx.plugin(ProfileRuntime, {
      profile, stack, installAnchor: '/app/package.json', loadProfile: () => profile, compose: () => stack, rootEntry: () => undefined,
    })
    await ctx.loader.update(groupId, { disabled: true })
    const listed = (await inventory.list()).entries.find(entry => entry.entryId === child?.id)
    expect(listed).toMatchObject({ enabled: false, disabledBy: 'user' })
  })

  it('carries each composed preset with root-fiber states mapped to phases', async () => {
    const { ctx, inventory } = await harness()
    ctx.provide('agentPresets', {
      compositionInventory: async () => [
        {
          id: 'standard',
          trust: 'system',
          name: '标准模式',
          isDefault: true,
          rows: [
            { entryId: 'alpha', moduleName: 'pkg-alpha', enabled: true, fiberState: FiberState.ACTIVE },
            { entryId: null, moduleName: 'pkg-file', enabled: 'conditional', condition: 'x' },
          ],
        },
        { id: 'damaged', trust: 'user', isDefault: false, broken: 'the composition file is missing', rows: [] },
      ],
    } as Partial<AgentPresets> as never)

    const snapshot = await inventory.list()
    expect(snapshot.agentPresets).toEqual([
      {
        id: 'standard',
        trust: 'system',
        name: '标准模式',
        isDefault: true,
        rows: [
          { entryId: 'alpha', moduleName: 'pkg-alpha', enabled: true, fiberPhase: 'active' },
          { entryId: null, moduleName: 'pkg-file', enabled: 'conditional', condition: 'x', fiberPhase: null },
        ],
      },
      { id: 'damaged', trust: 'user', isDefault: false, broken: 'the composition file is missing', rows: [] },
    ])
  })
})
