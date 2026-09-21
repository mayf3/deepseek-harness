import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { desktopKeybindings } from '../src/keybindings.ts'
import type { ShortcutCommandId, ShortcutConfigSnapshot } from '@deepseek-ai/dsh-client-shortcuts/protocol'

it('persists into the supplied userData, reloads null bindings, and retains original future-version bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-keybindings-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  let state!: ShortcutConfigSnapshot
  const first = desktopKeybindings(root, 'windows', (value) => { state = value })
  onTestFinished(() => { first.dispose() })
  const id = 'test.toggle' as ShortcutCommandId
  const definitions = [{ id, defaults: { desktop: { code: 'KeyB', modifiers: ['primary'] as const } } }]
  first.setDefinitions(definitions)
  await first.reload()
  expect((await first.edit({ type: 'set', id, binding: null }, state.revision)).status).toBe('saved')
  const path = join(root, 'keybindings.json')
  expect(JSON.parse(await readFile(path, 'utf8')) as unknown).toMatchObject({ profiles: { 'desktop:windows': { [id]: null } } })
  const second = desktopKeybindings(root, 'windows', (value) => { state = value })
  onTestFinished(() => { second.dispose() })
  second.setDefinitions(definitions)
  expect((await second.reload()).document.profiles['desktop:windows']?.[id]).toBeNull()
  const original = '{"schemaVersion":7,"custom":"retain exactly"}\n'
  await writeFile(path, original)
  expect((await second.reload()).error).toBe('future')
  expect((await second.edit({ type: 'reset-all' }, state.revision)).status).toBe('unreadable')
  expect(await readFile(path, 'utf8')).toBe(original)
  expect((await second.edit({ type: 'recover' }, state.revision)).status).toBe('saved')
  const backup = (await readdir(root)).find(file => file.startsWith('keybindings.json.backup.'))!
  expect(await readFile(join(root, backup), 'utf8')).toBe(original)
  expect(JSON.parse(await readFile(path, 'utf8')) as unknown).toEqual({ schemaVersion: 2, profiles: {} })
})
