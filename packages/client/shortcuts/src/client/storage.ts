/** Explicit browser and Desktop preference adapters; Desktop never falls back to browser storage. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { ShortcutPersistence } from '../protocol.ts'
import type { DesktopShortcutsApi, ShortcutConfigSnapshot, ShortcutDefinition, ShortcutPlatform } from '../protocol.ts'

/** Browser-profile and origin-local key; recovery copies use a unique suffix. */
export const SHORTCUT_STORAGE_KEY = 'dsh.keybindings.v1'

/**
 * Connect localStorage and same-origin external updates to the shared transaction coordinator.
 * @param window - owning browser window.
 * @param platform - visiting device platform.
 * @param publish - accepts complete configuration snapshots.
 * @returns adapter and lifecycle disposal.
 */
export function webShortcutStorage(window: Window, platform: ShortcutPlatform,
  publish: (snapshot: ShortcutConfigSnapshot) => void): DesktopShortcutsApi & { dispose(): void } {
  const persistence = new ShortcutPersistence({
    read: () => window.localStorage.getItem(SHORTCUT_STORAGE_KEY),
    write: (raw) => { window.localStorage.setItem(SHORTCUT_STORAGE_KEY, raw) },
    backup: (raw) => { window.localStorage.setItem(`${SHORTCUT_STORAGE_KEY}.backup.${randomUUID()}`, raw) },
  }, 'web', platform, true, publish)
  const changed = (event: StorageEvent): void => {
    if (event.key === null || event.key === SHORTCUT_STORAGE_KEY) void persistence.reload()
  }
  window.addEventListener('storage', changed)
  return {
    get: (definitions: readonly ShortcutDefinition[]) => { persistence.setDefinitions(definitions); return persistence.reload() },
    reload: () => persistence.reload(), edit: (edit, revision) => persistence.edit(edit, revision),
    subscribe: () => () => {}, recording: async () => {},
    dispose: () => { window.removeEventListener('storage', changed); persistence.dispose() },
  }
}

/**
 * Read the origin-scoped preload capability; a missing bridge is an explicit configuration failure.
 * @param window - product window.
 * @returns the restricted Desktop API, or undefined while the preload is unavailable.
 */
export function desktopShortcutStorage(window: Window): DesktopShortcutsApi | undefined {
  return (window as Window & { dshDesktop?: { shortcuts?: DesktopShortcutsApi } }).dshDesktop?.shortcuts
}
