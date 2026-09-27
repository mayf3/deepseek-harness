/** Public dsh commands using the immutable runtime carried by the Desktop installation. */

import { realpathSync } from 'node:fs'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { runCli } from '@deepseek-ai/dsh/lib/bin.js'
import * as officeSkills from '@deepseek-ai/dsh-skill-office'
import { installOfficeEngineResolution, runtimeArchivePath } from './office-engine.ts'

/** Physical resources that a packaged CLI supplies to an enabled Office skill. */
export interface CliOfficeResources {
  readonly node: string
  readonly cli: string
  readonly assetRoot: string
}

/**
 * Supply physical Office paths without changing profile rows or explicit configuration.
 * The registration belongs to the root context and applies again during plugin reloads.
 * Defaults apply to the bundled Office plugin; separately installed copies supply their own physical resource paths.
 * @param ctx - Prepared launcher context, before profile plugins mount.
 * @param resources - Installed standalone Node, LibreOffice CLI, and skill assets.
 */
export function prepareCliOffice(ctx: Context, resources: CliOfficeResources): void {
  ctx.on('internal/config', function (this: Fiber, _config: unknown, next: () => unknown): unknown {
    const config = next()
    if (this.runtime?.callback !== officeSkills.apply) return config
    if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) return config
    const explicit: Record<string, unknown> = Object.fromEntries(Object.entries(config ?? {}))
    for (const [name, value] of Object.entries(resources)) {
      if (explicit[name] === undefined) explicit[name] = value
    }
    return explicit
  }, { prepend: true, global: true })
}

/**
 * Run the ordinary CLI with Desktop's bundled package manager and physical resources.
 * @param runtimeDir - Prepared or ASAR-contained production DSH package tree.
 * @param supportDir - Physical Desktop runtime directory containing pnpm and Office resources.
 * @returns Completion of the selected CLI command; profile plugins own their process lifetime.
 */
export async function runDesktopCli(runtimeDir: string, supportDir: string): Promise<void> {
  installOfficeEngineResolution(runtimeDir)
  const archive = runtimeArchivePath(runtimeDir) === undefined ? undefined : dirname(realpathSync(runtimeDir))
  const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))
  const officeRoot = dirname(archive === undefined ? manifest : join(`${archive}.unpacked`, relative(archive, manifest)))
  await runCli({
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', join(supportDir, 'pnpm', 'bin', 'pnpm.mjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
        PATH: `${join(supportDir, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      },
    },
    prepare: (ctx) => { prepareCliOffice(ctx, {
      node: join(supportDir, 'primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
      cli: join(officeRoot, 'lib', 'cli.js'),
      assetRoot: join(supportDir, 'office-skills'),
    }) },
  })
}

if (import.meta.main) {
  if (process.platform === 'win32') {
    const { installWindowsCliSignals } = await import('./windows-cli-signals.ts')
    installWindowsCliSignals()
  }
  const runtimeDir = resolve(import.meta.dirname, '../../../..')
  await runDesktopCli(runtimeDir, join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), 'runtime'))
}
