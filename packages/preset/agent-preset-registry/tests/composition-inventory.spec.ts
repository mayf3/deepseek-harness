import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import { definitionComposition, mountedCompositionRows } from '../src/composition-inventory.ts'

it('reads mounted preset metadata from each live entry and omits disabled metadata', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.named = { meta: { title: 'Preset child' }, apply() {} }
    await ctx.loader.root.update([
      { id: 'live', name: 'cordis:named' },
      { id: 'off', name: 'cordis:named', disabled: true },
    ])
    const rows = mountedCompositionRows(ctx.loader)
    expect(rows[0]?.meta).toEqual({ title: 'Preset child' })
    expect(rows[1]?.meta).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('reports evaluated and unresolved conditions with ancestor enablement', () => {
  const js = (code: string) => ({ __jsExpr: code })
  const read = definitionComposition([
    { name: 'enabled', id: 'enabled-id' },
    { name: 'off', disabled: true },
    { name: 'on', disabled: js('false') },
    { name: 'conditional', disabled: js('unknownVariable') },
    { name: 'group', group: true, disabled: js('unknownVariable'), config: [
      { name: 'child' }, { name: 'disabled-child', disabled: true },
    ] },
    { name: 'off-group', group: true, disabled: true, config: [{ name: 'buried' }] },
  ], expression => evaluate({}, expression))
  expect(read).toEqual({ rows: [
    { entryId: 'enabled-id', moduleName: 'enabled', enabled: true },
    { entryId: null, moduleName: 'off', enabled: false },
    { entryId: null, moduleName: 'on', enabled: true, condition: 'false' },
    { entryId: null, moduleName: 'conditional', enabled: 'conditional', condition: 'unknownVariable' },
    { entryId: null, moduleName: 'child', enabled: 'conditional' },
    { entryId: null, moduleName: 'disabled-child', enabled: false },
    { entryId: null, moduleName: 'buried', enabled: false },
  ] })
  expect(definitionComposition([{ group: true }], () => false)).toHaveProperty('broken')
})
