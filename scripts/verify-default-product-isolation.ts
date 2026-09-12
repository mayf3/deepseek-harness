/** Keep experimental packages outside default installations, runtime imports, and shipped compositions. */

import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { isCordisGroupEntry, loadCordisYaml } from './cordis-yaml.ts'
import {
  collectRuntimeLocalSourceSpecifiers,
  collectRuntimeSourceSpecifiers,
} from './verify-client-packages.ts'

const EXPERIMENTAL_PREFIX = '@deepseek-ai/dsh-experimental-'
const PROFILE_SOURCE = 'packages/boot/app-boot/src/profile.ts'
const PRESET_PATTERN = 'packages/preset/agent-presets/presets/*/agent.cordis.yml'
const RUNTIME_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

interface Manifest {
  name: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string }; configTrees?: Array<{ path: string }> }
}

interface Package {
  directory: string
  manifest: Manifest
}

/** Counts and violations from the default product's source and configuration inputs. */
export interface ProductIsolationResult {
  failures: string[]
  packageCount: number
  sourceCount: number
  configCount: number
}

/**
 * Check default app installations and their authored runtime/configuration inputs.
 * Experimental opt-in packages and separate Web preview entries are outside these roots.
 * @param root - repository root; no build outputs or installed workspace links are read.
 * @returns violations and the sizes of the checked package, source, and configuration sets.
 */
export function verifyDefaultProductIsolation(root: string): ProductIsolationResult {
  const failures: string[] = []
  const packages = new Map<string, Package>()
  const directories = new Map<string, Package>()
  const display = (path: string): string => relative(root, path).replaceAll('\\', '/')
  for (const path of globSync([
    'apps/*/package.json', 'packages/*/*/package.json', 'vendor/*/package.json',
    'native/system/packages/*/package.json', 'python/sdk-runtime/package.json',
  ], { cwd: root }).sort()) {
    const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Manifest
    if (typeof manifest.name !== 'string' || manifest.name === '') throw new Error(`${path}: missing package name`)
    if (packages.has(manifest.name)) throw new Error(`${path}: duplicate package name ${manifest.name}`)
    const pkg = { directory: dirname(resolve(root, path)), manifest }
    packages.set(manifest.name, pkg)
    directories.set(pkg.directory, pkg)
  }
  for (const path of ['apps/cli/package.json', 'apps/web/package.json', 'python/sdk-runtime/package.json']) {
    if (!existsSync(resolve(root, path))) failures.push(`missing default product root ${path}`)
  }
  if (directories.get(resolve(root, 'apps/cli'))?.manifest.name !== '@deepseek-ai/dsh') {
    failures.push('apps/cli/package.json must identify @deepseek-ai/dsh')
  }

  const queue: Package[] = []
  const visited = new Set<string>()
  const sources = new Set<string>()
  const configs = new Set<string>()
  const isExperimental = (pkg: Package): boolean => pkg.manifest.name.startsWith(EXPERIMENTAL_PREFIX)
    || display(pkg.directory).startsWith('packages/experimental/')
  const add = (pkg: Package, origin: string): void => {
    if (isExperimental(pkg)) {
      failures.push(`${origin} -> ${pkg.manifest.name}: default product must not include experimental packages`)
    } else if (!visited.has(pkg.directory)) {
      visited.add(pkg.directory)
      queue.push(pkg)
    }
  }
  const ownerOf = (path: string): Package | undefined => {
    let directory = dirname(path)
    for (;;) {
      const pkg = directories.get(directory)
      if (pkg !== undefined) return pkg
      const parent = dirname(directory)
      if (parent === directory) return undefined
      directory = parent
    }
  }
  const reference = (name: string, origin: string, owner?: Package): void => {
    if (name.startsWith('.') || name.startsWith('/') || /^(?:file|link):/.test(name)) {
      const target = resolve(owner?.directory ?? root, name.replace(/^(?:file|link):/, ''))
      const pkg = directories.get(target) ?? ownerOf(target)
      if (pkg !== undefined) add(pkg, origin)
      return
    }
    const packageName = barePackageName(name)
    if (packageName.startsWith(EXPERIMENTAL_PREFIX)) {
      failures.push(`${origin} -> ${name}: default product must not include experimental packages`)
      return
    }
    const pkg = packages.get(packageName)
    if (pkg !== undefined) add(pkg, origin)
    else if (packageName.startsWith('@deepseek-ai/')) failures.push(`${origin}: unknown workspace package ${name}`)
  }
  const dependency = (name: string, range: string, owner: Package, origin: string): void => {
    reference(name, origin, owner)
    if (/^(?:file:|link:|workspace:\.)/.test(range)) {
      reference(range.replace(/^workspace:/, ''), origin, owner)
    } else if (/^(?:npm:|workspace:)(?:@|[a-zA-Z])/.test(range)) {
      reference(range.replace(/^(?:npm:|workspace:)/, ''), origin, owner)
    }
  }
  const sourceReference = (specifier: string, path: string): void => {
    const owner = ownerOf(path)
    if (owner === undefined) return
    reference(specifier, display(path), owner)
    const name = barePackageName(specifier)
    const range = [...RUNTIME_SECTIONS, 'devDependencies' as const]
      .map(section => owner.manifest[section]?.[name]).find(value => value !== undefined)
    if (range !== undefined) dependency(name, range, owner, display(path))
  }
  const scanSource = (path: string, followLocal = false, inlineSource?: string): void => {
    if (sources.has(path)) return
    sources.add(path)
    const source = inlineSource ?? readFileSync(path, 'utf8')
    for (const specifier of collectRuntimeSourceSpecifiers(path, source)) sourceReference(specifier, path)
    for (const specifier of runtimeLocalSpecifiers(path, source)) {
      const target = resolveSource(path, specifier)
      const resolved = target ?? resolve(dirname(path), specifier)
      const owner = ownerOf(resolved)
      if (owner !== undefined && isExperimental(owner)) add(owner, display(path))
      if (/[^/]*cordis[^/]*\.ya?ml$/.test(resolved)) scanConfig(resolved)
      if (followLocal && target !== undefined) scanSource(target, true)
    }
  }
  const scanConfig = (path: string): void => {
    if (configs.has(path)) return
    configs.add(path)
    const document = loadCordisYaml(readFileSync(path, 'utf8'))
    if (!Array.isArray(document)) {
      failures.push(`${display(path)}: shipped composition must contain an entry array`)
      return
    }
    const visit = (entry: unknown): void => {
      if (!isRecord(entry)) return
      if (typeof entry.name === 'string') {
        const owner = ownerOf(path)
        if (entry.name.startsWith('.')) {
          const target = resolve(dirname(path), entry.name)
          const targetOwner = ownerOf(target)
          if (targetOwner !== undefined) add(targetOwner, display(path))
        } else reference(entry.name, display(path), owner)
      }
      if (isCordisGroupEntry(entry)) entry.config.forEach(visit)
      if (Array.isArray(entry.insert)) entry.insert.forEach(visit)
      if (entry.name === '@deepseek-ai/cordis-plugin-include' && isRecord(entry.config)) {
        if (Array.isArray(entry.config.patches)) entry.config.patches.forEach(visit)
        const paths = typeof entry.config.path === 'string' ? [entry.config.path] : entry.config.path
        if (Array.isArray(paths)) {
          for (const included of paths) {
            if (typeof included !== 'string') continue
            scanConfig(resolve(dirname(path), included))
          }
        }
      }
    }
    document.forEach(visit)
  }

  for (const pkg of packages.values()) {
    const path = display(pkg.directory)
    if (path.startsWith('apps/') || path === 'python/sdk-runtime') add(pkg, path)
  }
  const profilePath = resolve(root, PROFILE_SOURCE)
  if (existsSync(profilePath)) {
    for (const name of profilePackages(readFileSync(profilePath, 'utf8'))) {
      reference(name, PROFILE_SOURCE)
      if (packages.get(name)?.manifest.dsh?.bundle?.patch === undefined) {
        failures.push(`${PROFILE_SOURCE}: default bundle ${name} must declare dsh.bundle.patch`)
      }
    }
  } else failures.push(`missing default profile source ${PROFILE_SOURCE}`)
  const presets = globSync(PRESET_PATTERN, { cwd: root }).sort()
  if (presets.length === 0) failures.push(`no shipped presets matched ${PRESET_PATTERN}`)
  for (const path of presets) scanConfig(resolve(root, path))

  const html = resolve(root, 'apps/web/index.html')
  if (existsSync(html)) {
    const dom = new JSDOM(readFileSync(html, 'utf8'))
    try {
      const entries = [...dom.window.document.querySelectorAll('script[type="module"]')]
      if (entries.length === 0) failures.push('apps/web/index.html: missing default module entry')
      for (const [index, entry] of entries.entries()) {
        const src = entry.getAttribute('src')
        if (src === null) {
          scanSource(`${html}.inline-${String(index)}.js`, true, entry.textContent)
          continue
        }
        if (/^(?:https?:)?\/\//.test(src)) {
          failures.push(`apps/web/index.html: external default module entry cannot be checked: ${src}`)
          continue
        }
        scanSource(resolve(root, 'apps/web', src.replace(/^\//, '')), true)
      }
    } finally {
      dom.window.close()
    }
  } else failures.push('missing default Web entry apps/web/index.html')

  for (const pkg of queue) {
    const { manifest } = pkg
    for (const section of RUNTIME_SECTIONS) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        dependency(name, range, pkg, `${manifest.name} ${section}`)
      }
    }
    if (manifest.dsh?.bundle?.patch !== undefined) scanConfig(resolve(pkg.directory, manifest.dsh.bundle.patch))
    for (const tree of manifest.dsh?.configTrees ?? []) {
      for (const path of globSync('**/*.{yml,yaml}', { cwd: resolve(pkg.directory, tree.path),
        exclude: ['**/*.i18n.yaml', '**/preset.yml'] })) scanConfig(resolve(pkg.directory, tree.path, path))
    }
    if (display(pkg.directory) === 'apps/web') continue
    const files = globSync('src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}', { cwd: pkg.directory,
      exclude: ['**/*.spec.*', '**/*.test.*', '**/*.d.ts', '**/tests/**', '**/__tests__/**'] })
    if (display(pkg.directory) === 'apps/cli' && files.length === 0) failures.push('apps/cli: no default runtime sources')
    for (const path of files) scanSource(resolve(pkg.directory, path))
  }
  return { failures: [...new Set(failures)], packageCount: visited.size,
    sourceCount: sources.size, configCount: configs.size }
}

function barePackageName(specifier: string): string {
  return /^(?:@[^/]+\/)?[^/@]+/.exec(specifier)?.[0] ?? specifier
}

function resolveSource(from: string, specifier: string): string | undefined {
  const path = resolve(dirname(from), specifier.replace(/[?#].*$/, ''))
  if (!/\.(?:[cm]?[jt]sx?)$/.test(path) && /\.[^/]+$/.test(path)) return undefined
  const base = path.replace(/\.[cm]?js$/, '')
  return [path, `${base}.ts`, `${base}.tsx`, `${path}/index.ts`, `${path}/index.tsx`]
    .find(candidate => existsSync(candidate) && statSync(candidate).isFile())
}

function runtimeLocalSpecifiers(path: string, source: string): Set<string> {
  const specifiers = collectRuntimeLocalSourceSpecifiers(path, source)
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
      const first = node.arguments?.[0]
      if (first !== undefined && ts.isStringLiteralLike(first) && first.text.startsWith('.')) specifiers.add(first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return specifiers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read the literal package lists that define installation-owned profile defaults. */
function profilePackages(source: string): string[] {
  const file = ts.createSourceFile(PROFILE_SOURCE, source, ts.ScriptTarget.Latest, true)
  const required = new Set(['PROFILE_TEMPLATES', 'DEFAULT_PROFILE_BUNDLES'])
  const found = new Set<string>()
  const packages: string[] = []
  const literals = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      if (node.text.startsWith('@')) packages.push(node.text)
    } else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(literals)
    else if (ts.isObjectLiteralExpression(node)) node.properties.forEach(literals)
    else if (ts.isPropertyAssignment(node)) literals(node.initializer)
    else if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) {
      literals(node.expression)
    } else throw new Error(`${PROFILE_SOURCE}: default profile packages must use static literal lists`)
  }
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)
        || !required.has(declaration.name.text) && declaration.name.text !== 'INSTALLATION_OWNED_PROFILE_TUPLES') continue
      if (declaration.initializer === undefined) continue
      if (required.has(declaration.name.text)) found.add(declaration.name.text)
      const before = packages.length
      literals(declaration.initializer)
      if (packages.length === before) throw new Error(`${PROFILE_SOURCE}: ${declaration.name.text} has no default bundles`)
    }
  }
  if (found.size !== required.size) throw new Error(`${PROFILE_SOURCE}: missing default profile declarations`)
  return packages
}

if (import.meta.main) {
  const result = verifyDefaultProductIsolation(resolve(import.meta.dirname, '..'))
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(`verify-default-product-isolation: ${failure}`)
    process.exitCode = 1
  } else {
    console.log(`verify-default-product-isolation: ${String(result.packageCount)} packages, `
      + `${String(result.sourceCount)} runtime sources, ${String(result.configCount)} configurations exclude experimental packages.`)
  }
}
