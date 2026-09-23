/** Shared profile package operations used by dsh plugin and the running manager. */
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execa } from 'execa'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  DEFAULT_PROFILE_BUNDLES, bundlePatchPaths, initProfile, PROFILE_TEMPLATES, readProfileManifest,
  resolveBundleDir, resolveProfileDir, loadOverlayPatches, type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { awaitTreeGone, leadsOwnGroup } from './run-tree.ts'
import type { PackageResult, Registry } from './types.ts'

/** Profile and invocation locations supplied by the launcher. */
export interface PackageOperationContext {
  profile: string
  /** Explicit directory for an application-owned profile; named CLI profiles resolve under home. */
  dir?: string
  installAnchor: string
  cwd: string
  home?: string
}

/** Output and cancellation policy for one pnpm operation. */
export interface PackageOperationOptions {
  /** The pnpm executable name or path; resolved through `PATH` like the `dsh plugin` command. Defaults to `pnpm`. */
  command?: string
  /** Prefix arguments for an application-owned executable. */
  args?: readonly string[]
  /** Application runtime environment, applied only to this package operation. */
  env?: Readonly<Record<string, string>>
  /** CLI inherits authentication and terminal descriptors; service scrubs secrets and captures output. */
  execution: 'cli' | 'service'
  signal?: AbortSignal
  outputBytes: number
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
  activateNewBundles?: boolean
  lockWaitMs?: number
  /**
   * Terminate the run once its captured output has been silent for this long, in
   * milliseconds. A run stopped this way reports `timedOut`; without a bound, a
   * child that stops progressing without exiting holds its caller forever. A run
   * with inherited descriptors captures nothing and is never bound.
   */
  idleTimeoutMs?: number
}

/** Resolve relative package specs against the caller's directory.
 * @param argument One pnpm argument.
 * @param cwd Invocation directory, never the profile directory.
 * @returns Anchored argument.
 */
export function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  return `${match.groups.prefix ?? ''}${resolve(cwd, match.groups.path)}`
}

/** Read bundle metadata without loading its JavaScript.
 * @param name Installed dependency or installation-owned package name.
 * @param dir Profile directory.
 * @param anchor Installation manifest.
 * @returns Resolved metadata, or undefined for packages without bundle metadata.
 */
export function bundleManifest(name: string, dir: string, anchor: string): ProfileManifest | undefined {
  const packageDir = resolveBundleDir('dsh', name, anchor, dir)
  const manifest = readProfileManifest('dsh', packageDir)
  return manifest.dsh?.bundle?.patch === undefined ? undefined : manifest
}

/** Atomically save a profile manifest while retaining unrelated fields.
 * @param dir Profile directory.
 * @param manifest Updated document.
 */
export async function saveManifest(dir: string, manifest: ProfileManifest): Promise<void> {
  await writeFileAtomic(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n', { mode: 0o600 })
}

/** Reconcile package removals and newly installed bundles without re-enabling retained dependencies. */
async function reconcile(before: ProfileManifest, dir: string, anchor: string, options: PackageOperationOptions): Promise<void> {
  const after = readProfileManifest('dsh', dir)
  const dependencies = Object.keys(after.dependencies ?? {})
  const beforeDeps = new Set(Object.keys(before.dependencies ?? {}))
  const previous = after.dsh?.profile?.bundles ?? []
  const bundles = previous.filter((name) => {
    if (!beforeDeps.has(name) && !dependencies.includes(name)) return true
    return dependencies.includes(name) && bundleManifest(name, dir, anchor) !== undefined
  })
  for (const name of dependencies) {
    if (beforeDeps.has(name)) continue
    const metadata = bundleManifest(name, dir, anchor)
    if (metadata?.dsh?.bundle === undefined) {
      options.onOutput?.(`dsh: warning: ${name} declares no dsh.bundle — installed as a plain dependency, not a profile layer\n`, 'stderr')
      continue
    }
    for (const file of bundlePatchPaths(resolveBundleDir('dsh', name, anchor, dir), metadata.dsh.bundle)) loadOverlayPatches('dsh', file)
    if (!bundles.includes(name)) {
      bundles.push(name)
    }
  }
  if (JSON.stringify(previous) === JSON.stringify(bundles)) return
  after.dsh = { ...after.dsh, profile: { ...after.dsh?.profile, bundles } }
  await saveManifest(dir, after)
}

/**
 * How long the pipes keep draining after their process exited, as a fixed part of
 * finishing a run rather than a deployment knob: a descendant that inherited them
 * holds them open, and the tail a failure classification reads is written by then.
 */
const DRAIN_AFTER_EXIT_MS = 2_000

/** Whether every collector finished within `ms`.
 * @param collectors The pipe readers racing the bound.
 * @param ms The longest wait, in milliseconds.
 * @returns True when all collectors settled in time.
 */
async function drainWithin(collectors: readonly Promise<void>[], ms: number): Promise<boolean> {
  if (collectors.length === 0) return true
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      Promise.allSettled(collectors).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => { resolve(false) }, ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Execute pnpm inside a profile whose caller already holds the profile write lock.
 * @param context Launcher-owned profile and resolution locations.
 * @param args Pnpm arguments, before relative path anchoring.
 * @param options Output, activation and cancellation policy.
 * @returns Exit status, whether the silence bound stopped the run, and the diagnostic path.
 * Service output is bounded; CLI output uses inherited descriptors.
 */
export async function runProfilePnpm(
  context: PackageOperationContext, args: readonly string[], options: PackageOperationOptions,
): Promise<PackageResult> {
  const dir = context.dir ?? resolveProfileDir(context.profile, context.home)
  const before = readProfileManifest('dsh', dir)
  const logRoot = join(dir, '.plugin-manager', 'logs')
  await mkdir(logRoot, { recursive: true, mode: 0o700 })
  const logDir = await mkdtemp(join(logRoot, 'operation-'))
  const logPath = join(logDir, 'pnpm.log')
  const log = await open(logPath, 'wx', 0o600)
  let output = Buffer.alloc(0)
  let truncated = false
  const cancellation = new AbortController()
  // A service run captures output, so execa terminates the tree it leads when the
  // run is killed: a lifecycle script outlives the pnpm process that started it.
  // The CLI keeps the caller's process group, so an interrupt still reaches it.
  const grouped = leadsOwnGroup(options.execution)
  const child = execa(options.command ?? 'pnpm', [...options.args ?? [], ...args.map(arg => anchorPathSpec(arg, context.cwd))], {
    cwd: dir, env: { ...(options.execution === 'cli' ? process.env : scrubbedParentEnv()), ...options.env }, extendEnv: false, reject: false,
    stdout: options.execution === 'cli' ? 'inherit' : 'pipe',
    stderr: options.execution === 'cli' ? 'inherit' : 'pipe',
    killDescendants: options.execution === 'service',
    buffer: false, stdin: options.execution === 'cli' ? 'inherit' : 'ignore', cancelSignal: options.signal === undefined
      ? cancellation.signal : AbortSignal.any([cancellation.signal, options.signal]),
  })
  const append = (bytes: Buffer): void => {
    output = Buffer.concat([output, bytes])
    if (output.length > options.outputBytes) {
      truncated = true
      output = output.subarray(output.length - options.outputBytes)
    }
  }
  let writes = Promise.resolve()
  /** `settled` records that the process outcome is known; `stalled` that the silence bound stopped the run. */
  const control = { settled: false, stalled: false }
  /** Set once this call cuts the reading short itself, so the close it causes is not read as a run failure. */
  let cut = false
  /** The first failure a reading hit before that cut, which the run still reports. */
  let failure: Error | undefined
  let idleTimer: NodeJS.Timeout | undefined
  /** The silence bound: a captured run that stops printing without exiting is terminated, never awaited. */
  const armIdle = (): void => {
    if (control.settled || options.idleTimeoutMs === undefined) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      control.stalled = true
      // execa's kill reaches the whole tree of a service run, and escalates on its own.
      child.kill()
    }, options.idleTimeoutMs)
  }
  const collect = async (stream: AsyncIterable<Buffer | string>, kind: 'stdout' | 'stderr') => {
    try {
      for await (const chunk of stream) {
        armIdle()
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        writes = writes.then(async () => { await log.write(bytes) })
        await writes
        options.onOutput?.(bytes.toString('utf8'), kind)
        append(bytes)
      }
    } catch (error) {
      // A reading this call cut short is not a failure the run hit, and the run has
      // already exited, so there is nothing left for the cancellation to stop.
      if (!cut) {
        failure ??= error instanceof Error ? error : new Error(String(error))
        cancellation.abort()
      }
      throw error
    }
  }
  const collectors = [
    ...child.stdout === null ? [] : [collect(child.stdout, 'stdout')],
    ...child.stderr === null ? [] : [collect(child.stderr, 'stderr')],
  ]
  // The drain decides whether a failure surfaces, so each reading is claimed now:
  // an unclaimed rejection would be reported as unhandled while the pipes drain.
  for (const collector of collectors) void collector.catch(() => { /* reported through `failure` and the settled readings */ })
  // Inherited descriptors hand pnpm the terminal, so there is no captured output
  // for a silence bound to observe: it would fire on a healthy run.
  if (collectors.length > 0) armIdle()
  let exitCode: number
  try {
    // execa resolves its promise only once the piped stdio has ended, so the
    // process's own exit — the run's completion — is read from the raw child. A
    // spawn failure settles without one.
    const settled = Promise.allSettled([child])
    await Promise.race([once(child.nodeChildProcess, 'exit').catch(() => undefined), settled])
    control.settled = true
    clearTimeout(idleTimer)
    // A stalled run stops its whole tree first, so the caller's rollback and lock
    // release happen only after the scripts it started stopped writing.
    if (control.stalled) await awaitTreeGone({ pid: child.pid, grouped })
    // A descendant that inherited the pipes can hold them open past the process;
    // the tail drains under a bound instead of being awaited forever.
    const drained = await drainWithin(collectors, DRAIN_AFTER_EXIT_MS)
    if (drained) {
      for (const stream of await Promise.allSettled(collectors)) if (stream.status === 'rejected') throw stream.reason
    } else {
      // Cutting the tail short is this call's own end, not a failure the run hit;
      // a failure from before the cut still surfaces, and the cut leaves a notice
      // in the log because a classification may read an incomplete tail.
      cut = true
      child.stdout?.destroy()
      child.stderr?.destroy()
      const notice = 'dsh: pnpm output was cut short after its process exited\n'
      await log.write(notice)
      // A failure from before the cut is the run's own and replaces the notice a
      // caller would otherwise read; a rejection the cut itself causes is its end.
      if (failure !== undefined) throw failure
      options.onOutput?.(notice, 'stderr')
      append(Buffer.from(notice))
    }
    const [completion] = await settled
    if (completion.status === 'rejected') throw completion.reason
    const result = completion.value
    exitCode = result.exitCode ?? (result.code === 'ENOENT' ? 127 : 1)
    if (control.stalled) {
      const notice = `dsh: pnpm printed nothing for ${String(options.idleTimeoutMs)}ms and was terminated\n`
      await log.write(notice)
      options.onOutput?.(notice, 'stderr')
      append(Buffer.from(notice))
    }
    if (result.failed && output.length === 0) {
      const diagnostic = result.shortMessage ?? 'pnpm failed'
      await log.write(diagnostic)
      truncated = Buffer.byteLength(diagnostic) > options.outputBytes
      output = Buffer.from(diagnostic).subarray(0, options.outputBytes)
    }
    // A terminated run's exit status says nothing about what it wrote, so it never reconciles the selection.
    if (exitCode === 0 && !control.stalled && options.activateNewBundles !== false) {
      await reconcile(before, dir, context.installAnchor, options)
    }
  } finally {
    control.settled = true
    clearTimeout(idleTimer)
    await log.close()
  }
  return { exitCode, output: output.toString('utf8'), truncated, logPath, ...control.stalled ? { timedOut: true } : {} }
}

/** Initialize and run the dsh plugin command with the same write lock as the service.
 * @param context Launcher-owned locations.
 * @param args Pnpm arguments.
 * @param options Output and cancellation policy.
 * @returns Completed package-manager result.
 */
export async function runPluginCommand(
  context: PackageOperationContext, args: readonly string[], options: PackageOperationOptions,
): Promise<PackageResult> {
  const dir = context.dir ?? resolveProfileDir(context.profile, context.home)
  await mkdir(dir, { recursive: true })
  return withFileLock(join(dir, 'package.json'), async () => {
    if (!existsSync(join(dir, 'package.json'))) {
      const template = PROFILE_TEMPLATES[context.profile]
      initProfile(dir, template?.bundles ?? DEFAULT_PROFILE_BUNDLES)
      options.onOutput?.(`dsh: initialized profile ${context.profile} at ${dir}\n`, 'stderr')
    }
    return runProfilePnpm(context, args, options)
  }, options.lockWaitMs === undefined ? undefined : { waitMs: options.lockWaitMs })
}

/** What one registry lookup answered. */
export interface PackageViewResult {
  /** pnpm's exit code, null when it ended without one or never started. */
  exitCode: number | null
  stdout: string
  stderr: string
  /** The lookup ran past its bound and was killed. */
  timedOut: boolean
  /** The failure of starting pnpm at all, when that is what happened. */
  cause?: unknown
}

/** Bounds of one registry lookup. */
export interface PackageViewOptions {
  /** The pnpm executable name or path. Defaults to `pnpm`. */
  command?: string
  /** Prefix arguments for an application-owned executable. */
  args?: readonly string[]
  /** Application runtime environment, applied only to this package operation. */
  env?: Readonly<Record<string, string>>
  /** Ends the lookup early; the caller's signal, when it has one. */
  signal?: AbortSignal
  /** Bound on the lookup, in milliseconds. */
  timeoutMs: number
  /** The registry asked; null asks the one pnpm's own configuration names. */
  registry?: Registry
}

/**
 * Read the registry pnpm's own configuration names in the profile: its `.npmrc` chain and workspace settings,
 * as `pnpm config get registry` resolves them.
 * @param dir Profile directory.
 * @param options The pnpm executable and the time bound.
 * @returns The registry URL as pnpm printed it, or null when pnpm did not answer with one.
 */
export async function readProfileRegistry(
  dir: string, options: { command?: string; args?: readonly string[]; env?: Readonly<Record<string, string>>; timeoutMs: number },
): Promise<string | null> {
  const result = await execa(options.command ?? 'pnpm', [...options.args ?? [], 'config', 'get', 'registry'], {
    cwd: dir, env: { ...scrubbedParentEnv(), ...options.env }, extendEnv: false, reject: false, stdin: 'ignore', timeout: options.timeoutMs,
  })
  // The registry is the last line: pnpm may print a notice before it.
  const answer = result.exitCode === 0 ? result.stdout.trim().replace(/^[\s\S]*\n/, '').trim() : ''
  return /^https?:\/\/\S+$/.test(answer) ? answer : null
}

/**
 * The argument that sends one pnpm command to a registry.
 * @param registry - the registry, or null for the one pnpm's own configuration names.
 * @returns `--registry=<url>` for a URL; nothing for null.
 */
export function registryArguments(registry: Registry): string[] {
  return registry === null ? [] : [`--registry=${registry}`]
}

/**
 * Ask the registry what a spec names through `pnpm view`, run in the profile
 * directory so the registry, proxy, and authentication settings of an install
 * apply. The lookup makes one request without pnpm's own retries: a registry
 * that does not answer is reported within `timeoutMs`, and the registries
 * configured after it are the retry.
 * @param dir Profile directory.
 * @param spec One registry spec: a package name with an optional range.
 * @param options The registry, cancellation, and the time bound.
 * @returns pnpm's exit, output, and how the lookup ended.
 */
export async function viewProfilePackage(dir: string, spec: string, options: PackageViewOptions): Promise<PackageViewResult> {
  const result = await execa(options.command ?? 'pnpm', [
    ...options.args ?? [], 'view', spec, 'name', 'version', 'description', 'dsh', '--json',
    ...registryArguments(options.registry ?? null), '--config.fetch-retries=0',
  ], {
    cwd: dir, env: { ...scrubbedParentEnv(), ...options.env }, extendEnv: false, reject: false, stdin: 'ignore',
    timeout: options.timeoutMs, ...options.signal === undefined ? {} : { cancelSignal: options.signal },
  })
  const cause = result.exitCode === undefined && !result.timedOut && !result.isCanceled
    ? Object.assign(new Error(result.shortMessage), { code: result.code })
    : undefined
  return {
    exitCode: result.exitCode ?? null, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut,
    ...cause === undefined ? {} : { cause },
  }
}
