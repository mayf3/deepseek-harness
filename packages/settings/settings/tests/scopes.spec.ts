/**
 * Namespace kinds and scoped instances: a plugin mounted inside a named scope
 * registers its namespace under that scope and resolves the document's global
 * section with the scope's own section layered over it; every registrant of
 * a namespace shares its schema; the document versions each section on its
 * own; and a scope nothing registered yet is still described and writable
 * from the kind alone.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import { parseSettingsScopeId, type SettingsScope, type SettingsScopeId, type SettingsUpdateSource } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

interface ThemeConfig {
  theme: 'dark' | 'light'
  fontSize: number
}

const ThemeSchema: z<ThemeConfig> = z.object({
  theme: z.union(['dark', 'light']).default('dark'),
  fontSize: z.number().default(14),
})

const OtherSchema: z<{ theme: string }> = z.object({
  theme: z.string().default('x'),
})

interface Booted {
  ctx: Context
  provider: MemorySettings
  updates: Array<{ ns: string; next: unknown; prev: unknown; source: SettingsUpdateSource; scope: SettingsScopeId | undefined }>
  documents: Array<{ ns: string; revision: number; scope: SettingsScopeId | undefined }>
}

async function boot(doc: Record<string, unknown> = {}): Promise<Booted> {
  const ctx = new Context()
  await ctx.plugin(MemorySettings, { doc })
  const updates: Booted['updates'] = []
  const documents: Booted['documents'] = []
  ctx.on('settings/updated', (ns, next, prev, source, scope) => { updates.push({ ns, next, prev, source, scope }) })
  ctx.on('settings/document-updated', (ns, revision, scope) => { documents.push({ ns, revision, scope }) })
  return { ctx, provider: ctx.get('settings') as MemorySettings, updates, documents }
}

/** Mount a plugin inside a named scope and register the namespace from it. */
async function registerIn(
  ctx: Context,
  id: string | undefined,
  ns: string,
  schema: z<ThemeConfig> = ThemeSchema,
  base?: Partial<ThemeConfig>,
): Promise<{ scope: Scope; handle: SettingsScope<ThemeConfig> }> {
  let scope!: Scope
  let handle!: SettingsScope<ThemeConfig>
  await ctx.plugin((host: Context) => {
    scope = createScope(host, { id }, id === undefined ? {} : { id })
  })
  await scope.ctx.plugin({
    inject: ['settings'],
    apply(inner: Context) {
      handle = inner.settings.register(ns as 'ui-theme', schema, base === undefined ? {} : { base })
    },
  })
  return { scope, handle }
}

describe('scoped registration', () => {
  it('registers an instance under the nearest named scope and resolves its section over the global one', async () => {
    const { ctx, provider } = await boot({
      'ui-theme': { fontSize: 18 },
      scopes: { 'preset/standard': { 'ui-theme': { theme: 'light' } } },
    })
    const { handle } = await registerIn(ctx, 'preset/standard', 'ui-theme', ThemeSchema, { theme: 'dark', fontSize: 12 })

    expect(handle.get()).toEqual({ theme: 'light', fontSize: 18 })
    expect(provider.get('ui-theme', 'preset/standard')).toEqual({ theme: 'light', fontSize: 18 })
    expect(provider.get('ui-theme')).toBeUndefined()
    expect(provider.scopes()).toEqual(['preset/standard'])
  })

  it('uses the nearest named ancestor when the registrant\'s own scope is unnamed', async () => {
    const { ctx, provider } = await boot({ scopes: { 'preset/standard': { 'ui-theme': { theme: 'light' } } } })
    let handle!: SettingsScope<ThemeConfig>
    const namedKey = { id: 'named' }
    let anonymous!: Scope
    await ctx.plugin((host: Context) => {
      const named = createScope(host, namedKey, { id: 'preset/standard' })
      anonymous = createScope(named.ctx, { id: 'agent' }, { parent: namedKey })
    })
    await anonymous.ctx.plugin({
      inject: ['settings'],
      apply(inner: Context) { handle = inner.settings.register('ui-theme', ThemeSchema) },
    })

    expect(handle.get()).toEqual({ theme: 'light', fontSize: 14 })
    expect(provider.scopes()).toEqual(['preset/standard'])
  })

  it('lets two scopes register one kind, and refuses a second schema or a duplicate scope', async () => {
    const { ctx } = await boot()
    const standard = await registerIn(ctx, 'preset/standard', 'ui-theme')
    const research = await registerIn(ctx, 'preset/research', 'ui-theme')
    ctx.settings.register('ui-theme', ThemeSchema)

    expect(standard.handle.get()).toEqual({ theme: 'dark', fontSize: 14 })
    expect(research.handle.get()).toEqual({ theme: 'dark', fontSize: 14 })
    expect(ctx.settings.scopes()).toEqual(['preset/standard', 'preset/research'])
    expect(() => ctx.settings.register('ui-theme', ThemeSchema))
      .toThrow('settings namespace "ui-theme" is already registered')
    await expect(registerIn(ctx, 'preset/standard', 'ui-theme'))
      .rejects.toThrow('already registered under scope "preset/standard"')
    await expect(registerIn(ctx, 'preset/other', 'ui-theme', OtherSchema as unknown as z<ThemeConfig>))
      .rejects.toThrow('already registered with a different schema')
  })

  it('drops the kind with its last instance, not before', async () => {
    const { ctx, provider } = await boot()
    const { scope } = await registerIn(ctx, 'preset/standard', 'ui-theme')
    const research = await registerIn(ctx, 'preset/research', 'ui-theme')
    expect(provider.describe().map(descriptor => descriptor.ns)).toEqual(['ui-theme'])

    await scope.dispose()
    expect(provider.scopes()).toEqual(['preset/research'])
    expect(provider.describe().map(descriptor => descriptor.ns)).toEqual(['ui-theme'])

    await research.scope.dispose()
    expect(provider.describe()).toEqual([])
    expect(provider.scopes()).toEqual([])
  })

  it('rejects a registration whose scoped section is malformed, naming the scope', async () => {
    const { ctx } = await boot({ scopes: { 'preset/standard': { 'ui-theme': 'nope' } } })
    await expect(registerIn(ctx, 'preset/standard', 'ui-theme')).rejects.toThrow('settings section "ui-theme" under scope "preset/standard" must be an object of keys')
  })

  it('installs a section under a scope with the consumer\'s own validation', async () => {
    const { ctx, provider } = await boot()
    let scope!: Scope
    await ctx.plugin((host: Context) => { scope = createScope(host, { id: 'standard' }, { id: 'preset/standard' }) })
    const seen: ThemeConfig[] = []
    await scope.ctx.plugin({
      inject: ['settings'],
      apply(inner: Context) {
        let source: () => ThemeConfig = () => ({ theme: 'dark', fontSize: 1 })
        inner.settings.installSection(inner, 'ui-theme', ThemeSchema, { theme: 'dark', fontSize: 1 }, {
          setSource: (current) => { source = current },
          onChange: () => { seen.push(source()) },
          validate: (value) => { if (value.fontSize > 40) throw new Error('too large') },
        })
      },
    })

    expect(seen).toEqual([{ theme: 'dark', fontSize: 1 }])
    await provider.update('ui-theme', { fontSize: 30 }, undefined, 'preset/standard')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(seen.at(-1)).toEqual({ theme: 'dark', fontSize: 30 })
    await expect(provider.update('ui-theme', { fontSize: 50 }, undefined, 'preset/standard')).rejects.toThrow('too large')
  })

  it('refuses the reserved scopes namespace and a malformed scope id', async () => {
    const { ctx, provider } = await boot()
    expect(() => ctx.settings.register('scopes', ThemeSchema)).toThrow('reserved for the document\'s per-scope sections')
    expect(() => provider.describe({ scope: 'Preset/Standard' })).toThrow('must match')
    expect(() => parseSettingsScopeId('preset//x')).toThrow(TypeError)
    expect(parseSettingsScopeId('preset/standard')).toBe('preset/standard')
    await expect(registerIn(ctx, 'Not Valid', 'ui-theme')).rejects.toThrow('settings scope "Not Valid" must match')
  })
})

describe('writes and change propagation', () => {
  it('re-resolves every instance on a global write, gated on the resolved value', async () => {
    const { ctx, provider, updates, documents } = await boot({
      scopes: { 'preset/research': { 'ui-theme': { fontSize: 20 } } },
    })
    const standard = await registerIn(ctx, 'preset/standard', 'ui-theme')
    const research = await registerIn(ctx, 'preset/research', 'ui-theme')
    ctx.settings.register('ui-theme', ThemeSchema)

    await provider.update('ui-theme', { fontSize: 16 })

    expect(standard.handle.get()).toEqual({ theme: 'dark', fontSize: 16 })
    // The research scope overrides the field the global write changed.
    expect(research.handle.get()).toEqual({ theme: 'dark', fontSize: 20 })
    expect(provider.get('ui-theme')).toEqual({ theme: 'dark', fontSize: 16 })
    expect(updates.map(update => [update.scope, (update.next as ThemeConfig).fontSize])).toEqual([
      ['preset/standard', 16], [undefined, 16],
    ])
    expect(documents).toEqual([{ ns: 'ui-theme', revision: 1, scope: undefined }])
    expect(provider.persisted).toEqual([{ ns: 'ui-theme', section: { fontSize: 16 } }])
  })

  it('writes one scope\'s section through the owner handle and the provider, committing only that scope', async () => {
    const { ctx, provider, updates, documents } = await boot()
    const standard = await registerIn(ctx, 'preset/standard', 'ui-theme')
    const research = await registerIn(ctx, 'preset/research', 'ui-theme')

    await standard.handle.update({ theme: 'light' })
    await provider.mutate('ui-theme', [{ op: 'set', path: ['fontSize'], value: 9 }], undefined, 'preset/research')
    await provider.replace('ui-theme', { fontSize: 10 }, undefined, 'preset/research')

    expect(standard.handle.get()).toEqual({ theme: 'light', fontSize: 14 })
    expect(research.handle.get()).toEqual({ theme: 'dark', fontSize: 10 })
    expect(provider.persisted).toEqual([
      { ns: 'ui-theme', section: { theme: 'light' }, scope: 'preset/standard' },
      { ns: 'ui-theme', section: { fontSize: 9 }, scope: 'preset/research' },
      { ns: 'ui-theme', section: { fontSize: 10 }, scope: 'preset/research' },
    ])
    expect(provider.doc).toEqual({ scopes: { 'preset/standard': { 'ui-theme': { theme: 'light' } }, 'preset/research': { 'ui-theme': { fontSize: 10 } } } })
    expect(updates.map(update => update.scope)).toEqual(['preset/standard', 'preset/research', 'preset/research'])
    expect(documents.map(entry => [entry.scope, entry.revision])).toEqual([['preset/standard', 1], ['preset/research', 1], ['preset/research', 2]])
    await standard.handle.replace({})
    expect(standard.handle.get()).toEqual({ theme: 'dark', fontSize: 14 })
  })

  it('versions each section on its own and refuses a stale writer per section', async () => {
    const { ctx, provider } = await boot()
    await registerIn(ctx, 'preset/standard', 'ui-theme')
    ctx.settings.register('ui-theme', ThemeSchema)
    await provider.update('ui-theme', { fontSize: 16 })
    await provider.update('ui-theme', { fontSize: 17 })

    const [global, scoped] = [provider.describe(), provider.describe({ scope: 'preset/standard' })]
    expect(global[0]?.revision).toBe(2)
    expect(scoped[0]?.revision).toBe(0)
    await expect(provider.update('ui-theme', { fontSize: 1 }, 1)).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT', expected: 1, actual: 2 })
    await expect(provider.update('ui-theme', { fontSize: 1 }, 0, 'preset/standard')).resolves.toBeUndefined()
    await expect(provider.update('ui-theme', { fontSize: 2 }, 0, 'preset/standard')).rejects.toMatchObject({ code: 'SETTINGS_CONFLICT', expected: 0, actual: 1 })
  })

  it('accepts a write for a scope nothing registered yet, judged by the schema, and takes effect when an owner mounts', async () => {
    const { ctx, provider, updates } = await boot()
    ctx.settings.register('ui-theme', ThemeSchema)

    await provider.update('ui-theme', { theme: 'light' }, undefined, 'preset/later')
    await expect(provider.update('ui-theme', { theme: 'sepia' }, undefined, 'preset/later')).rejects.toThrow()

    expect(provider.doc).toEqual({ scopes: { 'preset/later': { 'ui-theme': { theme: 'light' } } } })
    expect(updates).toEqual([])
    const later = await registerIn(ctx, 'preset/later', 'ui-theme')
    expect(later.handle.get()).toEqual({ theme: 'light', fontSize: 14 })
    await expect(provider.update('absent', { theme: 'light' }, undefined, 'preset/later')).rejects.toThrow('is not registered')
  })

  it('rejects a scoped write whose resolved value the owner refuses, before persisting', async () => {
    const { ctx, provider } = await boot()
    ctx.settings.register('ui-theme', ThemeSchema, { validate: (value) => { if (value.fontSize > 40) throw new Error('too large') } })
    await registerIn(ctx, 'preset/standard', 'ui-theme')

    await expect(provider.update('ui-theme', { fontSize: 99 }, undefined, 'preset/standard')).rejects.toThrow('too large')
    expect(provider.persisted).toEqual([])
  })

  it('publishes external scope edits, keeps the last good value for a malformed scoped section, and versions unregistered scopes', async () => {
    const { ctx, provider, updates, documents } = await boot()
    const standard = await registerIn(ctx, 'preset/standard', 'ui-theme')

    provider.pushExternal({ scopes: { 'preset/standard': { 'ui-theme': { theme: 'light' } }, 'preset/other': { 'ui-theme': { fontSize: 1 } } } })
    expect(standard.handle.get()).toEqual({ theme: 'light', fontSize: 14 })
    expect(documents.map(entry => [entry.scope, entry.revision])).toEqual([['preset/standard', 1], ['preset/other', 1]])
    expect(updates.map(update => update.scope)).toEqual(['preset/standard'])

    provider.pushExternal({ scopes: { 'preset/standard': { 'ui-theme': { theme: 'sepia' } } } })
    expect(standard.handle.get()).toEqual({ theme: 'light', fontSize: 14 })
    // A malformed scope entry and a malformed scopes map are read as absent by the describers.
    provider.pushExternal({ scopes: { 'preset/standard': 'nope' } })
    expect(provider.describe({ scope: 'preset/standard' })[0]).toMatchObject({ value: { theme: 'light', fontSize: 14 } })
    provider.pushExternal({ scopes: 'nope' })
    expect(provider.describe({ scope: 'preset/standard' })[0]?.user).toBeUndefined()
    // A scope id the document spells outside the grammar names no section.
    provider.pushExternal({ scopes: { 'Not Valid': { 'ui-theme': { theme: 'light' } } } })
    expect(documents.at(-1)?.scope).not.toBe('Not Valid')
  })

  it('serializes the global and one scoped section on separate queues', async () => {
    const { ctx, provider } = await boot()
    ctx.settings.register('ui-theme', ThemeSchema)
    provider.persistDelayMs = 5

    await Promise.all([
      provider.update('ui-theme', { fontSize: 1 }),
      provider.update('ui-theme', { fontSize: 2 }, undefined, 'preset/standard'),
      provider.update('ui-theme', { theme: 'light' }),
    ])

    expect(provider.doc).toEqual({ 'ui-theme': { fontSize: 1, theme: 'light' }, scopes: { 'preset/standard': { 'ui-theme': { fontSize: 2 } } } })
  })
})

describe('describe', () => {
  it('describes the global scope from the kind when only scoped instances exist', async () => {
    const { ctx, provider } = await boot({ 'ui-theme': { fontSize: 18 } })
    await registerIn(ctx, 'preset/standard', 'ui-theme', ThemeSchema, { theme: 'light' })

    expect(provider.describe()).toEqual([{
      ns: 'ui-theme',
      registered: false,
      schema: ThemeSchema.toJSON(),
      value: { theme: 'dark', fontSize: 18 },
      revision: 0,
      user: { fontSize: 18 },
      applies: 'live',
    }])
  })

  it('describes one scope with its base, own section, and inherited value', async () => {
    const { ctx, provider } = await boot({
      'ui-theme': { fontSize: 18 },
      scopes: { 'preset/standard': { 'ui-theme': { theme: 'light' } } },
    })
    await registerIn(ctx, 'preset/standard', 'ui-theme', ThemeSchema, { theme: 'dark', fontSize: 12 })

    const [standard] = provider.describe({ scope: 'preset/standard' })
    expect(standard).toEqual({
      ns: 'ui-theme',
      scope: 'preset/standard',
      registered: true,
      schema: ThemeSchema.toJSON(),
      value: { theme: 'light', fontSize: 18 },
      revision: 0,
      base: { theme: 'dark', fontSize: 12 },
      user: { theme: 'light' },
      inherited: { theme: 'dark', fontSize: 18 },
      applies: 'live',
    })
    // A scope no owner registered: no base, inherits the global section.
    const [other] = provider.describe({ scope: 'preset/other' })
    expect(other).toEqual({
      ns: 'ui-theme',
      scope: 'preset/other',
      registered: false,
      schema: ThemeSchema.toJSON(),
      value: { theme: 'dark', fontSize: 18 },
      revision: 0,
      inherited: { theme: 'dark', fontSize: 18 },
      applies: 'live',
    })
  })

  it('redacts secrets in the inherited value too', async () => {
    const Secret = z.object({ token: z.string().role('secret'), size: z.number().default(1) })
    const { ctx, provider } = await boot({ secretive: { token: 'global-token' } })
    ctx.settings.register('secretive', Secret)

    const [view] = provider.describe({ scope: 'preset/standard', redactSecrets: true })
    expect(view?.inherited).toEqual({ size: 1 })
    expect(view?.secrets).toEqual([{ path: ['token'], set: true }])
  })

  it('describes a scope whose stored section the schema refuses from the layers below it', async () => {
    const { ctx, provider } = await boot({ scopes: { 'preset/standard': { 'ui-theme': { fontSize: 'huge' } } } })
    ctx.settings.register('ui-theme', ThemeSchema)

    const [standard] = provider.describe({ scope: 'preset/standard' })
    expect(standard).toMatchObject({ registered: false, value: { theme: 'dark', fontSize: 14 }, user: { fontSize: 'huge' } })
  })
})
