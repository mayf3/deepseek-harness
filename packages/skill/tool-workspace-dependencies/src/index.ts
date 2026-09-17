/** Model-facing query for a bundled Python, Node.js, and pnpm payload, in place or installed under the Harness home. */

import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis plugin identity. */
export const name = 'tool-workspace-dependencies'
/** Registry the tool registers into. */
export const inject = ['tools']

/** Payload location and optional installation directory. */
export interface Config {
  /** Payload directory carrying `runtime.json` and `dependencies/`. */
  readonly source: string
  /**
   * Installation directory under the Harness home. When set, the payload is copied there on the
   * first call (the Desktop behavior); when omitted, the payload is used in place without copying,
   * which suits read-only carriers such as container image layers.
   */
  readonly root?: string
}

/** Versions recorded by the payload build, independent of user-installed packages. */
export interface PrimaryRuntimeManifest {
  readonly desktopVersion: string
  readonly platform: string
  readonly arch: string
  /** Locked payload identity; absent only in installations made before payload hashing. */
  readonly payloadDigest?: string
  /** Installed wheel distribution versions; absent in older release manifests. */
  readonly pythonPackages?: Readonly<Record<string, string>>
  readonly components: {
    readonly python: string
    /** Absent when the payload ships no Node.js. */
    readonly node?: string
    /** Absent when the payload ships no pnpm. */
    readonly pnpm?: string
    readonly numpy: string
    readonly pandas: string
  }
}

/** Absolute entry points and bundled versions; pnpm runs through the returned Node executable. */
export interface WorkspaceDependencies {
  readonly python: string
  readonly node?: string
  readonly pnpm?: string
  readonly pythonPackages: string
  readonly nodePackages?: string
  /** Locked distribution versions; excludes packages users add to the installed environment. */
  readonly pythonDistributions: Readonly<Record<string, string>>
}

const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u
const PLATFORMS = ['win32', 'darwin', 'linux']

function isVersion(value: unknown): boolean {
  return typeof value === 'string' && VERSION.test(value)
}

/**
 * Read build metadata, rejecting duplicate normalized names and conflicting component/distribution versions.
 * @param root - Installed or bundled primary runtime directory.
 * @returns Validated component versions and target identifiers.
 */
export async function readPrimaryRuntime(root: string): Promise<PrimaryRuntimeManifest> {
  const value: unknown = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'))
  if (typeof value !== 'object' || value === null) throw new Error('primary runtime: invalid metadata')
  const record = value as Record<string, unknown>
  const components = record.components as Record<string, unknown> | null | undefined
  const packages = record.pythonPackages
  if (typeof record.desktopVersion !== 'string' || record.desktopVersion.length === 0
    || !PLATFORMS.includes(String(record.platform)) || !['x64', 'arm64'].includes(String(record.arch))
    || typeof components !== 'object' || components === null
    || !['python', 'numpy', 'pandas'].every(key => isVersion(components[key]))
    || !['node', 'pnpm'].every(key => components[key] === undefined || isVersion(components[key]))
    || (record.payloadDigest !== undefined && (typeof record.payloadDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(record.payloadDigest)))
    || (packages !== undefined && (typeof packages !== 'object' || packages === null || Array.isArray(packages)
      || !Object.entries(packages).every(([name, version]) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)
        && typeof version === 'string' && /^\d[\w.!+-]*$/u.test(version))))) {
    throw new Error('primary runtime: invalid metadata')
  }
  const manifest = value as PrimaryRuntimeManifest
  const entries = Object.entries(manifest.pythonPackages ?? {})
  const distributions = new Map(entries.map(([name, version]) => [name.toLowerCase().replace(/[-_.]+/gu, '-'), version]))
  if (distributions.size !== entries.length) throw new Error('primary runtime: invalid metadata')
  for (const name of ['numpy', 'pandas'] as const) {
    const version = distributions.get(name)
    if (version !== undefined && version !== manifest.components[name]) {
      throw new Error(`primary runtime: conflicting ${name} distribution version`)
    }
  }
  return manifest
}

/**
 * Resolve platform-specific interpreter and library locations without changing the environment.
 * @param root - Absolute payload or installation directory.
 * @param manifest - Validated runtime metadata.
 * @returns Absolute paths for explicit script execution and recorded bundled Python versions.
 */
export function workspaceDependencyPaths(root: string, manifest: PrimaryRuntimeManifest): WorkspaceDependencies {
  const dependencies = join(root, 'dependencies')
  const windows = manifest.platform === 'win32'
  const node = manifest.components.node === undefined ? {} : {
    node: join(dependencies, 'node', 'bin', windows ? 'node.exe' : 'node'),
    nodePackages: join(dependencies, 'node', 'node_modules'),
  }
  const pnpm = manifest.components.pnpm === undefined ? {} : { pnpm: join(dependencies, 'pnpm', 'bin', 'pnpm.mjs') }
  return {
    python: join(dependencies, 'python', ...(windows ? ['python.exe'] : ['bin', 'python3'])),
    ...node,
    ...pnpm,
    pythonPackages: join(dependencies, 'python', ...(windows ? ['Lib'] : ['lib', `python${manifest.components.python.split('.').slice(0, 2).join('.')}`]), 'site-packages'),
    pythonDistributions: manifest.pythonPackages ?? {},
  }
}

function payloadEntries(paths: WorkspaceDependencies): string[] {
  return [paths.python, paths.node, paths.pnpm, paths.pythonPackages, paths.nodePackages]
    .filter((path): path is string => path !== undefined)
}

async function exists(path: string): Promise<boolean> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`primary runtime: installation path is a filesystem link: ${path}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function compatibleManifest(source: string): Promise<PrimaryRuntimeManifest> {
  const manifest = await readPrimaryRuntime(source)
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('primary runtime: incompatible platform or architecture')
  return manifest
}

/**
 * Use a payload where it lies: validate its metadata and entries, copying nothing.
 * @param source - Payload directory, typically a read-only carrier.
 * @returns Paths into the payload itself.
 */
export async function resolvePrimaryRuntime(source: string): Promise<WorkspaceDependencies> {
  const paths = workspaceDependencyPaths(source, await compatibleManifest(source))
  for (const path of payloadEntries(paths)) await stat(path)
  return paths
}

/**
 * Install the application-owned payload locally, retaining a complete previous tree on copy failure.
 * @param source - Payload carried by the current installation.
 * @param root - Fixed primary runtime directory under the Harness home.
 * @returns Paths into the installed payload; no PATH or package-manager configuration is changed.
 */
export async function installPrimaryRuntime(source: string, root: string): Promise<WorkspaceDependencies> {
  const manifest = await compatibleManifest(source)
  await mkdir(dirname(root), { recursive: true })
  const previous = `${root}.previous`
  await exists(previous)
  await exists(root)
  if (!await exists(root) && await exists(previous)) await rename(previous, root)
  if (await exists(join(root, 'runtime.json')) && JSON.stringify(await readPrimaryRuntime(root)) === JSON.stringify(manifest)) {
    const paths = workspaceDependencyPaths(root, manifest)
    for (const path of payloadEntries(paths)) await stat(path)
    return paths
  }
  const staging = await mkdtemp(join(dirname(root), '.primary-runtime-'))
  try {
    await cp(source, staging, { recursive: true, dereference: true })
    const paths = workspaceDependencyPaths(staging, manifest)
    for (const path of payloadEntries(paths)) await stat(path)
    await rm(previous, { recursive: true, force: true })
    const replacing = await exists(root)
    if (replacing) await rename(root, previous)
    try { await rename(staging, root) } catch (error) {
      if (replacing) await rename(previous, root)
      throw error
    }
    await rm(previous, { recursive: true, force: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return workspaceDependencyPaths(root, manifest)
}

/**
 * Register the read-only path query; the first invocation prepares (or merely validates) the payload.
 * @param ctx - Tool registry owner.
 * @param config - Payload location and optional installation directory.
 */
export function apply(ctx: Context, config: Config): void {
  if (!isAbsolute(config.source) || (config.root !== undefined && !isAbsolute(config.root))) {
    throw new Error('workspace dependencies: source and root must be absolute paths')
  }
  let preparation: Promise<WorkspaceDependencies> | undefined
  ctx.effect(() => async () => {
    // Tool execution reports preparation failures; disposal only waits for filesystem work to settle.
    await preparation?.catch(() => undefined)
  })
  ctx.tools.register(defineTool({
    name: 'load_workspace_dependencies',
    description: 'Get absolute paths to bundled Python, Node.js, pnpm, and library directories, plus bundled Python distribution versions. Python includes numpy, pandas, python-docx, python-pptx, openpyxl, Pillow, lxml, and XlsxWriter. Use these libraries for Office files unless the user or workspace instructions select another environment. Run pnpm with the returned Node executable and pnpm script path. This does not change PATH or package-manager settings.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          python: { type: 'string', required: true },
          node: { type: 'string', description: 'Absent when the payload ships no Node.js.' },
          pnpm: { type: 'string', description: 'Absent when the payload ships no pnpm.' },
          pythonPackages: { type: 'string', required: true },
          nodePackages: { type: 'string', description: 'Absent when the payload ships no Node.js.' },
          pythonDistributions: { type: 'object', additionalProperties: true, required: true, description: 'Bundled distribution names and versions recorded in runtime.json; excludes user-installed additions.' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
    },
    execute: () => {
      preparation ??= (config.root === undefined ? resolvePrimaryRuntime(config.source) : installPrimaryRuntime(config.source, config.root))
        .catch((error: unknown) => {
          preparation = undefined
          throw error
        })
      return preparation
    },
    presentCall: () => ({ card: 'generic', title: 'Load workspace dependencies', kind: 'read' }),
  }))
}
