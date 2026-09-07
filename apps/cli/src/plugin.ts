/**
 * `dsh plugin --profile <name> <args...>` — profile plugin management from
 * the terminal. `add <spec...>` and `remove <name...>` go through the plugin
 * installer the Web host shares: pnpm runs in the profile directory, every
 * new package is probed, a package that declares neither a bundle nor a
 * plugin module (or whose row id a composed layer already owns) is removed
 * again with the reason printed, and every newly installed bundle joins the
 * layer list — the CLI's install-and-enable semantics. Every other pnpm verb
 * is forwarded verbatim and followed by a reconcile of the
 * `dsh.profile.bundles` layer list against the installed state, so `update`
 * activates a package that gained its `dsh.bundle` declaration in a newer
 * version. Nothing here boots the profile: the plugins being managed never
 * start.
 * @module @deepseek-ai/dsh/plugin
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  DEFAULT_PROFILE_BUNDLES,
  enableBundle,
  initProfile,
  loadProfile,
  PROFILE_TEMPLATES,
  readProfileManifest,
  reconcileInstalledBundles,
  resolveProfileDir,
  type probePackage,
  type ProfileManifest,
} from '@deepseek-ai/dsh-app-boot'
import {
  PluginInstaller, pluginOperationFailureOf, type PluginInstallOutcome, type PluginToolingConfig, type SpawnLike,
} from '@deepseek-ai/dsh-plugin-manager'
import { INSTALL_ANCHOR } from './profile-boot.ts'

const NAME = 'dsh'

/** The tooling bounds the command runs with; the Web host reads the same values from its config. */
const TOOLING: PluginToolingConfig = { pnpmCommand: 'pnpm', installTimeoutMs: 600_000, probeTimeoutMs: 20_000, installLogTailBytes: 16_384 }

/** Test seams: the child spawner and the package probe, so no pnpm or probe child runs. */
export interface PluginCommandInternals {
  spawn?: SpawnLike
  probe?: typeof probePackage
}

/**
 * Reconcile `dsh.profile.bundles` against the installed state with the CLI's
 * install-and-enable semantics after a forwarded pnpm verb: pnpm has already
 * written the real installed names and materialized the packages, and every
 * newly installed bundle joins the layer stack. Warns once per newly-added
 * bundle-less dependency (a plain library or plugin module is fine; the
 * warning is orientation).
 */
function reconcilePlugins(before: ProfileManifest, profileDir: string): void {
  const outcome = reconcileInstalledBundles(NAME, profileDir, INSTALL_ANCHOR, before, { autoEnable: true })
  warnPlain(outcome.plain)
}

function warnPlain(plain: readonly string[]): void {
  for (const packageName of plain) {
    process.stderr.write(
      `${NAME}: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer `
      + '(a later update that gains one activates it automatically)\n',
    )
  }
}

/**
 * Rewrite relative filesystem specs against the user's invoking directory.
 * pnpm runs with cwd = the profile directory, so a bare `.` or `../plugin`
 * (or their `file:`/`link:` forms) would silently resolve inside the profile
 * — `add .` from a plugin checkout would self-link the profile. Absolute
 * specs, registry names, and every other pnpm argument pass through
 * untouched.
 * @param argument - one pnpm argument, verbatim from argv.
 * @param cwd - the directory `dsh` was invoked from.
 * @returns the argument with a relative path spec anchored to `cwd`.
 */
function anchorPathSpec(argument: string, cwd: string): string {
  const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument)
  if (match?.groups?.path === undefined) return argument
  // A bare path stays bare and a prefixed spec keeps its prefix: pnpm's
  // link-vs-copy semantics differ between `file:` and a plain directory
  // path, and the anchor must not change which one the user asked for.
  const prefix = match.groups.prefix ?? ''
  return `${prefix}${resolve(cwd, match.groups.path)}`
}

/** Whether the arguments are an `add` or `remove` of plain specs, which the installer handles. */
function managedVerb(args: readonly string[]): 'add' | 'remove' | undefined {
  const [verb, ...rest] = args
  if ((verb !== 'add' && verb !== 'remove') || rest.length === 0 || rest.some(argument => argument.startsWith('-'))) return undefined
  return verb
}

/**
 * Run one `dsh plugin` invocation: init if needed, then install or remove
 * through the shared installer, or forward to pnpm and reconcile.
 * @param profile - the profile name.
 * @param args - pnpm arguments with relative path specs anchored to the invoking directory.
 * @param internals - test seams.
 * @returns the exit code.
 */
export async function runPlugin(profile: string, args: readonly string[], internals: PluginCommandInternals = {}): Promise<number> {
  const dir = resolveProfileDir(profile)
  if (!existsSync(join(dir, 'package.json'))) {
    const template = PROFILE_TEMPLATES[profile]
    initProfile(
      dir,
      template?.bundles ?? DEFAULT_PROFILE_BUNDLES,
      template?.patchReload,
    )
    process.stderr.write(`${NAME}: initialized profile ${profile} at ${dir}\n`)
  }
  const verb = managedVerb(args)
  if (verb !== undefined) return runManaged(profile, dir, verb, args.slice(1), internals)
  return forwardToPnpm(dir, args)
}

/** Install or remove through the installer, enabling every newly installed bundle as the CLI always has. */
async function runManaged(
  profile: string,
  dir: string,
  verb: 'add' | 'remove',
  specs: readonly string[],
  internals: PluginCommandInternals,
): Promise<number> {
  const installer = new PluginInstaller({
    profileDir: dir,
    profileName: profile,
    installAnchor: INSTALL_ANCHOR,
    loadProfile: () => loadProfile(NAME, profile, INSTALL_ANCHOR, undefined, { userLayer: false }),
    config: TOOLING,
    installLog: (chunk) => { (chunk.stream === 'stdout' ? process.stdout : process.stderr).write(chunk.text) },
    ...internals,
  })
  for (const argument of specs) {
    const spec = anchorPathSpec(argument, process.cwd())
    try {
      if (verb === 'remove') {
        await installer.remove(spec)
        continue
      }
      report(dir, await installer.add(spec))
    } catch (error) {
      const failure = pluginOperationFailureOf(error)
      if (failure?.code !== 'plugins/install-failed') throw error
      return explainFailure(dir, spec, failure.details.exitCode, failure.cause)
    }
  }
  return 0
}

/** Enable what the run installed, and say what it removed again and what it left as a plain dependency. */
function report(dir: string, outcome: PluginInstallOutcome): void {
  for (const name of outcome.installedOnly) enableBundle(NAME, dir, INSTALL_ANCHOR, name)
  for (const rejection of outcome.removed) {
    process.stderr.write(`${NAME}: removed ${rejection.name} again: ${rejection.reason}\n`)
  }
  warnPlain(outcome.plain)
}

/** The exit code and the orientation a failed pnpm run leaves the user with. */
function explainFailure(dir: string, spec: string, exitCode: number | null, cause: unknown): number {
  if ((cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    process.stderr.write(`${NAME}: pnpm not found on PATH — install pnpm to manage profile plugins\n`)
    return 127
  }
  // pnpm's own diagnostics name pnpm-workspace.yaml without saying WHICH
  // one; the profile owns it, and the commonest failure here is pnpm ≥10
  // blocking a git dependency's prepare (build) script until allowlisted.
  process.stderr.write(`${NAME}: pnpm failed in profile directory ${dir}\n`)
  if (/^git\+|^github:|\.git(?:#|$)/.test(spec)) {
    process.stderr.write(
      `${NAME}: git-hosted plugins build on install via their prepare script, which pnpm blocks until allowed — `
      + `add the exact key pnpm printed above under allowBuilds in ${join(dir, 'pnpm-workspace.yaml')}, then re-run\n`,
    )
  }
  return exitCode ?? 1
}

/** Forward any other pnpm verb verbatim, then reconcile the layer list. */
function forwardToPnpm(dir: string, args: readonly string[]): number {
  const before = readProfileManifest(NAME, dir)
  // Windows resolves pnpm through its .cmd shim, which spawn() refuses
  // without a shell since the CVE-2024-27980 hardening.
  const result = spawnSync('pnpm', args.map(argument => anchorPathSpec(argument, process.cwd())), {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      process.stderr.write(`${NAME}: pnpm not found on PATH — install pnpm to manage profile plugins\n`)
      return 127
    }
    throw result.error
  }
  const exitCode = result.status ?? 1
  if (exitCode === 0) {
    reconcilePlugins(before, dir)
  } else {
    process.stderr.write(`${NAME}: pnpm failed in profile directory ${dir}\n`)
  }
  return exitCode
}
