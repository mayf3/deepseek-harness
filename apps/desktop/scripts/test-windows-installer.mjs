/** Builds an isolated native payload through the production NSIS configuration and exercises its UI. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('Installer UI checks require an interactive Windows x64 desktop')
}
const execute = promisify(execFile)
const appRoot = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const { build, Platform, Arch } = require('electron-builder')
const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows.js')
const guid = randomUUID()
const id = guid.replaceAll('-', '')
const productName = `Harness Installer Test ${id.slice(0, 8)}`
const outputRoot = join(appRoot, '.desktop-build', 'installer-tests')
await mkdir(outputRoot, { recursive: true })
const output = await mkdtemp(join(outputRoot, 'run-'))
const payload = join(output, 'payload')
await mkdir(join(payload, 'resources'), { recursive: true })
const previousEnvironment = { ...process.env }
try {
  Object.assign(process.env, {
    DSH_DESKTOP_APP_ID: `com.deepseek.harness.installertest.n${id}`,
    DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64',
    DSH_DESKTOP_UNSIGNED: '1', CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_BUILDER_7Z_FILTER: 'BCJ',
  })
  const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
  const { scrubWindowsSigningEnvironment } = await import('./windows-sign.mjs')
  const childOptions = { env: scrubWindowsSigningEnvironment(process.env), windowsHide: true, maxBuffer: 8 * 1024 * 1024 }
  await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(appRoot, 'scripts', 'prepare-windows-installer.ps1'), '-OutputDirectory', join(output, 'ui')], childOptions)
  const payloadSource = join(output, 'payload.nsi')
  await writeFile(payloadSource, `Unicode true
RequestExecutionLevel user
ManifestDPIAware true
Name "${productName}"
OutFile "${join(payload, `${productName}.exe`)}"
SilentInstall silent
Section
  FileOpen $0 "$EXEDIR\\launched.txt" w
  FileWrite $0 "launched"
  FileClose $0
  MessageBox MB_OK "Installer test application is running."
SectionEnd
`)
  const compiler = await getMakeNsisPath()
  await execute(compiler.path, ['/V2', payloadSource], { ...childOptions, env: { ...childOptions.env, ...compiler.env } })
  const include = join(output, 'include.nsh')
  await writeFile(include, `!define INSTALLER_BUILD_DIR "${join(output, 'ui')}"\n!include "${join(appRoot, 'scripts', 'installer.nsh')}"\n`)
  const config = createElectronBuilderConfig()
  await build({ projectDir: appRoot, prepackaged: payload, targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), publish: 'never',
    config: { ...config, productName, artifactName: 'installer-test.exe', directories: { output },
      nsis: { ...config.nsis, guid, include }, beforeBuild: undefined, afterPack: undefined, afterSign: undefined, artifactBuildCompleted: undefined },
  })
  const result = await execute('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(appRoot, 'tests', 'windows-installer-smoke.ps1'), '-Installer', join(output, 'installer-test.exe'),
    '-ProductName', productName, '-RegistryKey', guid, '-OutputDirectory', output], childOptions)
  process.stdout.write(result.stdout)
} finally {
  for (const name of Object.keys(process.env)) if (!(name in previousEnvironment)) delete process.env[name]
  Object.assign(process.env, previousEnvironment)
  process.stdout.write(`Installer test artifacts: ${output}\n`)
}
