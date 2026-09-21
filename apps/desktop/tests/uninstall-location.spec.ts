/** The uninstaller reads the last launched home even when its environment differs. */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { recordUninstallLocation } from '../src/uninstall-location.ts'

it('records Unicode custom homes as a Windows-readable INI and replaces a previous launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-uninstall-'))
  try {
    await recordUninstallLocation(root, join(root, '旧目录', 'profiles', 'desktop'))
    const home = join(root, '新目录')
    await recordUninstallLocation(root, join(home, 'profiles', 'desktop'))
    expect(await readFile(join(root, 'uninstall.ini'), 'utf16le')).toBe(`\uFEFF[Harness]\r\nHome=${home}\r\nHomeLength=${home.length}\r\n`)
    await expect(recordUninstallLocation(root, join(root, 'bad\nHome=other', 'profiles', 'desktop'))).rejects.toThrow('unsupported character')
    expect(await readFile(join(root, 'uninstall.ini'), 'utf16le')).toContain(home)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
