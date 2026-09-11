/**
 * The modules a package offers a composition: how a declared `dsh.plugins`
 * entry is named as a row and derived into a row id, and its wire view.
 * @module @deepseek-ai/dsh-plugin-manager/modules
 */

import type { PackageMetadata } from '@deepseek-ai/dsh-app-boot'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { optional } from './helpers.ts'
import type { PluginPackageAddableView } from './types.ts'

/**
 * The row `name` for one declared addable module.
 * @param packageName - the package.
 * @param declared - the `dsh.plugins[].name`, `.` for the main export.
 * @returns the bare package for `.`, else `<package>/<subpath>`.
 */
export function moduleSpecifier(packageName: string, declared: string): string {
  if (declared === '.') return packageName
  return `${packageName}/${declared.replace(/^\.\//, '')}`
}

/**
 * The row id derived from a package name and module: the unscoped name, then the subpath.
 * @param packageName - the package.
 * @param declared - the `dsh.plugins[].name`, `.` for the main export.
 * @returns the row id.
 */
export function derivedRowId(packageName: string, declared: string): string {
  const base = packageName.replace(/^@/, '')
  return declared === '.' ? base : `${base}/${declared.replace(/^\.\//, '')}`
}

/**
 * The wire view of one declared addable module.
 * @param packageName - the package.
 * @param entry - the installed manifest’s module declaration.
 * @returns the view.
 */
export function addableView(packageName: string, entry: PackageMetadata['addable'][number]): PluginPackageAddableView {
  return {
    moduleName: moduleSpecifier(packageName, entry.name),
    declaredName: entry.name,
    ...optional('title', entry.title),
    // Config comes from the installed JSON manifest.
    ...optional('config', entry.config as JsonValue | undefined),
  }
}
