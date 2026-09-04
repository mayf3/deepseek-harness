/**
 * The install-time probe: what an installed package is and whether this
 * harness can load it, answered in a child process so a package that throws,
 * hangs, or brings its own copy of cordis never runs inside the host. The
 * manifest facts (kind, rows, declared modules) are read here; the child only
 * imports.
 * @module @deepseek-ai/dsh-app-boot/probe
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from './index.ts'
import { readProfileManifest, resolveBundleDir, type ProfileManifest } from './profile.ts'

/** Directory under a profile holding one probe record per package. */
export const PLUGIN_PROBE_DIR = '.dsh-plugins'

/**
 * The probe record format. Bumped when the probe's verdicts change meaning,
 * so a record an older probe wrote is re-probed instead of trusted: 2 made a
 * bare function export a `library` rather than a `plugin`.
 */
export const PLUGIN_PROBE_FORMAT = 2

/** One row a bundle's patch inserts, as its own patch declares it. */
export interface PluginProbeRow {
  /** The row id the bundle declares, or undefined when the row leaves it to the Loader. */
  readonly id?: string
  /** The module specifier the row names. */
  readonly name: string
  /** Whether the row carries a `disabled` gate. */
  readonly gated: boolean
}

/** One agent-plane module a package declares addable to a composition. */
export interface PluginProbeAddable {
  /** The subpath or bare specifier, as declared in `dsh.plugins[].name`. */
  readonly name: string
  /** Display title, when declared. */
  readonly title?: string
  /** Default row config, when declared. */
  readonly config?: unknown
  /** Whether the child process imported the module and found a plugin. */
  readonly ok: boolean
  /** The import failure, when `ok` is false. */
  readonly error?: string
  /** The module's `Config` schema envelope, when it declares one. */
  readonly configSchema?: unknown
}

/** What the probe learned about one installed package. */
export interface PluginProbe {
  /** The package name. */
  readonly packageName: string
  /** The package version as installed. */
  readonly version?: string
  /** Free text from the manifest. */
  readonly description?: string
  /** Display title from `dsh.title`, when declared. */
  readonly title?: string
  /**
   * `bundle` (declares `dsh.bundle`); `plugin` (declares itself to dsh — a
   * `dsh` section or a dependency on `@deepseek-ai/cordis` — and its main
   * export is a cordis plugin); else `library`. A function export alone is
   * not a plugin: `lodash` exports one too.
   */
  readonly kind: 'bundle' | 'plugin' | 'library'
  /** Whether the package can be enabled or added: it imported and shares the harness's cordis. */
  readonly ok: boolean
  /** Why it cannot, when `ok` is false. */
  readonly reason?: string
  /** Whether the package resolves `@deepseek-ai/cordis` to the harness's own copy; null when unknown. */
  readonly cordisSameCopy: boolean | null
  /** The harness version range the package declares in `engines.dsh`. */
  readonly enginesDsh?: string
  /** Rows the bundle's patch inserts (unprefixed), empty for a non-bundle. */
  readonly rows: readonly PluginProbeRow[]
  /** Ids of rows outside the bundle that its patch overrides. */
  readonly overrides: readonly string[]
  /** Agent-plane modules the package declares addable. */
  readonly addable: readonly PluginProbeAddable[]
  /** The main export's `Config` schema envelope, for a `plugin` kind. */
  readonly configSchema?: unknown
  /** ISO time of the probe. */
  readonly checkedAt: string
}

/** Inputs of {@link probePackage}. */
export interface ProbeOptions {
  /** The diagnostic prefix on thrown errors. */
  binName: string
  /** The profile directory the package is installed in. */
  profileDir: string
  /** Absolute path of the dsh app's package.json (first resolution anchor). */
  installAnchor: string
  /** The package to probe. */
  packageName: string
  /** Bound on the child process; default 20 seconds. */
  timeoutMs?: number
  /** The Node executable; defaults to the running one. */
  nodeExecutable?: string
}

/** The manifest slice the probe reads beyond the profile launcher's. */
interface ProbedManifest extends ProfileManifest {
  main?: string
  exports?: unknown
  engines?: Record<string, string>
  dsh?: ProfileManifest['dsh'] & {
    title?: string
    plugins?: { name: string; title?: string; config?: unknown }[]
  }
}

/** What the child process reports. */
interface ChildReport {
  cordis: string | null
  main: { ok: boolean; isPlugin: boolean; configSchema: unknown; error?: string }
  addable: Record<string, { ok: boolean; isPlugin: boolean; configSchema: unknown; error?: string }>
}

/**
 * The script the child runs: resolve cordis from the package, import the main
 * export and every declared addable module, and report. Parameters arrive
 * as argv so no value is interpolated into code.
 */
const CHILD_SCRIPT = `
import { pathToFileURL } from 'node:url'
const [dir, mainSpecifier, addableJson] = process.argv.slice(1)
const base = pathToFileURL(dir + '/package.json').href
const report = { cordis: null, main: { ok: false, isPlugin: false, configSchema: null }, addable: {} }
try { report.cordis = import.meta.resolve('@deepseek-ai/cordis', base) } catch { report.cordis = null }
const inspect = async (specifier) => {
  try {
    const mod = await import(import.meta.resolve(specifier, base))
    const plugin = mod.default ?? mod
    const schema = plugin?.Config ?? mod.Config
    return {
      ok: true,
      isPlugin: typeof plugin === 'function' || typeof plugin?.apply === 'function',
      configSchema: typeof schema?.toJSON === 'function' ? schema.toJSON() : null,
    }
  } catch (error) {
    return { ok: false, isPlugin: false, configSchema: null, error: String(error?.stack ?? error) }
  }
}
if (mainSpecifier !== '') report.main = await inspect(mainSpecifier)
for (const name of JSON.parse(addableJson)) report.addable[name] = await inspect(name)
process.stdout.write(JSON.stringify(report))
`

/** Run the child and parse its report. */
function runChild(options: ProbeOptions, packageDir: string, mainSpecifier: string, addable: string[]): Promise<ChildReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.nodeExecutable ?? process.execPath,
      ['--experimental-import-meta-resolve', '--input-type=module', '-e', CHILD_SCRIPT, '--', packageDir, mainSpecifier, JSON.stringify(addable)],
      { cwd: options.profileDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } },
    )
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk))
    // One settlement: a spawn failure emits `error` and then `close`, and a
    // timeout kill emits `close` after the rejection below.
    let settled = false
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      outcome()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle(() => { reject(new Error(`${options.binName}: probe of ${options.packageName} timed out after ${String(timeoutMs)}ms`)) })
    }, timeoutMs)
    child.on('error', (error) => { settle(() => { reject(error) }) })
    child.on('close', (code) => {
      settle(() => {
        const stdout = Buffer.concat(out).toString('utf8')
        try {
          resolve(JSON.parse(stdout) as ChildReport)
        } catch {
          reject(new Error(
            `${options.binName}: probe of ${options.packageName} exited with ${String(code)} without a report: ${Buffer.concat(err).toString('utf8').trim()}`,
          ))
        }
      })
    })
  })
}

const DEFAULT_TIMEOUT_MS = 20_000

/** The rows a bundle patch inserts, flattened from nested groups, with the ids of overrides on other rows. */
function describeBundlePatch(binName: string, patchPath: string): { rows: PluginProbeRow[]; overrides: string[] } {
  const rows: PluginProbeRow[] = []
  const own = new Set<string>()
  const visit = (row: EntryOptions): void => {
    if (typeof row.id === 'string') own.add(row.id)
    rows.push({ ...typeof row.id === 'string' ? { id: row.id } : {}, name: row.name, gated: row.disabled !== undefined })
    if (row.group && Array.isArray(row.config)) (row.config as EntryOptions[]).forEach(visit)
  }
  const patches = loadOverlayPatches(binName, patchPath)
  for (const patch of patches) patch.insert?.forEach(visit)
  const overrides = patches
    .filter(patch => patch.insert === undefined && typeof patch.id === 'string' && !own.has(patch.id))
    .map(patch => patch.id as string)
  return { rows, overrides }
}

/**
 * Whether a package declares itself to dsh: a `dsh` section in its manifest,
 * or a dependency on `@deepseek-ai/cordis`. A cordis plugin needs at least
 * cordis's types, and the harness's plugin conventions put display and
 * composition metadata under `dsh`; a package with neither that happens to
 * export a function (`lodash`, `debug`) is a library.
 * @param manifest - the package manifest.
 * @returns true for a package that declares itself to dsh.
 */
function declaresDsh(manifest: ProbedManifest): boolean {
  if (manifest.dsh !== undefined) return true
  return '@deepseek-ai/cordis' in (manifest.peerDependencies ?? {}) || '@deepseek-ai/cordis' in (manifest.dependencies ?? {})
}

/**
 * Probe one installed package: read its manifest, then import it in a child
 * process. The child never runs inside the host, so a package that throws at
 * import, exits, or hangs costs one child process and yields a `ok: false`
 * record with the reason.
 * @param options - where the package lives and how to run the child.
 * @returns the probe record.
 * @throws when the package is not resolvable from the profile, or the child produced no report.
 */
export async function probePackage(options: ProbeOptions): Promise<PluginProbe> {
  const packageDir = resolveBundleDir(options.binName, options.packageName, options.installAnchor, options.profileDir)
  const manifest = readProfileManifest(options.binName, packageDir) as ProbedManifest
  const declaredBundle = manifest.dsh?.bundle?.patch
  const declaredAddable = manifest.dsh?.plugins ?? []
  const { rows, overrides } = declaredBundle === undefined
    ? { rows: [], overrides: [] }
    : describeBundlePatch(options.binName, join(packageDir, declaredBundle))
  const hasMain = manifest.main !== undefined || manifest.exports !== undefined
  const report = await runChild(options, packageDir, hasMain ? options.packageName : '', declaredAddable.map(entry => entry.name))
  const harnessCordis = resolveHarnessCordis()
  // Compared by package directory, not by entry file: a source launch
  // resolves the harness's copy to its TypeScript entry while the child, a
  // plain Node process, resolves the same package's built entry.
  const cordisSameCopy = report.cordis === null || harnessCordis === undefined
    ? null
    : cordisPackageDir(report.cordis) === cordisPackageDir(harnessCordis)
  const kind: PluginProbe['kind'] = declaredBundle !== undefined
    ? 'bundle'
    : report.main.isPlugin && declaresDsh(manifest) ? 'plugin' : 'library'
  const addable: PluginProbeAddable[] = declaredAddable.map((entry) => {
    // The child reports every declared name; a missing report is a child
    // that did not run the loop, which the report parse already rejected.
    /* v8 ignore next */
    const inspected = report.addable[entry.name] ?? { ok: false, isPlugin: false, configSchema: null, error: 'no report' }
    return {
      name: entry.name,
      ...entry.title === undefined ? {} : { title: entry.title },
      ...entry.config === undefined ? {} : { config: entry.config },
      ok: inspected.ok && inspected.isPlugin,
      ...inspected.error === undefined ? {} : { error: inspected.error },
      ...inspected.configSchema === null ? {} : { configSchema: inspected.configSchema },
    }
  })
  let reason: string | undefined
  // The child attaches the thrown value to every failed import; the fallback keeps the type total.
  /* v8 ignore next */
  if (hasMain && !report.main.ok) reason = `the package failed to import: ${report.main.error ?? 'unknown error'}`
  else if (cordisSameCopy === false) reason = 'the package resolves its own copy of @deepseek-ai/cordis instead of the harness\'s; declare cordis as a peer dependency'
  return {
    packageName: options.packageName,
    ...manifest.version === undefined ? {} : { version: manifest.version },
    ...manifest.description === undefined ? {} : { description: manifest.description },
    ...manifest.dsh?.title === undefined ? {} : { title: manifest.dsh.title },
    kind,
    ok: reason === undefined,
    ...reason === undefined ? {} : { reason },
    cordisSameCopy,
    ...manifest.engines?.dsh === undefined ? {} : { enginesDsh: manifest.engines.dsh },
    rows,
    overrides,
    addable,
    ...report.main.configSchema === null || report.main.configSchema === undefined ? {} : { configSchema: report.main.configSchema },
    checkedAt: new Date().toISOString(),
  }
}

/**
 * The copy of `@deepseek-ai/cordis` this harness runs: the one this module
 * resolves, which is the one every built-in plugin shares. Undefined only in
 * an environment that cannot resolve it at all.
 */
function resolveHarnessCordis(): string | undefined {
  try {
    return import.meta.resolve('@deepseek-ai/cordis')
  } catch {
    // Only an embedder without cordis on its module path lands here; the
    // harness itself always resolves its own peer.
    /* v8 ignore next */
    return undefined
  }
}

/**
 * The real directory of the `@deepseek-ai/cordis` package a resolved entry
 * URL belongs to: the nearest ancestor whose manifest carries that name.
 * @param url - a `file:` URL of one cordis entry module.
 * @returns the package directory with symlinks resolved, or the entry path
 * itself when no such manifest is found above it.
 */
function cordisPackageDir(url: string): string {
  let dir = dirname(fileURLToPath(url))
  for (;;) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      let name: unknown
      try {
        name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }).name
      } catch {
        // A manifest Node's resolver did not read — an unrelated ancestor's,
        // malformed — is not cordis's; keep climbing.
        /* v8 ignore next */
        name = undefined
      }
      if (name === '@deepseek-ai/cordis') return realpathSync(dir)
    }
    const parent = dirname(dir)
    if (parent === dir) return fileURLToPath(url)
    dir = parent
  }
}

/** The cache file for one package under a profile. */
function probeCachePath(profileDir: string, packageName: string): string {
  return join(profileDir, PLUGIN_PROBE_DIR, `${packageName.replaceAll('/', '__')}.json`)
}

/**
 * Read one package's cached probe record.
 * @param profileDir - the profile directory.
 * @param packageName - the package.
 * @param version - when given, a record for a different version is treated as absent.
 * @returns the record, or undefined when none is cached or the cached one was written by another probe format.
 */
export function readProbeCache(profileDir: string, packageName: string, version?: string): PluginProbe | undefined {
  const path = probeCachePath(profileDir, packageName)
  if (!existsSync(path)) return undefined
  let stored: PluginProbe & { format?: number }
  try {
    stored = JSON.parse(readFileSync(path, 'utf8')) as PluginProbe & { format?: number }
  } catch {
    return undefined
  }
  const { format, ...record } = stored
  if (format !== PLUGIN_PROBE_FORMAT) return undefined
  if (version !== undefined && record.version !== version) return undefined
  return record
}

/**
 * Persist one package's probe record under the profile.
 * @param profileDir - the profile directory.
 * @param probe - the record to persist.
 */
export function writeProbeCache(profileDir: string, probe: PluginProbe): void {
  const path = probeCachePath(profileDir, probe.packageName)
  mkdirSync(join(profileDir, PLUGIN_PROBE_DIR), { recursive: true })
  writeFileSync(path, JSON.stringify({ format: PLUGIN_PROBE_FORMAT, ...probe }, undefined, 2) + '\n')
}
