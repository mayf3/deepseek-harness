/**
 * Vocabulary the installer, the manager, and the view fold share: the
 * diagnostic prefix, the tooling bounds, the spawn seam, and the two profile
 * manifest readers a hand-written manifest may leave empty.
 * @module @deepseek-ai/dsh-plugin-manager/helpers
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import type { ProfileManifest } from '@deepseek-ai/dsh-app-boot'

/** Diagnostic prefix on errors this package raises and on the app-boot helpers it calls. */
export const NAME = 'plugin-manager'

/**
 * The message of a thrown value; a non-Error keeps its text.
 * @param error - the thrown value.
 * @returns its message.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The profile's installed dependencies by name; a hand-written manifest may omit the field.
 * @param manifest - the profile manifest.
 * @returns the dependencies, empty when absent.
 */
export function dependenciesOf(manifest: ProfileManifest): Record<string, string> {
  return manifest.dependencies ?? {}
}

/**
 * The profile's enabled layer list; a hand-written manifest may omit the section.
 * @param manifest - the profile manifest.
 * @returns the bundle names, empty when absent.
 */
export function bundlesOf(manifest: ProfileManifest): readonly string[] {
  return manifest.dsh?.profile?.bundles ?? []
}

/** The spawn function, replaceable in tests so no pnpm runs. */
export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** The pnpm command and the bounds on the child processes plugin management runs. */
export interface PluginToolingConfig {
  /** The pnpm executable name or path; resolved through `PATH` like the `dsh plugin` command. */
  readonly pnpmCommand: string
  /** Bound on one install or remove run, in milliseconds. */
  readonly installTimeoutMs: number
  /** How many trailing bytes of an install run's output an install failure reports. */
  readonly installLogTailBytes: number
}

/**
 * One optional field, present only when its value is.
 * @param key - the field name.
 * @param value - the value, or undefined for no field.
 * @returns an object with the field, or an empty object.
 */
export function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : { [key]: value } as { [P in K]?: V }
}
