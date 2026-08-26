/** Verify and repair npm dependency sections from published Client and Host faces. */

import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path'
import {
  hasClientDeclaration,
  PACKAGE_DEPENDENCY_POLICY,
  type PackageDependencyPolicy,
} from './package-dependency-policy.ts'
import {
  collectLocalSourceSpecifiers,
  collectRuntimeSourcePackageUses,
  collectSourcePackageUses,
} from './verify-client-packages.ts'

const GATE = 'verify-package-dependencies'
const CORDIS = '@deepseek-ai/cordis'
const WORKSPACE_RANGE = 'workspace:^'
const RELEASE_MANIFEST_GLOB = 'packages/!(experimental)/*/package.json'
const WORKSPACE_MANIFEST_GLOBS = [
  'apps/*/package.json',
  'packages/*/*/package.json',
  'vendor/*/package.json',
]

type DependencySection = 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies'
export type PackageDependencyRole = 'client-host' | 'configured-host'

/** Manifest fields read and repaired by the package dependency policy. */
export interface PackageDependencyManifest {
  name?: string
  version?: string
  exports?: unknown
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, unknown>
  dsh?: { client?: { inject?: string[] } }
}

/** One workspace package and its source location. */
export interface WorkspacePackageManifest {
  readonly dir: string
  readonly manifestPath: string
  readonly manifest: PackageDependencyManifest
  readonly name: string
}

/** Source and manifest facts for one package covered by the policy. */
export interface PackageDependencyFacts {
  readonly manifestPath: string
  readonly role: PackageDependencyRole
  readonly manifest: PackageDependencyManifest
  readonly workspaceNames: ReadonlySet<string>
  readonly allSourceUses: ReadonlyMap<string, readonly string[]>
  readonly hostRuntimeSourceUses: ReadonlyMap<string, readonly string[]>
  readonly clientInject: ReadonlySet<string>
}

/** Complete policy input read from the repository. */
export interface PackageDependencyState {
  readonly facts: readonly PackageDependencyFacts[]
  readonly packages: readonly WorkspacePackageManifest[]
  readonly policyViolations: readonly string[]
  readonly workspaceNames: ReadonlySet<string>
}

export interface ExpectedPackageDependency {
  readonly section: 'dependencies' | 'devDependencies' | 'peer-dev'
  readonly origins: readonly string[]
}

function normalizePath(path: string): string {
  return path.split(sep).join('/')
}

function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#') || specifier.includes(':')) {
    return undefined
  }
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.length >= 2 ? `${parts[0]}/${parts[1]}` : undefined : parts[0]
}

/** Read package manifests used for scope discovery and workspace-name checks. */
export function readWorkspacePackageManifests(root: string): {
  all: WorkspacePackageManifest[]
  release: WorkspacePackageManifest[]
} {
  const read = (manifestPath: string): WorkspacePackageManifest => {
    const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8')) as PackageDependencyManifest
    if (typeof manifest.name !== 'string') throw new Error(`${manifestPath}: missing package name`)
    return {
      dir: dirname(manifestPath),
      manifestPath,
      manifest,
      name: manifest.name,
    }
  }
  const all = globSync(WORKSPACE_MANIFEST_GLOBS, { cwd: root }).map(normalizePath).sort().map(read)
  const releasePaths = new Set(globSync(RELEASE_MANIFEST_GLOB, { cwd: root }).map(normalizePath))
  return { all, release: all.filter(pkg => releasePaths.has(pkg.manifestPath)) }
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicated.add(value)
    seen.add(value)
  }
  return [...duplicated].sort()
}

/** Discover Client faces and configured Host packages, validating explicit overrides. */
export function discoverPackageDependencyScope(
  packages: readonly WorkspacePackageManifest[],
  policy: PackageDependencyPolicy,
): { selected: Array<WorkspacePackageManifest & { role: PackageDependencyRole }>; violations: string[] } {
  const violations: string[] = []
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]))
  const include = new Set(policy.clientFaceInclude)
  const exclude = new Set(policy.clientFaceExclude)
  const host = new Set(policy.hostPackages)

  for (const [field, values] of [
    ['clientFaceInclude', policy.clientFaceInclude],
    ['clientFaceExclude', policy.clientFaceExclude],
    ['hostPackages', policy.hostPackages],
  ] as const) {
    for (const name of duplicates(values)) violations.push(`${field} lists ${name} more than once`)
    for (const name of values) {
      if (!byName.has(name)) violations.push(`${field} names unknown release package ${name}`)
    }
  }
  for (const name of include) {
    if (exclude.has(name)) violations.push(`${name} appears in both clientFaceInclude and clientFaceExclude`)
    const pkg = byName.get(name)
    if (pkg !== undefined
      && (pkg.manifestPath.startsWith('packages/client/') || hasClientDeclaration(pkg.manifest.dsh))) {
      violations.push(`clientFaceInclude redundantly names automatically discovered package ${name}`)
    }
  }
  for (const name of exclude) {
    const pkg = byName.get(name)
    if (pkg !== undefined && pkg.manifestPath.startsWith('packages/client/')) {
      violations.push(`clientFaceExclude cannot exempt packages/client package ${name}`)
    } else if (pkg !== undefined && !hasClientDeclaration(pkg.manifest.dsh)) {
      violations.push(`clientFaceExclude names ${name}, which declares no dsh.client entry`)
    }
  }

  const selected: Array<WorkspacePackageManifest & { role: PackageDependencyRole }> = []
  for (const pkg of packages) {
    const clientDirectory = pkg.manifestPath.startsWith('packages/client/')
    const clientHost = clientDirectory
      || ((hasClientDeclaration(pkg.manifest.dsh) || include.has(pkg.name)) && !exclude.has(pkg.name))
    const configuredHost = host.has(pkg.name)
    if (configuredHost && clientHost) {
      violations.push(`hostPackages redundantly names Client-faced package ${pkg.name}`)
    }
    const role = clientHost ? 'client-host' : configuredHost ? 'configured-host' : undefined
    if (role !== undefined) selected.push({ ...pkg, role })
  }
  return {
    selected: selected.sort((left, right) => left.manifestPath.localeCompare(right.manifestPath)),
    violations: [...new Set(violations)].sort(),
  }
}

function addUse(target: Map<string, string[]>, name: string, path: string): void {
  const paths = target.get(name) ?? []
  if (!paths.includes(path)) paths.push(path)
  target.set(name, paths)
}

function resolveLocal(importer: string, specifier: string): string | undefined {
  const raw = resolve(dirname(importer), specifier)
  const candidates = extname(raw) === ''
    ? [`${raw}.ts`, `${raw}.tsx`, `${raw}.mts`, `${raw}.cts`, join(raw, 'index.ts'), join(raw, 'index.tsx')]
    : [raw, raw.replace(/\.js$/, '.ts'), raw.replace(/\.jsx$/, '.tsx'), raw.replace(/\.mjs$/, '.mts'), raw.replace(/\.cjs$/, '.cts')]
  return candidates.find(candidate => existsSync(candidate))
}

function readHostRuntimeUses(root: string, pkg: WorkspacePackageManifest): Map<string, string[]> {
  const uses = new Map<string, string[]>()
  const seen = new Set<string>()
  const visit = (path: string): void => {
    const normalized = normalize(path)
    if (seen.has(normalized) || !existsSync(normalized)) return
    seen.add(normalized)
    const source = readFileSync(normalized, 'utf8')
    const displayPath = normalizePath(relative(root, normalized))
    for (const name of collectRuntimeSourcePackageUses(normalized, source)) addUse(uses, name, displayPath)
    for (const specifier of collectLocalSourceSpecifiers(normalized, source)) {
      const target = resolveLocal(normalized, specifier)
      if (target !== undefined) visit(target)
    }
  }
  visit(resolve(root, pkg.dir, 'src/index.ts'))
  return uses
}

function readAllSourceUses(root: string, pkg: WorkspacePackageManifest): Map<string, string[]> {
  const uses = new Map<string, string[]>()
  for (const sourcePath of globSync('src/**/*.{ts,tsx,mts,cts}', { cwd: resolve(root, pkg.dir) }).sort()) {
    const source = readFileSync(resolve(root, pkg.dir, sourcePath), 'utf8')
    const displayPath = `${pkg.dir}/${normalizePath(sourcePath)}`
    for (const name of collectSourcePackageUses(sourcePath, source)) addUse(uses, name, displayPath)
  }
  return uses
}

/** Read source usage for one already-classified package. */
export function readPackageDependencyFacts(
  root: string,
  pkg: WorkspacePackageManifest,
  role: PackageDependencyRole,
  workspaceNames: ReadonlySet<string>,
): PackageDependencyFacts {
  const inject = pkg.manifest.dsh?.client?.inject ?? []
  return {
    manifestPath: pkg.manifestPath,
    role,
    manifest: pkg.manifest,
    workspaceNames,
    allSourceUses: readAllSourceUses(root, pkg),
    hostRuntimeSourceUses: readHostRuntimeUses(root, pkg),
    clientInject: new Set(inject.map(packageNameOf).filter(name => name !== undefined)),
  }
}

/** Read every package covered by the current dependency policy. */
export function readPackageDependencyState(
  root: string,
  policy: PackageDependencyPolicy = PACKAGE_DEPENDENCY_POLICY,
): PackageDependencyState {
  const packages = readWorkspacePackageManifests(root)
  const workspaceNames = new Set(packages.all.map(pkg => pkg.name))
  const discovered = discoverPackageDependencyScope(packages.release, policy)
  return {
    facts: discovered.selected.map(pkg => readPackageDependencyFacts(root, pkg, pkg.role, workspaceNames)),
    packages: packages.release,
    policyViolations: discovered.violations,
    workspaceNames,
  }
}

/** Derive the required npm section for each relationship owned by the policy. */
export function expectedPackageDependencies(
  facts: PackageDependencyFacts,
): ReadonlyMap<string, ExpectedPackageDependency> {
  const expected = new Map<string, { section: ExpectedPackageDependency['section']; origins: Set<string> }>()
  const add = (name: string, sectionName: ExpectedPackageDependency['section'], origin: string): void => {
    if (name === facts.manifest.name || name === CORDIS) return
    const current = expected.get(name)
    const section = current?.section === 'dependencies' || sectionName === 'dependencies'
      ? 'dependencies'
      : 'devDependencies'
    expected.set(name, { section, origins: new Set([...(current?.origins ?? []), origin]) })
  }

  expected.set(CORDIS, { section: 'peer-dev', origins: new Set(['shared Cordis runtime']) })
  for (const [name, paths] of facts.allSourceUses) {
    if (!facts.workspaceNames.has(name)) continue
    for (const path of paths) add(name, 'devDependencies', path)
  }
  for (const name of facts.clientInject) {
    if (facts.workspaceNames.has(name)) add(name, 'devDependencies', 'dsh.client.inject')
  }
  for (const name of Object.keys(facts.manifest.peerDependencies ?? {})) {
    if (name !== CORDIS) add(name, 'devDependencies', 'existing non-Cordis peer')
  }
  for (const [name, paths] of facts.hostRuntimeSourceUses) {
    if (!facts.workspaceNames.has(name) && facts.manifest.peerDependencies?.[name] === undefined) continue
    for (const path of paths) add(name, 'dependencies', path)
  }
  return new Map([...expected].map(([name, rule]) => [name, {
    section: rule.section,
    origins: [...rule.origins].sort(),
  }]))
}

/** Format the managed Host runtime edges that remain ordinary dependencies. */
export function formatManagedRuntimeDependencies(state: PackageDependencyState): string[] {
  const rows = state.facts.flatMap((facts) => {
    const dependencies = [...expectedPackageDependencies(facts)]
      .filter(([, rule]) => rule.section === 'dependencies')
      .map(([name]) => name)
      .sort()
    if (dependencies.length === 0) return []
    return [{
      name: facts.manifest.name ?? facts.manifestPath,
      dependencies,
    }]
  }).sort((left, right) => left.name.localeCompare(right.name))
  const edges = rows.reduce((total, row) => total + row.dependencies.length, 0)
  return [
    `${GATE}: ${String(edges)} managed Host runtime dependency edge(s) remain in dependencies across ${String(rows.length)} package(s):`,
    ...rows.map(row => `  ${row.name}: ${row.dependencies.join(', ')}`),
  ]
}

function section(manifest: PackageDependencyManifest, name: DependencySection): Record<string, string> {
  return manifest[name] ?? {}
}

function mutableSection(manifest: PackageDependencyManifest, name: DependencySection): Record<string, string> {
  manifest[name] ??= {}
  return manifest[name]
}

function declaredSections(manifest: PackageDependencyManifest, name: string): DependencySection[] {
  return (['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const)
    .filter(sectionName => section(manifest, sectionName)[name] !== undefined)
}

function describeSections(sections: readonly DependencySection[]): string {
  return sections.length === 0 ? 'no dependency section' : sections.join(' + ')
}

/** Return all manifest and policy violations in stable order. */
export function collectPackageDependencyViolations(state: PackageDependencyState): string[] {
  const violations = [...state.policyViolations]
  for (const facts of state.facts) {
    for (const [name, rule] of expectedPackageDependencies(facts)) {
      const actual = declaredSections(facts.manifest, name)
      if (rule.section === 'peer-dev') {
        if (actual.length === 2
          && actual.includes('peerDependencies')
          && actual.includes('devDependencies')
          && section(facts.manifest, 'peerDependencies')[name] === WORKSPACE_RANGE
          && section(facts.manifest, 'devDependencies')[name] === WORKSPACE_RANGE
          && facts.manifest.peerDependenciesMeta?.[name] === undefined) continue
        violations.push(
          `${facts.manifestPath}: ${name} must be matching peerDependencies + devDependencies at ${WORKSPACE_RANGE}; found ${describeSections(actual)}`,
        )
        continue
      }
      const expectedSection = rule.section
      const range = section(facts.manifest, expectedSection)[name]
      if (actual.length === 1
        && actual[0] === expectedSection
        && (!facts.workspaceNames.has(name) || range === WORKSPACE_RANGE)) continue
      violations.push(
        `${facts.manifestPath}: ${name} (${rule.origins.join(', ')}) must be ${expectedSection}-only`
        + (facts.workspaceNames.has(name) ? ` at ${WORKSPACE_RANGE}` : '')
        + `; found ${describeSections(actual)}`,
      )
    }
    for (const sectionName of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const [name, range] of Object.entries(section(facts.manifest, sectionName))) {
        if (!facts.workspaceNames.has(name) || range === WORKSPACE_RANGE) continue
        violations.push(`${facts.manifestPath}: ${sectionName}.${name} must use ${WORKSPACE_RANGE}, found ${range}`)
      }
    }
    for (const name of Object.keys(facts.manifest.peerDependenciesMeta ?? {})) {
      if (facts.manifest.peerDependencies?.[name] === undefined) {
        violations.push(`${facts.manifestPath}: peerDependenciesMeta.${name} has no matching peerDependencies entry`)
      }
    }
  }
  return [...new Set(violations)].sort()
}

function deleteDependency(
  manifest: PackageDependencyManifest,
  sectionName: DependencySection,
  name: string,
): void {
  const dependencies = manifest[sectionName]
  if (dependencies?.[name] === undefined) return
  const retained = Object.fromEntries(Object.entries(dependencies).filter(([key]) => key !== name))
  if (Object.keys(retained).length > 0) {
    manifest[sectionName] = retained
    return
  }
  switch (sectionName) {
    case 'dependencies': delete manifest.dependencies; break
    case 'devDependencies': delete manifest.devDependencies; break
    case 'optionalDependencies': delete manifest.optionalDependencies; break
    case 'peerDependencies': delete manifest.peerDependencies; break
  }
}

function deletePeerMeta(manifest: PackageDependencyManifest, name: string): void {
  if (manifest.peerDependenciesMeta?.[name] === undefined) return
  const retained = Object.fromEntries(Object.entries(manifest.peerDependenciesMeta)
    .filter(([key]) => key !== name))
  if (Object.keys(retained).length > 0) manifest.peerDependenciesMeta = retained
  else delete manifest.peerDependenciesMeta
}

function preferredRange(
  facts: PackageDependencyFacts,
  name: string,
  target: ExpectedPackageDependency['section'],
): string | undefined {
  if (facts.workspaceNames.has(name)) return WORKSPACE_RANGE
  const order: readonly DependencySection[] = target === 'dependencies'
    ? ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
    : ['devDependencies', 'peerDependencies', 'dependencies', 'optionalDependencies']
  return order.map(sectionName => section(facts.manifest, sectionName)[name]).find(value => value !== undefined)
}

/** Apply the dependency policy to one in-memory manifest. */
export function repairPackageDependencyManifest(facts: PackageDependencyFacts): void {
  for (const [name, rule] of expectedPackageDependencies(facts)) {
    if (rule.section === 'peer-dev') {
      for (const sectionName of ['dependencies', 'optionalDependencies'] as const) {
        deleteDependency(facts.manifest, sectionName, name)
      }
      mutableSection(facts.manifest, 'peerDependencies')[name] = WORKSPACE_RANGE
      mutableSection(facts.manifest, 'devDependencies')[name] = WORKSPACE_RANGE
      deletePeerMeta(facts.manifest, name)
      continue
    }
    const range = preferredRange(facts, name, rule.section)
    if (range === undefined) continue
    for (const sectionName of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      if (sectionName !== rule.section) deleteDependency(facts.manifest, sectionName, name)
    }
    mutableSection(facts.manifest, rule.section)[name] = range
    deletePeerMeta(facts.manifest, name)
  }
  for (const name of Object.keys(facts.manifest.peerDependenciesMeta ?? {})) {
    if (facts.manifest.peerDependencies?.[name] === undefined) deletePeerMeta(facts.manifest, name)
  }
  for (const sectionName of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    for (const name of Object.keys(section(facts.manifest, sectionName))) {
      if (facts.workspaceNames.has(name)) mutableSection(facts.manifest, sectionName)[name] = WORKSPACE_RANGE
    }
  }
}

/** Repair every covered manifest and return repository-relative changed paths. */
export function fixPackageDependencies(root: string, state: PackageDependencyState): string[] {
  if (state.policyViolations.length > 0) return []
  const changed: string[] = []
  for (const facts of state.facts) {
    const before = `${JSON.stringify(facts.manifest, null, 2)}\n`
    repairPackageDependencyManifest(facts)
    const after = `${JSON.stringify(facts.manifest, null, 2)}\n`
    if (after === before) continue
    writeFileSync(resolve(root, facts.manifestPath), after)
    changed.push(facts.manifestPath)
  }
  return changed.sort()
}

function main(): void {
  const root = resolve(import.meta.dirname, '..')
  let state = readPackageDependencyState(root)
  const fix = process.argv.includes('--fix')
  if (fix) {
    const changed = fixPackageDependencies(root, state)
    console.log(`${GATE}: fixed ${String(changed.length)} manifest(s).`)
    state = readPackageDependencyState(root)
  }
  const violations = collectPackageDependencyViolations(state)
  if (violations.length > 0) {
    console.error(`${GATE}: ${String(violations.length)} violation(s):`)
    for (const violation of violations) console.error(`  ${violation}`)
    process.exitCode = 1
    return
  }
  const roles = Object.groupBy(state.facts, fact => fact.role)
  console.log(
    `${GATE}: ${String(state.facts.length)} package(s) match the published dependency policy`
    + ` (${String(roles['client-host']?.length ?? 0)} Client/Host,`
    + ` ${String(roles['configured-host']?.length ?? 0)} configured Host).`,
  )
  if (fix) {
    for (const line of formatManagedRuntimeDependencies(state)) console.log(line)
  }
}

if (import.meta.main) main()
