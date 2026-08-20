import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { composeProfilePatches, composeRows, resolveShippedPresetPatch } from '../src/profile-boot.ts'

/** The web bundle's roster insert, reduced to the keys the derivation reads. */
const bundleLayer: PatchOptions[] = [{
  insert: [{ id: 'agent-presets', name: '@deepseek-ai/dsh-agent-presets', config: { default: 'standard' } }],
}]

const userLayer = (config: Record<string, unknown>): PatchOptions[] => [{ id: 'agent-presets', config }]

const shippedRoot = { path: expect.stringContaining(`config${sep}agent-presets`) as unknown, trust: 'system' }

/** Apply a full patch stack the way boot does and return the roster row's mounted config. */
function finalRosterConfig(patches: PatchOptions[]): Record<string, unknown> {
  const row = composeEntries([patches]).find(entry => entry.id === 'agent-presets')
  if (row === undefined) throw new Error('missing agent-presets row')
  return row.config as Record<string, unknown>
}

describe('resolveShippedPresetPatch', () => {
  it('is absent for a composition without the roster row', () => {
    const rows = composeRows([[{ insert: [{ id: 'other', name: '@deepseek-ai/dsh-other' }] }]])
    expect(resolveShippedPresetPatch(rows)).toBeUndefined()
  })

  it('prepends the shipped root to configured roots and preserves every other key', () => {
    const rows = composeRows([bundleLayer, userLayer({
      default: 'minimal',
      roots: [{ path: `${sep}shared${sep}presets`, trust: 'user' }],
      includeUserRoot: false,
    })])
    expect(resolveShippedPresetPatch(rows)).toEqual({
      id: 'agent-presets',
      config: {
        default: 'minimal',
        includeUserRoot: false,
        roots: [shippedRoot, { path: `${sep}shared${sep}presets`, trust: 'user' }],
      },
    })
  })

  it('supplies the shipped root alone when the composition configures none', () => {
    const patch = resolveShippedPresetPatch(composeRows([bundleLayer]))
    expect(patch).toEqual({ id: 'agent-presets', config: { default: 'standard', roots: [shippedRoot] } })
  })

  it('fails loud on a config it cannot statically rewrite', () => {
    expect(() => resolveShippedPresetPatch(composeRows([bundleLayer, userLayer({ default: 'standard', roots: 'nope' })])))
      .toThrow(TypeError)
    expect(() => resolveShippedPresetPatch(composeRows([bundleLayer, userLayer({ default: 'standard', roots: { __jsExpr: 'x' } })])))
      .toThrow(/literal array/)
    expect(() => resolveShippedPresetPatch(composeRows([bundleLayer, [{ id: 'agent-presets', config: { __jsExpr: 'x' } }]])))
      .toThrow(/literal mapping/)
  })
})

describe('composeProfilePatches', () => {
  it('keeps configured roots effective through the whole patch application', () => {
    // The squash this stack exists to prevent: the derived patch must extend
    // the user layer's roots, not replace them with the shipped root.
    const config = finalRosterConfig(composeProfilePatches([bundleLayer, userLayer({
      default: 'standard',
      roots: [{ path: `${sep}shared${sep}presets`, trust: 'user' }],
      includeUserRoot: true,
    })]))
    expect(config.roots).toEqual([shippedRoot, { path: `${sep}shared${sep}presets`, trust: 'user' }])
    expect(config.default).toBe('standard')
    expect(config.includeUserRoot).toBe(true)
  })

  it('derives from the layers each call is given, not from an earlier composition', () => {
    // The live user-layer reload calls this per generation: an edited
    // cordis.patch.yml must decide the derived roots, never a boot snapshot.
    composeProfilePatches([bundleLayer, userLayer({ default: 'standard', roots: [{ path: `${sep}one`, trust: 'user' }] })])
    const config = finalRosterConfig(composeProfilePatches([bundleLayer, userLayer({
      default: 'standard',
      roots: [{ path: `${sep}two`, trust: 'user' }],
    })]))
    expect(config.roots).toEqual([shippedRoot, { path: `${sep}two`, trust: 'user' }])
  })

  it('appends nothing to a composition without the roster row', () => {
    const layers = [[{ insert: [{ id: 'other', name: '@deepseek-ai/dsh-other' }] }]]
    expect(composeProfilePatches(layers)).toEqual(layers.flat())
  })
})
