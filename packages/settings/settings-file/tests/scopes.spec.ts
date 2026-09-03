/**
 * The document layout of scoped sections: `scopes.<scope id>.<namespace>`,
 * written as the same comment-preserving leaf diff a global section gets,
 * in YAML and in JSON, and read back the same way.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSettingsProvider } from '../src/index.ts'

const ThemeSchema = z.object({
  theme: z.union(['dark', 'light']).default('dark'),
  fontSize: z.number().default(14),
})

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-settings-scopes-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(path: string): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(FileSettingsProvider, { path, watch: false })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  ctx.settings.register('ui-theme', ThemeSchema)
  return ctx
}

describe('scoped sections on disk', () => {
  it('writes a scoped section under scopes.<id>.<ns>, creating the map, and keeps comments elsewhere', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    await writeFile(path, '# my settings\nui-theme:\n  fontSize: 18 # big\n')
    const ctx = await boot(path)

    await ctx.settings.update('ui-theme', { theme: 'light' }, undefined, 'preset/standard')
    await ctx.settings.update('ui-theme', { fontSize: 9 }, undefined, 'preset/standard')

    expect(await readFile(path, 'utf8')).toBe([
      '# my settings',
      'ui-theme:',
      '  fontSize: 18 # big',
      'scopes:',
      '  preset/standard:',
      '    ui-theme:',
      '      theme: light',
      '      fontSize: 9',
      '',
    ].join('\n'))
    expect(ctx.settings.describe({ scope: 'preset/standard' })[0]).toMatchObject({
      value: { theme: 'light', fontSize: 9 },
      user: { theme: 'light', fontSize: 9 },
      inherited: { theme: 'dark', fontSize: 18 },
    })
  })

  it('starts an absent document with the scoped section alone', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const ctx = await boot(path)

    await ctx.settings.update('ui-theme', { theme: 'light' }, undefined, 'preset/standard')

    expect(await readFile(path, 'utf8')).toBe('scopes:\n  preset/standard:\n    ui-theme:\n      theme: light\n')
  })

  it('reads a scoped section back on the next boot', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.yaml')
    const first = await boot(path)
    await first.settings.update('ui-theme', { theme: 'light' }, undefined, 'preset/standard')
    await first.settings.update('ui-theme', { fontSize: 20 })

    const second = await boot(path)

    expect(second.settings.describe({ scope: 'preset/standard' })[0]?.value).toEqual({ theme: 'light', fontSize: 20 })
    expect(second.settings.describe()[0]?.value).toEqual({ theme: 'dark', fontSize: 20 })
  })

  it('writes scoped sections into a JSON document', async () => {
    const dir = await tempDir()
    const path = join(dir, 'settings.json')
    await writeFile(path, JSON.stringify({ 'ui-theme': { fontSize: 18 } }))
    const ctx = await boot(path)

    await ctx.settings.update('ui-theme', { theme: 'light' }, undefined, 'preset/standard')
    await ctx.settings.update('ui-theme', { fontSize: 9 }, undefined, 'preset/research')

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      'ui-theme': { fontSize: 18 },
      scopes: { 'preset/standard': { 'ui-theme': { theme: 'light' } }, 'preset/research': { 'ui-theme': { fontSize: 9 } } },
    })
  })
})
