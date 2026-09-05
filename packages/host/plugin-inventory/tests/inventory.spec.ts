import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import { ensurePluginFailures, type ProfileRuntime, type RowOrigin } from '@deepseek-ai/dsh-app-boot'
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

    await ctx.loader.remove(pendingId)
    expect((await inventory.list()).entries.some(entry => entry.entryId === pendingId)).toBe(false)
  })

  it('attributes rows to their bundle through the profile runtime and lists recorded failures', async () => {
    const { ctx, inventory } = await harness()
    // A bare Loader assigns ids; without a root include they are also the tree-wide ids.
    const versioned = await ctx.loader.create({ name: 'cordis:active' })
    const bare = await ctx.loader.create({ name: 'cordis:active' })
    const off = await ctx.loader.create({ name: 'cordis:active', disabled: true })
    const origins = new Map<string, RowOrigin>([
      [versioned, { trust: 'external', packageName: 'ext', version: '1.2.3' }],
      [bare, { trust: 'external', packageName: 'ext' }],
      [off, { trust: 'external', packageName: 'ext' }],
      ['gone', { trust: 'external', packageName: 'ext' }],
    ])
    ctx.provide('profileRuntime', {
      originOf: (rowId: string) => origins.get(rowId),
      userDisabledRowIds: () => new Set([off]),
    } as Partial<ProfileRuntime> as never)
    const registry = ensurePluginFailures(ctx)
    registry.record({ entryId: 'gone', rowId: 'gone', moduleName: 'cordis:throws', groupId: 'bundle/ext', stage: 'apply', message: 'boom' })
    // A record of a row that later mounted rides on the live entry and is not listed twice.
    registry.record({ entryId: bare, rowId: bare, moduleName: 'cordis:active', groupId: 'bundle/ext', stage: 'import', message: 'stale' })
    // A failure the runtime cannot attribute belongs to no package.
    registry.record({ entryId: 'orphan', rowId: 'orphan', moduleName: 'cordis:throws', groupId: 'bundle/gone', stage: 'apply', message: 'lost' })
    registry.record({
      entryId: 'conflict:bundle/late:versioned', rowId: versioned, moduleName: 'late', groupId: 'bundle/late',
      packageName: 'late', stage: 'conflict', message: 'row "versioned" is already declared by ext',
    })
    registry.record({
      entryId: 'conflict:/home/cordis.patch.yml:bare', rowId: bare, moduleName: 'mine', groupId: '/home/cordis.patch.yml',
      stage: 'conflict', message: 'row "bare" is already declared by ext',
    })

    const { entries } = await inventory.list()
    expect(entries).toEqual([
      { entryId: versioned, moduleName: 'cordis:active', enabled: true, fiberPhase: 'active', trust: 'external', package: { name: 'ext', version: '1.2.3' } },
      { entryId: bare, moduleName: 'cordis:active', enabled: true, fiberPhase: 'active', trust: 'external', package: { name: 'ext' }, failure: { stage: 'import', message: 'stale' } },
      { entryId: off, moduleName: 'cordis:active', enabled: false, fiberPhase: null, trust: 'external', package: { name: 'ext' }, disabledBy: 'user' },
      // A failed row the tree no longer holds is attributed through the runtime.
      { entryId: 'gone', moduleName: 'cordis:throws', enabled: true, fiberPhase: 'failed', trust: 'external', package: { name: 'ext' }, failure: { stage: 'apply', message: 'boom' } },
      { entryId: 'orphan', moduleName: 'cordis:throws', enabled: true, fiberPhase: 'failed', trust: 'external', failure: { stage: 'apply', message: 'lost' } },
      // A conflict names the bundle that lost the id; the runtime would name the owner.
      { entryId: 'conflict:bundle/late:versioned', moduleName: 'late', enabled: true, fiberPhase: 'failed', trust: 'external', package: { name: 'late' }, failure: { stage: 'conflict', message: 'row "versioned" is already declared by ext' } },
      // A user-layer conflict belongs to no package.
      { entryId: 'conflict:/home/cordis.patch.yml:bare', moduleName: 'mine', enabled: true, fiberPhase: 'failed', trust: 'external', failure: { stage: 'conflict', message: 'row "bare" is already declared by ext' } },
    ])
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
