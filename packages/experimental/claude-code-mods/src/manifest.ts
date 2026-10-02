/**
 * The plugin directory a mod ships as: `.claude-plugin/plugin.json` names it,
 * `hooks/hooks.json` points `modules` at the hooks module. Parsing and
 * validation are pure; the directory is read by {@link readModManifest}.
 * @module
 */

import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { messageOf } from './values.ts'
import type { PluginOptions, PluginOptionValue } from './types.ts'

/** The extensions Claude Code loads a hooks module from; this bridge imports them through Node. */
export const HOOKS_MODULE_EXTENSIONS: readonly string[] = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx']

/** Plugin names must stay path- and id-safe; Claude Code's own rule. */
const PLUGIN_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u

/** One `userConfig` field of the manifest: its default supplies `options` when the deployment sets none. */
interface UserConfigField {
  readonly default?: PluginOptionValue
}

/** The parsed manifest fields this bridge reads. */
export interface ModManifest {
  readonly name: string
  readonly version: string | undefined
  readonly description: string | undefined
  /** Field defaults declared under `userConfig`, by field name. */
  readonly userConfigDefaults: Readonly<Record<string, PluginOptionValue>>
}

/** A mod directory read and validated, before its module is imported. */
export interface ModDirectory {
  readonly manifest: ModManifest
  /** Absolute plugin directory. */
  readonly root: string
  /** Absolute path of the one hooks module `hooks.json` names. */
  readonly modulePath: string
  /** `hooks.json` also holds settings hooks under `hooks`, which this bridge does not run. */
  readonly hasSettingsHooks: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOptionValue(value: unknown): value is PluginOptionValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/**
 * Validate the parsed `plugin.json` value.
 * @param raw - the parsed JSON.
 * @param source - path used in error messages.
 * @returns the fields this bridge reads.
 */
export function parseModManifest(raw: unknown, source: string): ModManifest {
  if (!isRecord(raw)) throw new Error(`${source}: plugin.json must be a JSON object`)
  const { name, version, description, userConfig } = raw
  if (typeof name !== 'string' || !PLUGIN_NAME.test(name)) {
    throw new Error(`${source}: plugin.json "name" must be lowercase letters, digits, "_" or "-", up to 64 characters`)
  }
  if (version !== undefined && typeof version !== 'string') throw new Error(`${source}: plugin.json "version" must be a string`)
  if (description !== undefined && typeof description !== 'string') {
    throw new Error(`${source}: plugin.json "description" must be a string`)
  }
  const userConfigDefaults: Record<string, PluginOptionValue> = {}
  if (userConfig !== undefined) {
    if (!isRecord(userConfig)) throw new Error(`${source}: plugin.json "userConfig" must be an object of fields`)
    for (const [field, spec] of Object.entries(userConfig)) {
      if (!isRecord(spec)) throw new Error(`${source}: plugin.json userConfig.${field} must be an object`)
      const { default: fallback } = spec as UserConfigField
      if (fallback === undefined) continue
      if (!isOptionValue(fallback)) {
        throw new Error(`${source}: plugin.json userConfig.${field}.default must be a string, number, boolean, or string list`)
      }
      userConfigDefaults[field] = fallback
    }
  }
  return { name, version, description, userConfigDefaults }
}

/**
 * Validate the parsed `hooks.json` value and resolve its one module path.
 * @param raw - the parsed JSON.
 * @param hooksJsonPath - absolute path of the file, which relative module paths resolve against.
 * @returns the absolute module path and whether settings hooks are also declared.
 */
export function parseHooksJson(raw: unknown, hooksJsonPath: string): { modulePath: string; hasSettingsHooks: boolean } {
  if (!isRecord(raw)) throw new Error(`${hooksJsonPath}: hooks.json must be a JSON object`)
  const { modules, hooks } = raw
  if (!Array.isArray(modules) || modules.length !== 1 || typeof modules[0] !== 'string') {
    throw new Error(`${hooksJsonPath}: hooks.json "modules" must list exactly one module path`)
  }
  const relative = modules[0]
  if (isAbsolute(relative)) throw new Error(`${hooksJsonPath}: hooks.json module path must be relative to hooks.json`)
  const modulePath = resolve(dirname(hooksJsonPath), relative)
  if (!modulePath.startsWith(dirname(dirname(hooksJsonPath)) + sep)) {
    throw new Error(`${hooksJsonPath}: hooks.json module path must stay inside the plugin directory`)
  }
  if (!HOOKS_MODULE_EXTENSIONS.some(extension => modulePath.endsWith(extension))) {
    throw new Error(`${hooksJsonPath}: hooks module "${relative}" must end in one of ${HOOKS_MODULE_EXTENSIONS.join(', ')}`)
  }
  return { modulePath, hasSettingsHooks: hooks !== undefined }
}

/**
 * Overlay deployment option values on the manifest's `userConfig` defaults.
 * @param manifest - the parsed manifest.
 * @param configured - values the deployment sets for this plugin.
 * @returns the frozen `options` argument of `register`.
 */
export function resolvePluginOptions(manifest: ModManifest, configured: PluginOptions | undefined): PluginOptions {
  return Object.freeze({ ...manifest.userConfigDefaults, ...configured })
}

function readJson(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error: unknown) {
    throw new Error(`${path}: cannot read: ${messageOf(error)}`)
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch (error: unknown) {
    throw new Error(`${path}: invalid JSON: ${messageOf(error)}`)
  }
}

/**
 * Read and validate one mod directory.
 * @param dir - the plugin directory; a relative path resolves against `cwd`.
 * @param cwd - base for a relative `dir`.
 * @returns the validated directory, ready for its module to be imported.
 */
export function readModManifest(dir: string, cwd: string): ModDirectory {
  const root = resolve(cwd, dir)
  const manifestPath = resolve(root, '.claude-plugin', 'plugin.json')
  const hooksJsonPath = resolve(root, 'hooks', 'hooks.json')
  const manifest = parseModManifest(readJson(manifestPath), manifestPath)
  const { modulePath, hasSettingsHooks } = parseHooksJson(readJson(hooksJsonPath), hooksJsonPath)
  return { manifest, root, modulePath, hasSettingsHooks }
}
