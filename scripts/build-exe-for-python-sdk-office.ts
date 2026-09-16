/** Keep LibreOffice workers, prebuilt engines, and their dependencies on the real filesystem. */
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'

/** pkg applies these exclusions to dependency `files` as well as root asset globs. */
export const OFFICE_ASSET_IGNORES = [
  '**/node_modules/@deepseek-ai/libreoffice-kit/**',
  '**/node_modules/@deepseek-ai/libreoffice-kit-*/**',
]

interface PackageManifest {
  name: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  os?: string[]
  cpu?: string[]
}

/**
 * Copy the installed Office dependency tree without changing package contents or executable modes.
 * Harness sidecars require the target native engine on macOS/Windows and WASM on Linux.
 * Missing target engines fail with their package name; missing required dependencies or paths outside the deployed closure also fail.
 * @param staging - Symlink-free deployed Node closure.
 * @param destination - Target-specific Office directory beside the executable; replaced when present.
 * @param target - Node platform and CPU of the executable.
 * @returns Relative package directories included in the sidecar.
 */
export async function copyOfficeSidecar(
  staging: string,
  destination: string,
  target: { platform: string; arch: string },
): Promise<string[]> {
  const engineName = `@deepseek-ai/libreoffice-kit-${target.platform === 'linux' ? 'wasm' : `${target.platform}-${target.arch}`}`
  const packages = new Set<string>()

  async function visit(packageDirectory: string): Promise<void> {
    if (packages.has(packageDirectory)) return
    const relativeDirectory = relative(staging, packageDirectory)
    if (isAbsolute(relativeDirectory) || relativeDirectory === '..' || relativeDirectory.startsWith(`..${sep}`)) {
      throw new Error(`Python Office dependency is outside the deployed closure: ${packageDirectory}`)
    }
    const manifestPath = join(packageDirectory, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as PackageManifest
    packages.add(packageDirectory)
    const require = createRequire(manifestPath)
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    for (const name of dependencies) {
      if (name.startsWith('@deepseek-ai/libreoffice-kit-') && name !== engineName) continue
      const optional = manifest.optionalDependencies?.[name] !== undefined
        || manifest.peerDependenciesMeta?.[name]?.optional === true
      const dependencyDirectory = (require.resolve.paths(name) ?? [])
        .map(directory => join(directory, name))
        .find(directory => existsSync(directory))
      if (dependencyDirectory === undefined) {
        if (optional) continue
        throw new Error(`Python Office dependency ${name} required by ${manifest.name} is missing.`)
      }
      if (optional) {
        const dependency = JSON.parse(await readFile(join(dependencyDirectory, 'package.json'), 'utf8')) as PackageManifest
        if (!supports(dependency.os, target.platform) || !supports(dependency.cpu, target.arch)) continue
      }
      await visit(dependencyDirectory)
    }
  }

  await visit(join(staging, 'node_modules', '@deepseek-ai', 'libreoffice-kit'))
  const engineDirectory = join(staging, 'node_modules', engineName)
  if (!existsSync(engineDirectory)) throw new Error(`Python Office engine ${engineName} required for ${target.platform}/${target.arch} is missing.`)
  await visit(engineDirectory)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  const directories = [...packages].sort()
  for (const source of directories) {
    const nestedModules = join(source, 'node_modules')
    await cp(source, join(destination, relative(staging, source)), {
      recursive: true,
      filter: path => path !== nestedModules && !path.startsWith(nestedModules + sep),
    })
  }
  return directories.map(directory => relative(staging, directory))
}

function supports(values: string[] | undefined, value: string): boolean {
  return values === undefined || (!values.includes(`!${value}`)
    && (values.every(item => item.startsWith('!')) || values.includes(value) || values.includes('any')))
}
