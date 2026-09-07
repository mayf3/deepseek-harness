/**
 * Plugin management over a dsh profile, shared by the `dsh plugin` command
 * and the Web host's `plugins` Remote.
 *
 * {@link PluginInstaller} changes what a profile has installed: it runs pnpm
 * in the profile directory, probes every new package in a child process, and
 * removes what has no place in a profile. It needs the profile on disk, not
 * a booted tree, so the CLI uses it before any plugin starts.
 * {@link PluginManager} adds the operations that need the booted tree —
 * enabling, disabling, and retrying bundles through the profile runtime,
 * rows in user layers, dependents, and one folded view per package — and
 * runs every mutation one at a time. Neither knows the Remote protocol: a
 * refusal or failure is a {@link PluginOperationError} carrying a `plugins/*`
 * code, which the Web host's adapter turns into a RemoteError of the same
 * code.
 * @module @deepseek-ai/dsh-plugin-manager
 */

export * from './errors.ts'
export type * from './types.ts'
export type { PluginToolingConfig, SpawnLike } from './helpers.ts'
export { PluginInstaller, type PluginInstallerOptions, type PluginInstallOutcome } from './installer.ts'
export { PluginManager, type PluginManagerOptions, type PresetLayers } from './manager.ts'

/** Group id of an isolated bundle, for callers that address its rows in the tree. */
export { bundleGroupId } from '@deepseek-ai/dsh-app-boot'
