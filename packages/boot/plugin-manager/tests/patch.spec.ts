/** Profile patch edits preserve user-authored syntax and are idempotent. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { loadOptionalPatches } from '@deepseek-ai/dsh-app-boot'
import { writePluginEnabled } from '../src/patch.ts'

async function fixture(text?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'manager-patch-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'cordis.patch.yml')
  if (text !== undefined) await writeFile(file, text)
  return file
}

it('preserves comments, expressions, unrelated configuration and the last override', async () => {
  const file = await fixture('# personal configuration\n- id: tool\n  config:\n    value: !!js process.platform\n- id: tool\n  disabled: false # availability\n')
  expect(await writePluginEnabled(file, 'tool', false)).toBe(true)
  const text = await readFile(file, 'utf8')
  expect(text).toContain('# personal configuration')
  expect(text).toContain('!!js process.platform')
  expect(text).toContain('# availability')
  expect(loadOptionalPatches('test', file)).toEqual([
    { id: 'tool', config: { value: { __jsExpr: 'process.platform' } } }, { id: 'tool', disabled: true },
  ])
  expect(await writePluginEnabled(file, 'tool', false)).toBe(false)
  expect(await readFile(file, 'utf8')).toBe(text)
  expect(await writePluginEnabled(file, 'tool', true)).toBe(true)
})

it('creates a missing patch file and appends after insertions', async () => {
  const file = await fixture()
  await writePluginEnabled(file, 'tool', false)
  expect(loadOptionalPatches('test', file)).toEqual([{ id: 'tool', disabled: true }])
  await writeFile(file, '- insert:\n    - id: tool\n      name: package\n')
  await writePluginEnabled(file, 'tool', true)
  expect(loadOptionalPatches('test', file)).toEqual([
    { insert: [{ id: 'tool', name: 'package' }] }, { id: 'tool', disabled: false },
  ])
})

it.each(['- id: [broken', 'mapping: true\n'])('refuses malformed documents without overwriting %s', async (text) => {
  const file = await fixture(text)
  await expect(writePluginEnabled(file, 'tool', true)).rejects.toThrow()
  expect(await readFile(file, 'utf8')).toBe(text)
})


it('retains name-asserting overrides and appends an unambiguous switch', async () => {
  const file = await fixture('- id: tool\n  name: another-package\n  disabled: false\n')
  await writePluginEnabled(file, 'tool', false)
  expect(loadOptionalPatches('test', file)).toEqual([
    { id: 'tool', name: 'another-package', disabled: false }, { id: 'tool', disabled: true },
  ])
  expect(await writePluginEnabled(file, 'tool', false)).toBe(false)
})

it('reports read failures without replacing a directory with configuration', async () => {
  const file = await fixture()
  await mkdir(file)
  await expect(writePluginEnabled(file, 'tool', true)).rejects.toThrow()
})
