import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DESKTOP_RUNTIME_FILE, desktopRuntimeId, runtimePath, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-runtime-'))
  roots.push(root)
  runtimeFixture(join(root, 'dsh'))
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('verifies a runtime after relocation without depending on build paths', () => {
  const root = fixture()
  const before = verifyDesktopRuntime(join(root, 'dsh'), '1.0.0')
  cpSync(join(root, 'dsh'), join(root, 'moved'), { recursive: true })
  expect(desktopRuntimeId(verifyDesktopRuntime(join(root, 'moved'), '1.0.0'))).toBe(desktopRuntimeId(before))
})
it.each(['changed', 'extra', 'missing'])('rejects %s runtime bytes', (operation) => {
  const dsh = join(fixture(), 'dsh')
  if (operation === 'changed') writeFileSync(join(dsh, 'package.json'), '{}')
  if (operation === 'extra') writeFileSync(join(dsh, 'extra'), '')
  if (operation === 'missing') rmSync(join(dsh, 'package.json'))
  expect(() => verifyDesktopRuntime(dsh, '1.0.0')).toThrow(/integrity/u)
})
it('rejects filesystem links and incompatible targets', () => {
  const dsh = join(fixture(), 'dsh')
  expect(() => verifyDesktopRuntime(dsh, '1.0.0', { platform: process.platform, arch: 'wrong' })).toThrow(/incompatible/u)
  symlinkSync(join(dsh, 'node_modules'), join(dsh, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => verifyDesktopRuntime(dsh, '1.0.0')).toThrow(/unsupported filesystem/u)
})
it('rejects a descriptor that maps a shared package outside node_modules', () => {
  const dsh = join(fixture(), 'dsh')
  const path = join(dsh, DESKTOP_RUNTIME_FILE)
  const descriptor = JSON.parse(readFileSync(path, 'utf8')) as { sharedPackages: { path: string }[] }
  descriptor.sharedPackages[0]!.path = '../outside'
  writeFileSync(path, JSON.stringify(descriptor))
  expect(() => verifyDesktopRuntime(dsh, '1.0.0')).toThrow(/shared package record/u)
})
it.each(['../outside', '/absolute', 'C:/absolute', 'a\\b', 'a//b', './a'])('rejects nonportable path %s', (path) => {
  expect(() => runtimePath('/runtime', path)).toThrow(/invalid relative path/u)
})
