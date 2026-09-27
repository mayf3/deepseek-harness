/** User decisions cross a real worker process; the worker replaces only the OS mutation boundary. */

import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { DesktopCommandManager } from '../src/command-management.ts'
import { en } from '../src/locale.ts'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, userInfo: () => ({ ...actual.userInfo(), shell: null }) }
})

async function fixture(failure?: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-command-dialog-'))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  const resources = join(root, 'resources')
  const bin = join(resources, 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin')
  const worker = join(resources, 'runtime', 'cli')
  await mkdir(bin, { recursive: true })
  await mkdir(worker, { recursive: true })
  const node = join(bin, process.platform === 'win32' ? 'node.exe' : 'node')
  if (process.platform === 'win32') await copyFile(process.execPath, node)
  else await symlink(process.execPath, node)
  await writeFile(join(worker, 'package.json'), '{"type":"module"}\n')
  const state = {
    fingerprint: 'a'.repeat(64), managed: false, available: true, kind: 'file',
    destination: join(root, process.platform === 'win32' ? 'dsh.exe' : 'dsh'),
    directory: root, launcher: join(root, 'desktop-dsh'), activeCommand: join(root, 'other-dsh'),
  }
  await writeFile(join(worker, 'state.json'), JSON.stringify({ state, failure }))
  await writeFile(join(worker, 'command-manager.js'), [
    "import { readFileSync, appendFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "const { state, failure } = JSON.parse(readFileSync(join(import.meta.dirname, 'state.json'), 'utf8'))",
    'const operation = process.argv[2]',
    "appendFileSync(join(import.meta.dirname, 'calls.jsonl'), JSON.stringify({operation, expected:process.argv[3]})+'\\n')",
    "if (operation === 'install' && failure) {",
    "  process.stdout.write(JSON.stringify({ok:false,code:failure,message:'worker declined'})); process.exitCode=1",
    '} else {',
    '  process.stdout.write(JSON.stringify({ok:true,state}))',
    '}',
    '',
  ].join('\n'))
  const show = vi.fn<(options: MessageBoxOptions) => Promise<MessageBoxReturnValue>>()
  const manager = new DesktopCommandManager({
    resources, isPackaged: true, isInstalledLocation: () => true, isInstalling: () => false, isQuitting: () => false,
    messages: () => en, show,
  })
  const calls = async (): Promise<Array<{ operation: string; expected?: string }>> =>
    (await readFile(join(worker, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { operation: string; expected?: string })
  return { manager, show, calls }
}

it('requires confirmation before replacing an existing command', async () => {
  const f = await fixture()
  f.show.mockResolvedValueOnce({ response: 0, checkboxChecked: false })
    .mockResolvedValueOnce({ response: 1, checkboxChecked: false })
  await f.manager.show()
  expect(f.show.mock.calls[1]![0]).toMatchObject({ message: en.cliCommandSwitch, defaultId: 1, cancelId: 1 })
  expect(await f.calls()).toEqual([{ operation: 'inspect' }])
})

it('passes the displayed fingerprint and reports a stale worker refusal', async () => {
  const f = await fixture('ESTALE')
  f.show.mockResolvedValue({ response: 0, checkboxChecked: false })
  await f.manager.show()
  expect(await f.calls()).toEqual([{ operation: 'inspect' }, { operation: 'install', expected: 'a'.repeat(64) }])
  expect(f.show.mock.lastCall![0].message).toBe(en.cliCommandChanged)
})

it('coalesces repeated menu clicks and keeps update preparation waiting for the active decision', async () => {
  const f = await fixture()
  const shown = Promise.withResolvers<undefined>()
  const choice = Promise.withResolvers<MessageBoxReturnValue>()
  f.show.mockImplementation(() => { shown.resolve(undefined); return choice.promise })
  const first = f.manager.show()
  expect(f.manager.show()).toBe(first)
  await shown.promise
  let idle = false
  const waiting = f.manager.idle().then(() => { idle = true })
  await Promise.resolve()
  expect(idle).toBe(false)
  choice.resolve({ response: 1, checkboxChecked: false })
  await Promise.all([first, waiting])
  expect(idle).toBe(true)
  expect(await f.calls()).toEqual([{ operation: 'inspect' }])
})
