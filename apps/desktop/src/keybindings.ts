/** Device-local shortcut preferences in Electron userData; writes share one serialized coordinator. */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ShortcutPersistence } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import type { ShortcutConfigSnapshot, ShortcutPlatform } from '@deepseek-ai/dsh-client-shortcuts/protocol'

/**
 * Open the device configuration with atomic replacement and exclusive recovery backups.
 * @param userData - Electron-owned userData directory, never a Renderer-supplied path.
 * @param platform - local input platform.
 * @param publish - updates the native binding index and trusted product page after commit.
 * @returns the single-writer transaction coordinator.
 */
export function desktopKeybindings(userData: string, platform: ShortcutPlatform,
  publish: (snapshot: ShortcutConfigSnapshot) => void): ShortcutPersistence {
  const path = join(userData, 'keybindings.json')
  return new ShortcutPersistence({
    read: async () => {
      try { return await readFile(path, 'utf8') } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },
    write: raw => writeFileAtomic(path, raw, { mode: 0o600, dirMode: 0o700 }),
    backup: raw => writeFile(`${path}.backup.${randomUUID()}`, raw, { mode: 0o600, flag: 'wx' }),
  }, 'desktop', platform, false, publish)
}
