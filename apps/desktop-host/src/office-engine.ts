/** Resolve packaged Office engine manifests from their complete, unpacked resource directories. */
import { registerHooks, type ModuleHooks } from 'node:module'
import { realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Keep engine executable and resource paths usable by native child processes outside Electron.
 * @param runtimeDir - Prepared or ASAR-contained dsh runtime directory.
 * @returns Installed resolver for the Host lifetime, or undefined for a non-ASAR runtime.
 */
export function installOfficeEngineResolution(runtimeDir: string): ModuleHooks | undefined {
  if (basename(dirname(runtimeDir)) !== 'app.asar') return undefined
  const root = realpathSync(runtimeDir)
  const archive = dirname(root)
  const source = pathToFileURL(join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit-')).href
  const destination = pathToFileURL(join(`${archive}.unpacked`, 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit-')).href
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      if (!specifier.startsWith('@deepseek-ai/libreoffice-kit-') || !resolved.url.startsWith(source)) return resolved
      const physical = realpathSync(fileURLToPath(destination + resolved.url.slice(source.length)))
      return { ...resolved, url: pathToFileURL(physical).href }
    },
  })
}
