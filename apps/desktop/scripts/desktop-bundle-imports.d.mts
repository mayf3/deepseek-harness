import type { Rolldown } from 'tsdown'

/**
 * Package name of a bare import specifier.
 * @param specifier - Bare specifier as rolldown reports it, such as `@scope/name/subpath`.
 * @returns The package name without its subpath.
 */
export function importPackageName(specifier: string): string

/**
 * Bare imports the packaged application cannot resolve.
 * @param imports - External specifiers a chunk imports, statically or dynamically.
 * @param packaged - Package names available to the bundle at runtime.
 * @returns Offending specifiers in import order, each once.
 */
export function unpackagedImports(imports: readonly string[], packaged: ReadonlySet<string>): string[]

/**
 * Rolldown plugin that fails a bundle whose external imports the packaged
 * application cannot resolve.
 * @param packaged - Package names available to the bundle at runtime.
 * @returns The plugin.
 */
export function packagedImportsPlugin(packaged: ReadonlySet<string>): Rolldown.Plugin
