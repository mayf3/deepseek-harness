/**
 * The probe's child process: resolve cordis from the probed package, import
 * its main export and every declared addable module, and send one report
 * over the IPC channel the parent opened. stdout and stderr stay the
 * imported modules' own, so a package that prints at import still reports.
 * Arguments: the package directory, the main specifier (empty for none), and
 * the addable specifiers as a JSON array. Nothing here runs inside the host.
 * @module @deepseek-ai/dsh-app-boot/probe-child
 */

import { pathToFileURL } from 'node:url'
import type { ChildInspection, ChildReport } from './probe-report.ts'

const [dir = '', mainSpecifier = '', addableJson = '[]'] = process.argv.slice(2)
const base = pathToFileURL(`${dir}/package.json`).href

/** Import one module from the package and describe what it exports. */
async function inspect(specifier: string): Promise<ChildInspection> {
  try {
    const mod = await import(import.meta.resolve(specifier, base)) as Record<string, unknown>
    const plugin = mod.default ?? mod
    const schema = (plugin as { Config?: unknown }).Config ?? mod.Config
    const toJSON = (schema as { toJSON?: unknown } | null | undefined)?.toJSON
    return {
      ok: true,
      isPlugin: typeof plugin === 'function' || typeof (plugin as { apply?: unknown }).apply === 'function',
      configSchema: typeof toJSON === 'function' ? (toJSON as () => unknown).call(schema) : null,
    }
  } catch (error) {
    return { ok: false, isPlugin: false, configSchema: null, error: String((error as { stack?: unknown } | null)?.stack ?? error) }
  }
}

const report: ChildReport = { cordis: null, main: { ok: false, isPlugin: false, configSchema: null }, addable: {} }
try {
  report.cordis = import.meta.resolve('@deepseek-ai/cordis', base)
} catch {
  report.cordis = null // the package resolves no cordis at all: a library, or a plugin without the peer installed
}
if (mainSpecifier !== '') report.main = await inspect(mainSpecifier)
for (const name of JSON.parse(addableJson) as string[]) report.addable[name] = await inspect(name)
process.send?.(report, undefined, undefined, () => { process.disconnect() })
