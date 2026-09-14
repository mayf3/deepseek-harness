/** Launcher-provided access to the current profile's serialized configuration lifecycle. */
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { Profile } from './profile.ts'

/** Current-process profile operations; callbacks run under the shared profile write lock. */
export interface ProfileRuntime {
  readonly name: string
  readonly dir: string
  readonly installAnchor: string
  readonly cwd: string
  readonly home: string
  /** Bundle packages used to start this process, before any persisted edits. */
  readonly startedBundles: readonly string[]
  readonly patchReload: 'live' | 'startup'
  /** Read the current manifest and bundle patch layers without initializing a profile.
   * @returns Resolved disk configuration.
   */
  read(): Profile
  /** Compose disk configuration with the invocation's higher-priority layers.
   * @returns Effective entry options in composition order.
   */
  entries(): EntryOptions[]
  /** Serialize a mutation with file watching and other profile writers.
   * @param operation Work performed while holding the profile manifest lock.
   * @param waitMs Maximum lock acquisition time; omission uses the file writer default.
   * @returns The operation's result.
   */
  mutate<T>(operation: () => Promise<T>, waitMs?: number): Promise<T>
  /** Apply the current disk configuration; call only inside mutate. */
  reload(): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present only in a profile launched by dsh. */
    profileRuntime: ProfileRuntime
  }
}
