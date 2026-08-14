/**
 * Verify that the executable deploy manifest supplies every plugin referenced
 * by a shipped agent preset and every required workspace peer in its dependency
 * graph. With auto peer installation disabled, either omission can otherwise
 * fail only when Cordis loads the packaged plugin.
 */
import { globSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as yaml from 'js-yaml'

interface JsExpr {
  __jsExpr: string
}

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

interface WorkspacePackage {
  path: string
  manifest: PackageManifest
}

interface RuntimePlatform {
  tag: string
  executable: string
}

type RuntimePlatformManifest = Record<string, RuntimePlatform>

const jsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: (data: unknown): JsExpr => {
    if (typeof data !== 'string') throw new TypeError('!!js requires a scalar string')
    return { __jsExpr: data }
  },
})
const schema = yaml.JSON_SCHEMA.extend(jsExprType)

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { manifest: { type: 'string' } },
})
const runtimeManifestPath = resolve(root, values.manifest ?? 'python/sdk-runtime/package.json')
const runtimeManifest = await loadManifest(runtimeManifestPath)
const runtimeName = runtimeManifest.name ?? 'python/sdk-runtime'
const workspace = await loadWorkspacePackages()
const runtimeDependencies = runtimeManifest.dependencies ?? {}
const platforms = await loadJson<RuntimePlatformManifest>(resolve(root, 'python/sdk-runtime/platforms.json'))
const parents = new Map<string, string | undefined>()
const queue: string[] = []

for (const dependency of Object.keys(runtimeDependencies).sort()) {
  if (!workspace.has(dependency)) continue
  parents.set(dependency, undefined)
  queue.push(dependency)
}

const failures = await missingPresetPlugins(runtimeDependencies, platforms)
for (let index = 0; index < queue.length; index += 1) {
  const packageName = queue[index]
  if (packageName === undefined) continue
  const current = workspace.get(packageName)
  if (current === undefined) continue
  const peers = current.manifest.peerDependencies ?? {}
  const peerMeta = current.manifest.peerDependenciesMeta ?? {}
  for (const peer of Object.keys(peers).sort()) {
    if (!workspace.has(peer) || peerMeta[peer]?.optional === true) continue
    if (runtimeDependencies[peer]?.startsWith('workspace:') === true) continue
    failures.push(`${formatChain(runtimeName, packageName, parents)} -> ${peer}`)
  }
  const dependencies = {
    ...current.manifest.dependencies,
    ...current.manifest.optionalDependencies,
  }
  for (const dependency of Object.keys(dependencies).sort()) {
    if (!workspace.has(dependency) || parents.has(dependency)) continue
    parents.set(dependency, packageName)
    queue.push(dependency)
  }
}

if (failures.length > 0) {
  console.error('verify-runtime-closure: preset plugins or required workspace peers are missing from python/sdk-runtime dependencies:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

const presetCount = globSync('apps/cli/config/agent-presets/*/agent.cordis.yml', { cwd: root }).length
console.log(
  `verify-runtime-closure: ${presetCount} agent presets and ${queue.length} workspace packages form a closed runtime dependency graph.`,
)

async function missingPresetPlugins(
  runtimeDependencies: Readonly<Record<string, string>>,
  platforms: RuntimePlatformManifest,
): Promise<string[]> {
  const missing = new Map<string, Set<string>>()
  const failures: string[] = []
  const presetPaths = globSync('apps/cli/config/agent-presets/*/agent.cordis.yml', { cwd: root }).sort()
  for (const presetPath of presetPaths) {
    const document: unknown = yaml.load(await readFile(resolve(root, presetPath), 'utf8'), { schema })
    if (!Array.isArray(document)) {
      failures.push(`${presetPath}: preset root must be a Loader entry array`)
      continue
    }
    for (const target of Object.keys(platforms).sort()) {
      const processPlatform = processPlatformForTarget(target)
      for (const plugin of activeBarePluginPackages(document, processPlatform)) {
        if (runtimeDependencies[plugin] !== undefined) continue
        const preset = basename(dirname(presetPath))
        const key = `${preset} preset -> ${plugin}`
        const targets = missing.get(key) ?? new Set<string>()
        targets.add(target)
        missing.set(key, targets)
      }
    }
  }
  failures.push(...[...missing.entries()].map(([chain, targets]) =>
    `${chain} (${[...targets].sort().join(', ')})`))
  return failures
}

function activeBarePluginPackages(entries: unknown[], processPlatform: string): Set<string> {
  const packages = new Set<string>()
  const visit = (value: unknown, parentDisabled: boolean): void => {
    if (!isRecord(value)) return
    const disabled = parentDisabled || disabledOnPlatform(value.disabled, processPlatform)
    if (disabled) return
    if (typeof value.name === 'string') {
      const packageName = barePackageName(value.name)
      if (packageName !== undefined) packages.add(packageName)
    }
    if (Array.isArray(value.config)) {
      for (const child of value.config) visit(child, disabled)
    }
  }
  for (const entry of entries) visit(entry, false)
  return packages
}

function disabledOnPlatform(value: unknown, processPlatform: string): boolean {
  if (typeof value === 'boolean') return value
  if (!isRecord(value) || typeof value.__jsExpr !== 'string') return false
  const match = /^process\.platform\s*(===|!==)\s*(['"])(win32|linux|darwin)\2$/.exec(value.__jsExpr.trim())
  if (match === null) return false
  const [, operator, , expected] = match
  return operator === '===' ? processPlatform === expected : processPlatform !== expected
}

function processPlatformForTarget(target: string): string {
  if (target.startsWith('linux-')) return 'linux'
  if (target.startsWith('macos-')) return 'darwin'
  throw new Error(`verify-runtime-closure: unsupported runtime target ${JSON.stringify(target)}`)
}

function barePackageName(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) return undefined
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined
  }
  return parts[0] || undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function loadWorkspacePackages(): Promise<Map<string, WorkspacePackage>> {
  const paths = globSync(['packages/*/*/package.json', 'vendor/*/package.json'], { cwd: root })
    .sort()
    .map(relative => resolve(root, relative))
  const result = new Map<string, WorkspacePackage>()
  for (const path of paths) {
    const manifest = await loadManifest(path)
    if (manifest.name !== undefined) result.set(manifest.name, { path, manifest })
  }
  return result
}

async function loadManifest(path: string): Promise<PackageManifest> {
  return loadJson<PackageManifest>(path)
}

async function loadJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

function formatChain(
  runtimeName: string,
  packageName: string,
  parents: ReadonlyMap<string, string | undefined>,
): string {
  const chain = [packageName]
  let parent = parents.get(packageName)
  while (parent !== undefined) {
    chain.unshift(parent)
    parent = parents.get(parent)
  }
  return [runtimeName, ...chain].join(' -> ')
}
