/** Real command entries and receipts; every test owns its destination directory. */

import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { inspectFileCommand, installFileCommand, removeFileCommand } from '../src/command-installation.ts'

const barrier = vi.hoisted(() => ({ afterRead: undefined as ((path: unknown) => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    const result = await actual.readFile(...args)
    await barrier.afterRead?.(args[0])
    return result
  } }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-command-link-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const launcher = join(root, 'desktop-launcher')
  await writeFile(launcher, 'desktop\n', { mode: 0o755 })
  return { root, options: { destination: join(root, 'dsh'), launcher } }
}

describe.skipIf(process.platform === 'win32')('macOS command entry ownership', () => {
  it('installs and removes only its own link', async () => {
    const f = await fixture()
    const before = await inspectFileCommand(f.options)
    const installed = await installFileCommand(f.options, before.fingerprint)
    expect(installed.managed).toBe(true)
    expect(await readlink(f.options.destination)).toBe(f.options.launcher)
    await removeFileCommand(f.options, installed.fingerprint)
    await expect(lstat(f.options.destination)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.options.launcher, 'utf8')).toBe('desktop\n')
  })

  it('preserves the raw target of an existing relative npm link and restores it', async () => {
    const f = await fixture()
    await writeFile(join(f.root, 'npm-cli'), 'npm\n', { mode: 0o755 })
    await symlink('npm-cli', f.options.destination)
    const installed = await installFileCommand(f.options, (await inspectFileCommand(f.options)).fingerprint)
    expect(await readlink(installed.backup!)).toBe('npm-cli')
    await removeFileCommand(f.options, installed.fingerprint)
    expect(await readlink(f.options.destination)).toBe('npm-cli')
    expect(await readFile(f.options.destination, 'utf8')).toBe('npm\n')
  })

  it('restores a regular executable with its bytes and permission bits', async () => {
    const f = await fixture()
    const bytes = Buffer.from([0, 1, 2, 255])
    await writeFile(f.options.destination, bytes, { mode: 0o751 })
    const installed = await installFileCommand(f.options, (await inspectFileCommand(f.options)).fingerprint)
    await removeFileCommand(f.options, installed.fingerprint)
    expect(await readFile(f.options.destination)).toEqual(bytes)
    expect((await lstat(f.options.destination)).mode & 0o777).toBe(0o751)
  })

  it('rejects a changed confirmation without moving the replacement', async () => {
    const f = await fixture()
    const before = await inspectFileCommand(f.options)
    await symlink('another-command', f.options.destination)
    await expect(installFileCommand(f.options, before.fingerprint)).rejects.toMatchObject({ code: 'ESTALE' })
    expect(await readlink(f.options.destination)).toBe('another-command')
  })

  it('repairs a moved application without replacing the original backup', async () => {
    const f = await fixture()
    await symlink('npm-cli', f.options.destination)
    const first = await installFileCommand(f.options, (await inspectFileCommand(f.options)).fingerprint)
    const moved = join(f.root, 'moved-desktop')
    await writeFile(moved, 'moved\n', { mode: 0o755 })
    await unlink(f.options.launcher)
    const options = { ...f.options, launcher: moved }
    const broken = await inspectFileCommand(options)
    expect(broken.managed).toBe(true)
    expect(broken.available).toBe(false)
    const repaired = await installFileCommand(options, broken.fingerprint)
    expect(repaired.backup).toBe(first.backup)
    expect(await readlink(options.destination)).toBe(moved)
    await removeFileCommand(options, repaired.fingerprint)
    expect(await readlink(options.destination)).toBe('npm-cli')
  })

  it.each(['install', 'remove'] as const)('preserves a replacement arriving during %s after the approved entry was read', async (operation) => {
    const f = await fixture()
    const installed = await installFileCommand(f.options, (await inspectFileCommand(f.options)).fingerprint)
    const receipt = join(f.root, '.dsh-desktop-command.json')
    const originalReceipt = await readFile(receipt, 'utf8')
    barrier.afterRead = async (path) => {
      if (path !== receipt) return
      barrier.afterRead = undefined
      await unlink(f.options.destination)
      await writeFile(f.options.destination, 'replacement\n', { mode: 0o755 })
    }
    onTestFinished(() => { barrier.afterRead = undefined })
    const apply = operation === 'install' ? installFileCommand : removeFileCommand
    await expect(apply(f.options, installed.fingerprint)).rejects.toMatchObject({ code: 'ESTALE' })
    expect(await readFile(f.options.destination, 'utf8')).toBe('replacement\n')
    expect(await readFile(receipt, 'utf8')).toBe(originalReceipt)
  })

  it('leaves a command installed by someone else after Desktop registration intact', async () => {
    const f = await fixture()
    await symlink('old-npm', f.options.destination)
    const installed = await installFileCommand(f.options, (await inspectFileCommand(f.options)).fingerprint)
    await unlink(f.options.destination)
    await symlink('new-npm', f.options.destination)
    const state = await inspectFileCommand(f.options)
    const removed = await removeFileCommand(f.options, state.fingerprint)
    expect(await readlink(f.options.destination)).toBe('new-npm')
    expect(removed.preservedBackup).toBe(installed.backup)
    expect(await readlink(installed.backup!)).toBe('old-npm')
  })

  it('refuses to restore a modified backup', async () => {
    const f = await fixture()
    await writeFile(f.options.destination, 'original\n', { mode: 0o755 })
    const installed = await installFileCommand(f.options, (await inspectFileCommand(f.options)).fingerprint)
    await writeFile(installed.backup!, 'changed backup with different bytes\n')
    await expect(removeFileCommand(f.options, installed.fingerprint)).rejects.toMatchObject({ code: 'EOWNERSHIP' })
    expect(await readlink(f.options.destination)).toBe(f.options.launcher)
  })

  it('rejects directories and non-executable launcher resources', async () => {
    const f = await fixture()
    await mkdir(f.options.destination)
    await expect(installFileCommand(f.options, (await inspectFileCommand(f.options)).fingerprint)).rejects.toMatchObject({ code: 'EUNSUPPORTED' })
    expect((await lstat(f.options.destination)).isDirectory()).toBe(true)
    await rm(f.options.destination, { recursive: true })
    await chmod(f.options.launcher, 0o644)
    await expect(installFileCommand(f.options, (await inspectFileCommand(f.options)).fingerprint)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects linked receipts and backup paths outside the command directory', async () => {
    const f = await fixture()
    const receipt = join(f.root, '.dsh-desktop-command.json')
    await symlink(f.options.launcher, receipt)
    await expect(inspectFileCommand(f.options)).rejects.toMatchObject({ code: 'EOWNERSHIP' })
    await unlink(receipt)
    await writeFile(receipt, JSON.stringify({
      schemaVersion: 1, launcher: f.options.launcher, installedFingerprint: '0'.repeat(64),
      backup: { name: '../../other-file', fingerprint: '0'.repeat(64) },
    }))
    await expect(inspectFileCommand(f.options)).rejects.toMatchObject({ code: 'EOWNERSHIP' })
    expect(await readFile(f.options.launcher, 'utf8')).toBe('desktop\n')
  })

  it('serializes simultaneous choices so only one stale snapshot can install', async () => {
    const f = await fixture()
    const state = await inspectFileCommand(f.options)
    const results = await Promise.allSettled([
      installFileCommand(f.options, state.fingerprint),
      installFileCommand(f.options, state.fingerprint),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect((await inspectFileCommand(f.options)).managed).toBe(true)
  })
})
