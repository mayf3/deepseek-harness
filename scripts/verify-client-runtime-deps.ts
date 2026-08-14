/**
 * Keep browser-only external packages out of installed dependency sections.
 *
 * A browser artifact resolves nothing on the user's machine: tsdown inlines
 * every non-platform specifier into `lib/client.js`, the shell `dist` answers
 * `PLATFORM_MODULES` from its frozen module table, and Vite inlines the shell's
 * own imports into that published `dist`. A specifier only browser source
 * reaches is therefore a build-time input and belongs in `devDependencies`,
 * because npm installs `dependencies` and non-optional `peerDependencies` for
 * every consumer of the published package.
 *
 * Each face is walked from the entries the manifest publishes, not by a
 * directory rule, so a module under `src/` that only the browser entry reaches
 * counts as browser source:
 *
 *   `./client` is `lib/client.js`   host: the other export targets; browser: the bundle
 *   `packages/client/*` with no     browser-only library: host is `src/invariant.ts`,
 *     `./client` export               the companion the host mounts; `.` is browser code
 *   no `.` export, ships a `dist`   prebuilt browser bundle: no host face at all
 *
 * Only external packages are subject: they are what an install downloads. A
 * workspace name stays where its manifest puts it, because that declaration also
 * states which package supplies an injected service or a mounted Remote
 * contribution, and the app installs it either way. A reference from the host
 * face, an erased type import included, likewise keeps a declaration in place.
 *
 * Run: pnpm exec tsx scripts/verify-client-runtime-deps.ts [--json]
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { TypeScriptProject, type CompilerFace } from './ts-project.ts'

const root = resolve(import.meta.dirname, '..')

/**
 * `@deepseek-ai/cordis` placement belongs to check-workspace-constraints, which
 * requires it as a peerDependency plus devDependency of every harness package
 * regardless of face.
 */
const PLACEMENT_OWNED_ELSEWHERE = new Set(['@deepseek-ai/cordis'])

/** Dependency sections npm installs for a consumer of the published package. */
const INSTALLED_SECTIONS = ['dependencies', 'peerDependencies'] as const

type Section = (typeof INSTALLED_SECTIONS)[number]

interface Manifest {
  name?: string
  files?: string[]
  exports?: Record<string, unknown>
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

/** How a package reaches the browser, which fixes the entries Node can load. */
type Kind = 'bundle-half' | 'browser-library' | 'prebuilt-dist'

/** What settles an external specifier as build-time only. */
type Reached = 'browser' | 'nothing'

interface Violation {
  readonly section: Section
  readonly dep: string
  readonly reached: Reached
  /** Whether the browser face names it, which decides dev-move versus deletion. */
  readonly browserReferenced: boolean
}

interface Offender {
  readonly name: string
  readonly dir: string
  readonly kind: Kind
  readonly violations: Violation[]
}

/** Why each class needs no install, for the failure report. */
const REASON: Record<Reached, string> = {
  browser: 'only a browser artifact reaches it, and that resolves nothing on the user machine',
  nothing: 'no reference names it at all',
}

/**
 * Classify a package by the browser artifact it produces.
 * @param dir - repository-relative package directory.
 * @param manifest - the package manifest.
 * @returns the package kind, or undefined when the package has no browser face.
 */
function kindOf(dir: string, manifest: Manifest): Kind | undefined {
  if (manifest.exports?.['./client'] !== undefined) return 'bundle-half'
  if (dir.startsWith('packages/client/')) return 'browser-library'
  const shipsDist = (manifest.files ?? []).some(entry => entry === 'dist' || entry.startsWith('dist/'))
  if (shipsDist && manifest.exports?.['.'] === undefined) return 'prebuilt-dist'
  return undefined
}

/** The bare package name a specifier names, keeping a leading scope. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier
}

/** One compiler face's bound program plus its module resolution state. */
interface Face {
  readonly project: TypeScriptProject
  readonly host: ts.CompilerHost
  readonly cache: ts.ModuleResolutionCache
}

const faces = new Map<CompilerFace, Face>()
for (const face of ['host', 'client'] as const) {
  const project = new TypeScriptProject(root, face)
  const options = project.program.getCompilerOptions()
  faces.set(face, {
    project,
    host: ts.createCompilerHost(options, false),
    cache: ts.createModuleResolutionCache(root, fileName => fileName, options),
  })
}

/** Which face's program bound each workspace module, keyed by absolute path. */
const boundIn = new Map<string, CompilerFace>()
for (const [face, { project }] of faces) {
  for (const sourceFile of project.sourceFiles()) {
    if (sourceFile.isDeclarationFile) continue
    if (!boundIn.has(sourceFile.fileName)) boundIn.set(sourceFile.fileName, face)
  }
}

/**
 * Read every module specifier one source file names.
 *
 * An import clause is not the only way to reach a package: `require`,
 * `require.resolve`, and a dynamic `import()` on a literal each name one, and a
 * type-only import still names a package the build must resolve.
 * @param sourceFile - a bound source file.
 * @returns every specifier, relative ones included.
 */
function specifiersOf(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      const specifier = ts.isImportEqualsDeclaration(node)
        ? (ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : undefined)
        : node.moduleSpecifier
      if (specifier !== undefined && ts.isStringLiteralLike(specifier)) specifiers.push(specifier.text)
    } else if (ts.isCallExpression(node)) {
      const target = node.expression
      const isRequire = ts.isIdentifier(target) && target.text === 'require'
      const isRequireResolve = ts.isPropertyAccessExpression(target)
        && ts.isIdentifier(target.expression) && target.expression.text === 'require'
        && target.name.text === 'resolve'
      const argument = node.arguments[0]
      if ((isRequire || isRequireResolve || target.kind === ts.SyntaxKind.ImportKeyword)
        && argument !== undefined && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

/**
 * Walk one face from its entries and collect the packages it names.
 * @param entries - absolute entry module paths.
 * @param packageDir - absolute package directory; the walk stops at its edge.
 * @returns package names the walk reaches.
 */
function walk(entries: readonly string[], packageDir: string): Set<string> {
  const found = new Set<string>()
  const seen = new Set<string>()
  const queue = entries.filter(entry => boundIn.has(entry))
  while (queue.length > 0) {
    const file = queue.pop()
    if (file === undefined || seen.has(file)) continue
    seen.add(file)
    const faceName = boundIn.get(file)
    const face = faceName === undefined ? undefined : faces.get(faceName)
    const sourceFile = face?.project.program.getSourceFile(file)
    if (face === undefined || sourceFile === undefined) continue

    for (const specifier of specifiersOf(sourceFile)) {
      if (!specifier.startsWith('.')) {
        if (!specifier.startsWith('node:')) found.add(packageOf(specifier))
        continue
      }
      const resolved = ts.resolveModuleName(
        specifier, file, face.project.program.getCompilerOptions(), face.host, face.cache,
      ).resolvedModule?.resolvedFileName
      // A relative specifier resolving outside the package is a packaging error
      // verify-package-paths owns; either way it is not this package's own module.
      if (resolved !== undefined && resolved.startsWith(`${packageDir}/`)) queue.push(resolved)
    }
  }
  return found
}

/**
 * The source module behind one published JavaScript export target.
 *
 * `lib/` holds the tsdown bundles and `lib/types/` the tsc emit, so both
 * prefixes lead back to one `src` module.
 * @param dir - absolute package directory.
 * @param emitted - the export target, as written in the manifest.
 * @returns the absolute source path, or undefined when nothing in `src` emits it.
 */
function sourceBehind(dir: string, emitted: string): string | undefined {
  const stem = emitted.replace(/^\.\/lib\/types\//, '').replace(/^\.\/lib\//, '').replace(/\.js$/, '')
  return [`src/${stem}.ts`, `src/${stem}.tsx`, `src/${stem}/index.ts`, `src/${stem}/index.tsx`]
    .map(candidate => join(dir, candidate))
    .find(candidate => existsSync(candidate))
}

interface Entries {
  readonly host: string[]
  readonly browser: string[]
  /**
   * Published JavaScript entries no `src` module emits — a generated artifact
   * such as `lib/typert.host.js`, whose own runtime imports are invisible here.
   */
  readonly generated: string[]
}

/**
 * The entry modules of each face, derived from what the manifest publishes.
 * @param dir - absolute package directory.
 * @param manifest - the package manifest.
 * @param kind - the package kind.
 * @returns absolute entry module paths per face, plus unmapped published entries.
 */
function faceEntries(dir: string, manifest: Manifest, kind: Kind): Entries {
  if (kind === 'prebuilt-dist') return { host: [], browser: [], generated: [] }
  if (kind === 'browser-library') {
    return { host: [join(dir, 'src/invariant.ts')], browser: [join(dir, 'src/index.ts')], generated: [] }
  }
  const host = [join(dir, 'src/index.ts'), join(dir, 'src/invariant.ts')]
  const browser: string[] = []
  const generated: string[] = []
  for (const [key, target] of Object.entries(manifest.exports ?? {})) {
    if (key === '.' || key === './package.json' || key.includes('*')) continue
    const emitted = typeof target === 'string' ? target : (target as { default?: unknown }).default
    if (typeof emitted !== 'string' || !emitted.endsWith('.js')) continue
    // Keyed on the artifact path, not the subpath name: `./client` is the tsdown
    // browser bundle only when it resolves to lib/client.js, while other packages
    // publish a plain browser-shared module under the same subpath.
    const source = emitted === './lib/client.js'
      ? sourceBehind(dir, './lib/client/index.js')
      : sourceBehind(dir, emitted)
    if (source === undefined) generated.push(`${key} -> ${emitted}`)
    else if (key === './client') browser.push(source)
    else host.push(source)
  }
  return { host, browser, generated }
}

/** Every installed dependency of a manifest, paired with its section. */
function installedDeps(manifest: Manifest): { section: Section; dep: string }[] {
  const deps: { section: Section; dep: string }[] = []
  for (const section of INSTALLED_SECTIONS) {
    for (const dep of Object.keys(manifest[section] ?? {})) {
      if (section === 'peerDependencies' && manifest.peerDependenciesMeta?.[dep]?.optional === true) continue
      if (PLACEMENT_OWNED_ELSEWHERE.has(dep)) continue
      deps.push({ section, dep })
    }
  }
  return deps
}

/**
 * Test whether a Loader config names a package as a whole word.
 * @param text - raw config text.
 * @param dep - package name to look for.
 * @returns true when the name appears outside a longer specifier.
 */
function namesPackage(text: string, dep: string): boolean {
  const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w@/.-])${escaped}(?![\\w.-])`).test(text)
}

interface Candidate {
  readonly name: string
  readonly relativeDir: string
  readonly manifest: Manifest
  readonly kind: Kind
}

const candidates: Candidate[] = []
for (const path of [
  ...globSync('packages/*/*/package.json', { cwd: root }),
  ...globSync('apps/*/package.json', { cwd: root }),
].sort()) {
  const relativeDir = dirname(path)
  const manifest = JSON.parse(readFileSync(join(root, path), 'utf8')) as Manifest
  if (manifest.name === undefined) continue
  const kind = kindOf(relativeDir, manifest)
  if (kind !== undefined) candidates.push({ name: manifest.name, relativeDir, manifest, kind })
}

const offenders: Offender[] = []
const unchecked: string[] = []
for (const { name, relativeDir, manifest, kind } of candidates) {
  const dir = join(root, relativeDir)
  const entries = faceEntries(dir, manifest, kind)
  // A generated Node entry carries runtime imports of its own that no source
  // states, so this package's declarations cannot be judged from `src` alone.
  if (entries.generated.length > 0) {
    unchecked.push(`${name}: generated entry ${entries.generated.join(', ')}`)
    continue
  }
  const host = walk(entries.host, dir)
  const browser = walk(entries.browser, dir)
  // A Loader row names its plugin package instead of importing it, so a config
  // the package owns is part of its host face. YAML keys carry no quotes, so
  // these are matched as whole names against the raw text.
  const configs = globSync('cordis*.yml', { cwd: dir }).map(config => readFileSync(join(dir, config), 'utf8'))

  const violations = installedDeps(manifest)
    // A workspace name stays where the manifest puts it. Such a declaration also
    // states which package supplies an injected service, which Remote contribution
    // an assembly mounts, or which Loader row must resolve; the app installs the
    // package regardless, so moving one saves no download while deleting what
    // verify-runtime-closure and the Loader read. External packages are the
    // download, and this gate is about the download.
    .filter(({ dep }) => !dep.startsWith('@deepseek-ai/'))
    .filter(({ dep }) => !host.has(dep) && !configs.some(text => namesPackage(text, dep)))
    .map(({ section, dep }) => ({
      section,
      dep,
      browserReferenced: browser.has(dep),
      // A prebuilt bundle publishes no Node entry, so everything it declares is
      // build-time by construction, named in its Vite graph rather than in src.
      reached: kind === 'prebuilt-dist' || browser.has(dep) ? 'browser' as const : 'nothing' as const,
    }))
  if (violations.length > 0) offenders.push({ name, dir: relativeDir, kind, violations })
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(offenders, null, 2))
  process.exit(0)
}

if (unchecked.length > 0) {
  console.log(`verify-client-runtime-deps: ${String(unchecked.length)} package(s) not checked, no source states their entry's imports:`)
  for (const entry of unchecked) console.log(`  ${entry}`)
}

if (offenders.length > 0) {
  const all = offenders.flatMap(offender => offender.violations)
  console.error(`verify-client-runtime-deps: ${String(all.length)} build-time specifier(s) in installed sections:`)
  for (const { name, dir, kind, violations } of offenders) {
    console.error(`  ${name} (${dir}, ${kind})`)
    for (const { section, dep, reached } of violations) {
      console.error(`      ${section}.${dep}  ->  devDependencies [${reached}]`)
    }
  }
  console.error('')
  for (const reached of ['browser', 'nothing'] as const) {
    const count = all.filter(violation => violation.reached === reached).length
    if (count > 0) console.error(`  ${String(count).padStart(4)} ${reached}: ${REASON[reached]}`)
  }
  console.error('\nDeclaration rules: packages/client/AGENTS.md.')
  process.exit(1)
}
console.log(`verify-client-runtime-deps: browser-face specifiers are dev-only across ${String(candidates.length)} browser-facing packages.`)
