/**
 * The install-time probe: what an installed package is and whether this
 * harness can load it, answered in a child process so a package that throws,
 * hangs, or brings its own copy of cordis never runs inside the host. The
 * manifest facts (kind, rows, declared modules) are read here; the child
 * (`probe-child.ts`) only imports and reports over IPC, and the report and
 * the cached record are validated as the process and file boundaries they
 * cross.
 * @module @deepseek-ai/dsh-app-boot/probe
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withoutSensitiveEnv } from '@deepseek-ai/dsh-launch-environment'
import { loadOverlayPatches } from './index.ts'
import { readProfileManifest, resolveBundleDir, type ProfileManifest } from './profile.ts'
import { visitPatchRows } from './patch-rows.ts'
import { isRecord, parseChildReport, type ChildReport } from './probe-report.ts'

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
  /**
   * Whether the main export imported and cordis is not a second copy. True
   * for a `library`, for a package whose cordis resolution is unknown, and
   * for one whose addable modules failed: `kind` and `addable[].ok` decide
   * what can be enabled or added.
   */
  readonly ok: boolean
  /** Why the import or the cordis check failed, when `ok` is false. */
  readonly reason?: string
  /** Whether the package resolves `@deepseek-ai/cordis` to the harness's own copy; null when unknown. */
  readonly cordisSameCopy: boolean | null
  /** The harness version range the package declares in `engines.dsh`. */
  readonly enginesDsh?: string
  /** Rows the bundle's patch introduces, inserted or set as a group's config, empty for a non-bundle. */
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
}

/**
 * The child entry beside this module: the TypeScript source under a source
 * launch, run through tsx; the bundled `lib/probe-child.js` otherwise.
 */
function childEntryArgs(): string[] {
  /* v8 ignore next 3 -- the built-output arm: tests run from src */
  if (!import.meta.url.endsWith('.ts')) {
    return [fileURLToPath(new URL('./probe-child.js', import.meta.url))]
  }
  return ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./probe-child.ts', import.meta.url))]
}

/**
 * Run the child and take its report from the IPC channel. The report is all
 * the probe needs, so the child is killed once it arrived: a package that
 * keeps a timer alive after import costs nothing more. stdout is not read
 * at all, so whatever the imported modules print cannot corrupt the report.
 * The child gets the parent environment minus credential-shaped names, plus
 * a per-run token it echoes in its report — a message without the token is
 * the package's own, not the report — and the probe settles only once the
 * child closed, so its pipes and channel are gone when the caller continues.
 */
function runChild(options: ProbeOptions, packageDir: string, mainSpecifier: string, addable: string[]): Promise<ChildReport> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const token = randomUUID()
    const child = spawn(
      options.nodeExecutable ?? process.execPath,
      ['--experimental-import-meta-resolve', ...childEntryArgs(), packageDir, mainSpecifier, JSON.stringify(addable)],
      {
        cwd: options.profileDir,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: { ...withoutSensitiveEnv(process.env), NODE_NO_WARNINGS: '1', [PROBE_REPORT_VARIABLE]: token },
      },
    )
    // The tail of stderr, for the failure text: a package that floods stderr at
    // import must not grow this process's heap by as much.
    const err = new StreamTail(STDERR_TAIL_BYTES)
    child.stderr?.on('data', (chunk: Buffer) => { err.push(chunk) })
    // The outcome lands on `close`. A kill — after the report, or at the
    // timeout — records its outcome and waits for the close it causes, so the
    // child's pipes and channel are gone when the caller continues; a spawn
    // failure emits `error` with no process to wait for.
    let outcome: (() => void) | undefined
    const finish = (next: () => void): void => {
      /* v8 ignore next -- a report the kill still let through after the timeout decided, or the reverse: the first outcome stands */
      if (outcome !== undefined) return
      outcome = next
      clearTimeout(timer)
      child.kill('SIGKILL')
    }
    const timer = setTimeout(() => {
      finish(() => { reject(new Error(`${options.binName}: probe of ${options.packageName} timed out after ${String(timeoutMs)}ms`)) })
    }, timeoutMs)
    child.on('message', (message) => {
      const report = parseChildReport(message)
      /* v8 ignore next -- the imported code finds no process.send; a message through the raw channel would still lack the token */
      if (report === undefined || report.token !== token) return
      finish(() => { resolve(report) })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (outcome !== undefined) {
        outcome()
        return
      }
      const tail = err.text().trim()
      reject(new Error(`${options.binName}: probe of ${options.packageName} exited with ${String(code)} without a report: ${tail}`))
    })
  })
}

const DEFAULT_TIMEOUT_MS = 20_000

/** How much of the child's stderr the failure text keeps: the end, where the cause usually is. */
const STDERR_TAIL_BYTES = 16 * 1024

/**
 * The last `limit` bytes a stream delivered, kept as the chunks it arrived in:
 * as more arrives, whole chunks leave the front and the oldest kept chunk is
 * trimmed, so one chunk larger than the limit keeps its end and a small chunk
 * after it never drops what was kept.
 */
export class StreamTail {
  private readonly chunks: Buffer[] = []
  private bytes = 0

  /** @param limit - how many bytes of the end to keep. */
  constructor(private readonly limit: number) {}

  /**
   * Take one more chunk from the stream.
   * @param chunk - the bytes as delivered.
   */
  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.bytes += chunk.length
    while (this.bytes > this.limit) {
      const excess = this.bytes - this.limit
      const first = this.chunks[0] as Buffer
      if (first.length <= excess) {
        this.chunks.shift()
        this.bytes -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.bytes = this.limit
      }
    }
  }

  /**
   * The kept end of the stream.
   * @returns the last bytes delivered, at most the limit, as UTF-8 text.
   */
  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/** The environment name carrying the run's report token; the child removes it before importing anything. */
const PROBE_REPORT_VARIABLE = 'DSH_PROBE_REPORT'

/** The rows a bundle patch introduces, flattened from nested groups, with the ids of overrides on other rows. */
function describeBundlePatch(binName: string, patchPath: string): { rows: PluginProbeRow[]; overrides: string[] } {
  const rows: PluginProbeRow[] = []
  const own = new Set<string>()
  const patches = loadOverlayPatches(binName, patchPath)
  visitPatchRows(patches, (row) => {
    if (typeof row.id === 'string') own.add(row.id)
    rows.push({ ...typeof row.id === 'string' ? { id: row.id } : {}, name: row.name, gated: row.disabled !== undefined })
  })
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
  const cordisSameCopy = sameCordisCopy(report.cordis, resolveHarnessCordis())
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
 * The package directory of the `@deepseek-ai/cordis` copy this harness runs:
 * the one this module resolves, which every built-in plugin shares. Undefined
 * only in an environment that cannot resolve it at all.
 */
function resolveHarnessCordis(): string | undefined {
  try {
    return cordisPackageDir(import.meta.resolve('@deepseek-ai/cordis'))
  } catch {
    // Only an embedder without cordis on its module path lands here; the
    // harness itself always resolves its own peer.
    /* v8 ignore next */
    return undefined
  }
}

/**
 * Whether the package's cordis is the harness's: the two package directories
 * compare equal. Null when the package resolves no cordis, when the harness
 * cannot resolve its own, or when no cordis manifest encloses what the
 * package resolved, since none of those says the package brought a copy.
 */
function sameCordisCopy(reported: string | null, harness: string | undefined): boolean | null {
  if (reported === null) return null
  /* v8 ignore next -- the harness resolves its own peer; only an embedder without cordis lands here */
  if (harness === undefined) return null
  const dir = cordisPackageDir(reported)
  return dir === undefined ? null : dir === harness
}

/** The manifest fields that tell a dsh module proxy from the package it stands for. */
interface ProxyAwareManifest {
  name?: unknown
  dsh?: { moduleFallback?: { targets?: Record<string, string> } }
}

/**
 * The directory of the `@deepseek-ai/cordis` package a resolved module URL
 * belongs to, with symlinks resolved and a dsh module proxy followed to the
 * package it re-exports. Two resolutions of one installed package compare
 * equal this way whether they landed on `src` or `lib`, on a link or its
 * target, or on the proxy a packaged executable writes for its peers; the
 * URLs themselves differ in every one of those cases.
 * @param resolved - the URL `import.meta.resolve('@deepseek-ai/cordis')` gave.
 * @returns the real package directory, or undefined when no cordis manifest encloses the URL.
 */
export function cordisPackageDir(resolved: string): string | undefined {
  let dir = dirname(fileURLToPath(resolved))
  for (;;) {
    const manifestPath = join(dir, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProxyAwareManifest
      if (manifest.name === '@deepseek-ai/cordis') {
        const target = Object.values(manifest.dsh?.moduleFallback?.targets ?? {})[0]
        return target === undefined ? realpathSync(dir) : cordisPackageDir(target)
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
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
 * @returns the record, or undefined when none is cached, the cached one was written by another probe format, or it is not a record.
 */
export function readProbeCache(profileDir: string, packageName: string, version?: string): PluginProbe | undefined {
  const path = probeCachePath(profileDir, packageName)
  if (!existsSync(path)) return undefined
  let stored: unknown
  try {
    stored = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined // not JSON: a truncated or hand-edited file is probed again
  }
  if (!isRecord(stored) || stored.format !== PLUGIN_PROBE_FORMAT) return undefined
  const { format: _format, ...fields } = stored
  const record = parseProbeRecord(fields)
  if (record === undefined) return undefined
  if (version !== undefined && record.version !== version) return undefined
  return record
}

const PROBE_KINDS: ReadonlySet<string> = new Set<PluginProbe['kind']>(['bundle', 'plugin', 'library'])

/** Whether a value is absent or a string. */
function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

/** Whether a value has the fields of one probed row. */
function isProbeRow(value: unknown): value is PluginProbeRow {
  return isRecord(value) && optionalString(value.id) && typeof value.name === 'string' && typeof value.gated === 'boolean'
}

/** Whether a value has the fields of one addable module. */
function isProbeAddable(value: unknown): value is PluginProbeAddable {
  return isRecord(value) && typeof value.name === 'string' && optionalString(value.title) && typeof value.ok === 'boolean' && optionalString(value.error)
}

/**
 * Validate a stored probe record, as the cache file is a boundary this
 * process does not control.
 * @param value - the parsed file without its `format` field.
 * @returns the record, or undefined when a field is missing or mistyped.
 */
export function parseProbeRecord(value: unknown): PluginProbe | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.packageName !== 'string' || typeof value.checkedAt !== 'string') return undefined
  if (![value.version, value.description, value.title, value.reason, value.enginesDsh].every(optionalString)) return undefined
  if (typeof value.kind !== 'string' || !PROBE_KINDS.has(value.kind) || typeof value.ok !== 'boolean') return undefined
  if (value.cordisSameCopy !== null && typeof value.cordisSameCopy !== 'boolean') return undefined
  if (!Array.isArray(value.rows) || !value.rows.every(isProbeRow)) return undefined
  if (!Array.isArray(value.overrides) || !value.overrides.every(item => typeof item === 'string')) return undefined
  if (!Array.isArray(value.addable) || !value.addable.every(isProbeAddable)) return undefined
  return value as unknown as PluginProbe
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
