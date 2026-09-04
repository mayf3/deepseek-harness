/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, apply its selected patch-reload
 * lifecycle, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  boot,
  composeEntries,
  composeProfileStack,
  formatRowConflict,
  healProfilesModuleFallback,
  installFailLoud,
  installRuntimeGuards,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME,
  ProfileRuntime,
  recordRowConflicts,
  rootIncludeEntry,
  warnNestedFiberFailures,
  watchUserPatches,
  type ComposedStack,
  type Profile,
  type StackUserLayer,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline, type AppReady } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'

/** Launcher-owned readiness signal committed only after boot and host setup succeed. */
function createAppReady(): { service: AppReady; commit(): void } {
  let ready = false
  const listeners = new Set<() => void>()
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener()
          return () => {}
        }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    commit() {
      if (ready) return
      ready = true
      for (const listener of [...listeners]) listener()
      listeners.clear()
    },
  }
}

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/**
 * Load a resolved profile for `name` and (re)write the empty root config. The
 * root is always rewritten: the whole composition is patch layers, and the
 * vendored Loader's tree write-back (a plugin self-disposing persists the
 * current tree) can bake composed rows into this file — which would duplicate
 * every bundle insert on the next boot. The file exists on disk only because
 * the Loader needs a real include root to anchor `baseUrl` at the profile
 * directory (the config dump anchors on the same file, so both compose over
 * the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @returns the loaded profile.
 */
export function prepareProfile(name: string, userLayer = true): Profile {
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's patch stack as booted, and the overlays every later recomposition keeps on top. */
interface ComposedProfile {
  profile: Profile
  /** The stack as composed at boot: bundle layers, both user layers, overlays, the telemetry switch. */
  stack: ComposedStack
  /** Layers above the user layers on a live reload: `--patch` overlays and the telemetry switch. */
  overlays: StackUserLayer[]
}

/**
 * The user-owned layers of one profile as they stand on disk: the profile's
 * own patch file, then the home-level file (`$DSH_HOME/cordis.patch.yml` —
 * machine-local preferences that apply to every profile, so it outranks the
 * per-profile layer). BOTH files are re-read per call: the HMR watcher hands
 * a caller only the changed file's patches, and a fresh read of both keeps
 * the two watchers from stitching in each other's stale copy.
 * @param profile - the profile whose patch file to read.
 * @returns the two layers, labelled by path.
 */
function userLayersOf(profile: Profile): StackUserLayer[] {
  return [
    { label: profile.patchPath, patches: loadOptionalPatches(NAME, profile.patchPath) ?? [] },
    { label: homePatchPath(), patches: loadOptionalPatches(NAME, homePatchPath()) ?? [] },
  ]
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (a base-backed profile gets the base bundle's
 * platform-gated shell rows), the profile's user layer, the home-level user
 * layer, `--patch` overlays, then the telemetry switch. Row-id ownership is
 * decided here: a bundle whose id another layer already declares is left out
 * and reported, a user insert of a taken id is dropped and reported.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @returns the profile and its patch stack.
 */
async function composeProfile(
  name: string,
  patchFiles: readonly string[],
): Promise<ComposedProfile> {
  const profile = prepareProfile(name)
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile })
  const overlays: StackUserLayer[] = patchFiles.map(file => ({
    label: `--patch ${resolve(file)}`, patches: loadOverlayPatches(NAME, resolve(file)),
  }))
  const composed = composeProfileStack(NAME, profile.layers, [...userLayersOf(profile), ...overlays])
  const rows = new Set<string>()
  for (const row of composeEntries([composed.patches])) {
    if (typeof row.id === 'string') rows.add(row.id)
  }
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) overlays.push({ label: 'DSH_TELEMETRY_DISABLED', patches: [telemetryPatch] })
  const stack = telemetryPatch === undefined
    ? composed
    : composeProfileStack(NAME, profile.layers, [...userLayersOf(profile), ...overlays])
  return { profile, stack, overlays }
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
}

/**
 * Re-throw a watcher-setup failure unless a shutdown already owns the tree:
 * a signal aborted this invocation, or an app requested exit (`ctx.appExit`
 * from a fast one-shot) and the root's disposal rejected the in-flight setup
 * await. Either way the failure describes a tree that is exiting as asked,
 * not a broken watch.
 * @param ctx - the booted root context.
 * @param signal - this invocation's signal-shutdown fact.
 * @param error - the setup failure.
 */
function suppressShutdownError(ctx: Context, signal: AbortSignal, error: unknown): void {
  if (signal.aborted) return
  if (ctx.fiber.state !== FiberState.ACTIVE || ctx.get('loader') === undefined) return
  throw error
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  // Before the first plugin mounts and before anything can issue a request: Node's fetch ignores the
  // proxy environment on its own, so every profile would otherwise connect directly. Resolving from
  // the launcher's snapshot — not `process.env` — is what lets a proxy declared in a `.env` layer
  // work, which the NODE_USE_ENV_PROXY flag cannot do because Node samples the environment at start.
  const disposeProxy = await installProxyFromEnvironment(
    options.environment,
    (message) => { process.stderr.write(`${NAME}: ${message}\n`) },
  )

  const composed = await composeProfile(options.profile, options.patchFiles)
  const app: { current?: Context; runtime?: ProfileRuntime } = {}
  const appReady = createAppReady()
  let uninstallRuntimeGuards = (): void => {}
  const shutdown = createProcessShutdown(async () => {
    uninstallRuntimeGuards()
    await app.current?.fiber.dispose()
    await disposeProxy()
  })
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  // Signals own teardown throughout the startup window, not only after boot()
  // settles: an inserted provider can publish before sibling rows finish mounting.
  // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
  // surface — the launcher does not know whether the app considered its work
  // complete; SIGINT is a user interrupt and reports 130.
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  const uninstallFailLoud = installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })

  const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
  // Recomposition for the live user layers: bundle layers below, overlays
  // above, so a user edit can never displace them. Parsed app arguments are
  // not in here at all — they live in app-provided services that survive a
  // recomposition. BOTH
  // user files are re-read per generation (the HMR watcher hands us only the
  // changed file's patches, which one of the reads duplicates — fresh reads
  // keep the two watchers from stitching in each other's stale copy).
  // Fresh clones per generation: the include pushes `insert` rows into the
  // mounted tree BY REFERENCE and later id-targeted patches mutate those
  // objects in place. Reusing one parsed patch object across applications
  // would bake a user override into the bundle's in-memory insert row, so
  // removing the override could never revert the row to the bundle default.
  const composeFor = (profile: Profile): ComposedStack => {
    const stack = composeProfileStack(NAME, profile.layers, [...userLayersOf(profile), ...composed.overlays])
    return { ...stack, patches: structuredClone(stack.patches) }
  }
  // Once the profile runtime is mounted its profile is the current one: a
  // bundle enabled since boot lives only there. The watcher path has no
  // runtime to record conflicts on beyond the registry the runtime shares, so
  // it records them itself once the tree accepted the update.
  const composeLive = (): PatchOptions[] => {
    const stack = composeFor(app.runtime?.current ?? composed.profile)
    if (app.current !== undefined) recordRowConflicts(app.current, stack.conflicts)
    return stack.patches
  }
  for (const conflict of composed.stack.conflicts) process.stderr.write(`${NAME}: ${formatRowConflict(conflict)}\n`)
  // Cloned for the same insert-aliasing reason as composeLive: the boot
  // application must not mutate the objects later reloads recompose from.
  const ctx = await boot(NAME, rootConfig, structuredClone(composed.stack.patches), (hostCtx) => {
    app.current = hostCtx
    // Before any config-tree entry mounts, so plugins resolve all launch-time
    // environment values from the same immutable provenance snapshot.
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, options.environment)
    // The command line and bounded exit request are launcher facts available
    // to every app plugin that injects the argument snapshot.
    provideCmdline(hostCtx, {
      args: options.args,
      exit: code => void shutdown.shutdown(code),
      ready: appReady.service,
    })
  })
  app.current = ctx
  // The tree is up: a later unhandled rejection is a plugin's stray
  // continuation, not a load failure, and must not take every session down.
  uninstallFailLoud()
  uninstallRuntimeGuards = installRuntimeGuards(NAME, (line) => { process.stderr.write(`${line}\n`) })
  if (!signalShutdown.signal.aborted && ctx.fiber.state === FiberState.ACTIVE && ctx.get('loader') !== undefined) {
    warnNestedFiberFailures(ctx, NAME, (line) => { process.stderr.write(`${line}\n`) })
    recordRowConflicts(ctx, composed.stack.conflicts)
    await ctx.plugin(ProfileRuntime, {
      profile: composed.profile,
      installAnchor: INSTALL_ANCHOR,
      loadProfile: () => prepareProfile(options.profile),
      compose: composeFor,
      rootEntry: () => rootIncludeEntry(ctx),
      readUserPatches: () => [
        ...loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],
        ...loadOptionalPatches(NAME, homePatchPath()) ?? [],
      ],
    })
    const runtime = ctx.get('profileRuntime')
    if (runtime !== undefined) app.runtime = runtime
  }
  // A live-reload profile can dispose the whole tree while post-boot watcher
  // setup is in flight — a signal or appExit. Loader presence and fiber state
  // own liveness; the initial check skips a tree that already exited, and the
  // catch below re-checks for an exit that landed mid-setup. Startup-frozen
  // profiles apply every user layer above but install no HMR fallback or watcher.
  if (composed.profile.patchReload === 'live'
    && !signalShutdown.signal.aborted
    && ctx.fiber.state === FiberState.ACTIVE
    && ctx.get('loader') !== undefined) {
    try {
      // Config-only HMR for the live profile patch layer: dsh-base disables
      // module reload by default, so when no profile explicitly enabled that
      // service, mount a watch-only instance with no module roots —
      // cordis.patch.yml edits stay live without replacing source modules. A
      // silent skip would break the documented reload contract. HMR injects
      // the timer service, which a bare custom profile may not mount either.
      if (ctx.get('hmr') === undefined) {
        if (ctx.get('timer') === undefined) {
          await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
        }
        await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
      }
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: composed.profile.patchPath,
        compose: composeLive,
      })
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: homePatchPath(),
        compose: composeLive,
      })
    } catch (error) {
      suppressShutdownError(ctx, signalShutdown.signal, error)
    }
  }
  if (!signalShutdown.signal.aborted
    && ctx.fiber.state === FiberState.ACTIVE
    && ctx.get('loader') !== undefined) {
    appReady.commit()
  }
  return { ctx, shutdown }
}
