/** Prepare pinned, relocatable script interpreters without installing into the build host. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import extractZip from 'extract-zip'
import { x as extractTar } from 'tar'
import { workspaceDependencyPaths, type PrimaryRuntimeManifest } from '../../desktop-host/src/primary-runtime.ts'
import { resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import lock from './primary-runtime-lock.json' with { type: 'json' }

async function download(url: string, sha256: string, cache: string): Promise<string> {
  const destination = join(cache, sha256)
  let bytes: Buffer
  try { bytes = readFileSync(destination) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const response = await fetch(url)
    if (!response.ok) throw new Error(`primary runtime download: ${String(response.status)} ${url}`)
    bytes = Buffer.from(await response.arrayBuffer())
  }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error(`primary runtime download: checksum mismatch for ${url}`)
  writeFileSync(destination, bytes)
  return destination
}

async function pythonArchive(target: keyof typeof lock.targets, cache: string): Promise<string> {
  const artifact = lock.targets[target]
  const filename = `cpython-${lock.pythonVersion}+${lock.pythonRelease}-${artifact.pythonTarget}-install_only_stripped.tar.gz`
  return download(`https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonRelease}/${encodeURIComponent(filename)}`, artifact.pythonSha256, cache)
}

/**
 * Materialize the selected Desktop target's primary runtime in its build resources.
 * @param python - Build-host Python for wheel installation; defaults to the system command and is never copied into the payload.
 * @returns Resolves after dependency installation and native-target execution checks.
 */
export async function preparePrimaryRuntime(python?: string): Promise<void> {
  const target = resolveDesktopBuildTarget()
  const paths = resolveDesktopTargetBuildPaths()
  const artifact = lock.targets[target]
  mkdirSync(paths.runtime, { recursive: true })
  mkdirSync(paths.downloads, { recursive: true })
  const staging = mkdtempSync(join(tmpdir(), 'dsh-primary-'))
  try {
    const output = join(staging, 'payload')
    const dependencies = join(output, 'dependencies')
    mkdirSync(dependencies, { recursive: true })
    const nodeFilename = `node-v${lock.nodeVersion}-${artifact.nodeArchive}`
    const nodeArchive = await download(`https://nodejs.org/dist/v${lock.nodeVersion}/${nodeFilename}`, artifact.nodeSha256, paths.downloads)
    const unpackedNode = join(staging, 'node')
    mkdirSync(unpackedNode)
    if (target === 'win-x64') await extractZip(nodeArchive, { dir: unpackedNode })
    else await extractTar({ file: nodeArchive, cwd: unpackedNode })
    const nodeSource = join(unpackedNode, nodeFilename.replace(/\.(?:zip|tar\.gz)$/u, ''))
    mkdirSync(join(dependencies, 'node', 'bin'), { recursive: true })
    mkdirSync(join(dependencies, 'node', 'node_modules'))
    writeFileSync(join(dependencies, 'node', 'node_modules', 'README.txt'), 'Reserved for bundled Node packages. pnpm uses its default installation directories.\n')
    cpSync(join(nodeSource, ...(target === 'win-x64' ? ['node.exe'] : ['bin', 'node'])),
      join(dependencies, 'node', 'bin', target === 'win-x64' ? 'node.exe' : 'node'))
    cpSync(join(nodeSource, 'LICENSE'), join(dependencies, 'node', 'LICENSE'))
    await extractTar({ file: await pythonArchive(target, paths.downloads), cwd: dependencies })
    const require = createRequire(import.meta.url)
    const pnpmManifest = require.resolve('pnpm')
    const pnpm = JSON.parse(readFileSync(pnpmManifest, 'utf8')) as { version: string }
    cpSync(dirname(pnpmManifest), join(dependencies, 'pnpm'), { recursive: true, dereference: true })
    const desktop = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string }
    const manifest: PrimaryRuntimeManifest = {
      desktopVersion: desktop.version,
      platform: target === 'win-x64' ? 'win32' : 'darwin',
      arch: target === 'mac-arm64' ? 'arm64' : 'x64',
      components: {
        python: lock.pythonVersion, node: lock.nodeVersion, pnpm: pnpm.version,
        numpy: lock.numpyVersion, pandas: lock.pandasVersion,
      },
    }
    const entries = workspaceDependencyPaths(output, manifest)
    const buildPython = python ?? (process.platform === 'win32' ? 'python' : 'python3')
    const nativeTarget = resolveDesktopBuildTarget({}, process.platform, process.arch)
    const installedPackages = join(staging, 'python-packages')
    execFileSync(buildPython, ['-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--no-compile',
      '--only-binary=:all:', '--require-hashes', '--platform', artifact.wheelPlatform, '--python-version', '3.12', '--implementation', 'cp', '--abi', 'cp312',
      '--target', installedPackages, '-r', join(import.meta.dirname, 'primary-runtime-requirements.txt')], { stdio: 'inherit' })
    cpSync(installedPackages, entries.pythonPackages, { recursive: true })
    writeFileSync(join(output, 'runtime.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
    if (nativeTarget === target) {
      execFileSync(entries.python, ['-I', '-c', 'import numpy, pandas; assert numpy.arange(4).sum() == 6; assert pandas.DataFrame({"n": [1, 2]}).n.sum() == 3'], { stdio: 'inherit' })
      execFileSync(entries.node, ['-e', `if (process.versions.node !== ${JSON.stringify(lock.nodeVersion)}) process.exit(1)`], { stdio: 'inherit' })
      execFileSync(entries.node, [entries.pnpm, '--version'], { stdio: 'inherit' })
    }
    const destination = join(paths.runtime, 'primary-runtime')
    rmSync(destination, { recursive: true, force: true })
    cpSync(output, destination, { recursive: true, dereference: true })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { python: { type: 'string' } } })
  await preparePrimaryRuntime(values.python)
}
