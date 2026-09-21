/** Records the active Harness home for the Windows uninstaller without loading plugins. */
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Persist the home used by this Desktop launch in the existing Electron user-data directory.
 * @param userData - Electron's application data directory.
 * @param profile - Absolute reserved desktop profile directory.
 * @returns Completion of the UTF-16 INI write consumed by NSIS.
 */
export async function recordUninstallLocation(userData: string, profile: string): Promise<void> {
  const home = dirname(dirname(profile))
  if (/[\r\n\0]/.test(home)) throw new Error('Desktop uninstall location contains an unsupported character')
  await writeFile(join(userData, 'uninstall.ini'), `\uFEFF[Harness]\r\nHome=${home}\r\nHomeLength=${home.length}\r\n`, 'utf16le')
}
