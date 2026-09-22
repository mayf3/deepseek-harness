/**
 * Keep every bare import a Desktop bundle leaves to the runtime resolvable
 * inside the packaged application.
 *
 * electron-builder copies only the manifest's `dependencies` into
 * `app.asar/node_modules`, so a bare import of anything else bundles without
 * complaint and fails at launch with `ERR_MODULE_NOT_FOUND`. The main-process
 * bundle inlines its workspace devDependencies; when one of their `lib/`
 * outputs is missing at bundle time, rolldown reports `UNRESOLVED_IMPORT` as a
 * warning and keeps the specifier as an external import, which is exactly the
 * broken artifact. Sandboxed preloads may `require` only `electron`. This
 * check fails the bundle instead of the installed application.
 */

import { isBuiltin } from 'node:module'

/**
 * Package name of a bare import specifier.
 * @param {string} specifier - Bare specifier as rolldown reports it, such as `@scope/name/subpath`.
 * @returns {string} The package name without its subpath.
 */
export function importPackageName(specifier) {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

/**
 * Bare imports the packaged application cannot resolve.
 * @param {readonly string[]} imports - External specifiers a chunk imports, statically or dynamically.
 * @param {ReadonlySet<string>} packaged - Package names available to the bundle at runtime.
 * @returns {string[]} Offending specifiers in import order, each once.
 */
export function unpackagedImports(imports, packaged) {
  const offending = new Set()
  for (const specifier of imports) {
    if (isBuiltin(specifier)) continue
    if (packaged.has(importPackageName(specifier))) continue
    offending.add(specifier)
  }
  return [...offending]
}

/**
 * Rolldown plugin that fails a bundle whose external imports the packaged
 * application cannot resolve.
 * @param {ReadonlySet<string>} packaged - Package names available to the bundle at runtime.
 * @returns {import('tsdown').Rolldown.Plugin} The plugin.
 */
export function packagedImportsPlugin(packaged) {
  return {
    name: 'desktop-packaged-imports',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        const external = [...output.imports, ...output.dynamicImports].filter(specifier => !(specifier in bundle))
        const offending = unpackagedImports(external, packaged)
        if (offending.length === 0) continue
        this.error(
          `desktop bundle: ${output.fileName} imports ${offending.join(', ')}, which the packaged application does not ship. `
          + `A bare import must name electron or a package in this manifest's dependencies; anything else must be bundled, `
          + 'which requires its lib/ output to exist before this bundle runs (pnpm run build:lib:host).',
        )
      }
    },
  }
}
