/** Upload one validated Desktop release to its Tencent COS update directory. */

import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import type { DesktopPackageTargetName } from './package-target.ts'
import { createDesktopCos } from './desktop-cos.ts'
import { loadDesktopPackageEnvironment } from './desktop-package-environment.mjs'
import { createDesktopUploadPlan } from './desktop-upload-plan.ts'
import { uploadDesktopRelease } from './desktop-upload-run.ts'

const SUPPORTED_TARGETS = new Set<DesktopPackageTargetName>(['mac-arm64', 'mac-x64', 'win-x64'])

function targetName(value: string): DesktopPackageTargetName {
  if (!SUPPORTED_TARGETS.has(value as DesktopPackageTargetName)) {
    throw new Error(`desktop upload: unsupported target ${JSON.stringify(value)}; expected ${[...SUPPORTED_TARGETS].join(', ')}`)
  }
  return value as DesktopPackageTargetName
}

function requiredEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`desktop upload: ${name} must be set to a non-empty value`)
  }
  return value
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true })
  const target = positionals[0]
  if (target === undefined || positionals.length !== 1) {
    throw new Error('desktop upload: expected exactly one target')
  }
  const name = targetName(target)
  const environment = loadDesktopPackageEnvironment(name === 'win-x64' ? 'win32' : 'darwin')
  const plan = await createDesktopUploadPlan(name, { environment })
  const cos = createDesktopCos({
    secretId: requiredEnvironmentValue(environment, plan.secretIdEnvName),
    secretKey: requiredEnvironmentValue(environment, plan.secretKeyEnvName),
  })
  process.stdout.write(`desktop upload: ${plan.target} ${plan.version} -> ${plan.publicUrl}\n`)
  await uploadDesktopRelease(plan, cos, resolve(import.meta.dirname, '../.desktop-build/upload-records'))
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main().catch(() => {
    process.stderr.write('desktop upload: failed; inspect the printed record directory if allocated. No automatic retry; reconcile remote state before another upload.\n')
    process.exitCode = 1
  })
}
