/** Sign Windows runtime code before executing it, retaining vendor signatures and fail-stop hardware protection. */
import { X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createWindowsTokenSigner } from './windows-sign.mjs'
import { signWindowsCode, type WindowsCodeSigningOptions } from './windows-runtime-signature.mjs'
import { failPackagingRun, recordPackagingEvent } from './packaging-run.mjs'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { smokePrimaryRuntime } from './prepare-primary-runtime.ts'
import { verifyDesktopRuntime, writeDesktopRuntime, type DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'

/**
 * Sign the bundled interpreters before their smoke checks.
 * @param root Materialized primary runtime.
 * @param options Supervised signer, certificate identity, audit sink and runtime check.
 * @returns Resolves after verified signatures and a successful smoke.
 */
export async function signWindowsPrimaryRuntime(
  root: string, options: WindowsCodeSigningOptions & { smoke: (root: string) => void },
): Promise<void> {
  await signWindowsCode(root, options)
  options.smoke(root)
  options.record({ type: 'primary-runtime-smoke-success' })
}

/**
 * Seal application dependency hashes only after all Windows code is signed.
 * @param root Materialized production dependency directory.
 * @param version Expected release version.
 * @param options Supervised signing dependencies and a smoke receiving the signed descriptor.
 * @returns Resolves after final inventory verification and smoke; any failure stops the stage.
 */
export async function signWindowsDesktopRuntime(root: string, version: string,
  options: WindowsCodeSigningOptions & { smoke: (descriptor: DesktopRuntimeDescriptor) => Promise<void> }): Promise<void> {
  const descriptor = await verifyDesktopRuntime(root, version)
  await signWindowsCode(root, options)
  writeDesktopRuntime(root, descriptor.release, descriptor.sharedPackages.map(entry => entry.name))
  const signed = await verifyDesktopRuntime(root, version)
  await options.smoke(signed)
  await verifyDesktopRuntime(root, version)
}

async function main(): Promise<void> {
  if (process.platform !== 'win32' || resolveDesktopBuildTarget() !== 'win-x64') throw new Error('primary runtime signing requires Windows x64')
  const runDirectory = process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
  if (!runDirectory) throw new Error('primary runtime signing requires a supervised packaging run')
  await readFile(join(runDirectory, 'run.json'))
  const certificateFile = process.env.DSH_DESKTOP_WINDOWS_CER_FILE
  if (!certificateFile) throw new Error('primary runtime signing requires the configured certificate')
  const thumbprint = new X509Certificate(await readFile(certificateFile)).fingerprint.replaceAll(':', '')
  try {
    const paths = resolveDesktopTargetBuildPaths()
    const options = {
      thumbprint,
      sign: createWindowsTokenSigner({ certificateFile, signTool: process.env.DSH_DESKTOP_WINDOWS_SIGNTOOL,
        keyContainer: process.env.DSH_DESKTOP_WINDOWS_KEY_CONTAINER, tokenPin: process.env.DSH_DESKTOP_WINDOWS_TOKEN_PIN }),
      record: (event: object) => { recordPackagingEvent(runDirectory, event) },
    }
    if (process.argv.includes('--dsh')) {
      const version = JSON.parse(await readFile(join(paths.dsh, 'package.json'), 'utf8')).version as string
      await signWindowsDesktopRuntime(paths.dsh, version, { ...options,
        smoke: descriptor => smokePreparedRuntime(paths.dsh, join(paths.electron, 'electron.exe'), paths.runtime, descriptor),
      })
    } else {
      await signWindowsPrimaryRuntime(join(paths.runtime, 'primary-runtime'), { ...options, smoke: smokePrimaryRuntime })
    }
  } catch (error) {
    failPackagingRun(runDirectory, 'primary-runtime-signing-or-smoke-failed')
    throw error
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) await main()
