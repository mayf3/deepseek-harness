/**
 * The `profileRuntime` service: the booted profile's facts and the one
 * recomposition entry point every live change to the host tree goes through —
 * user patch-file reloads, bundle enable/disable, and hot install. A
 * recomposition composes a candidate stack, applies it through the root
 * include, and publishes the profile, the stack's id ownership, and its
 * conflicts only once the include accepted it; a rejected update leaves the
 * committed composition in place, which describes the tree still running.
 * Recompositions run one at a time: each reads the committed composition
 * only after the previous one settled, so a watcher firing while a bundle is
 * being enabled recomposes the enabled tree instead of the one before it.
 * Before this service the composition closure lived in the launcher and
 * bundle layers were frozen at boot, so nothing in the tree could learn which
 * profile it ran in or add a layer while running.
 * @module @deepseek-ai/dsh-app-boot/profile-runtime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type Include from '@deepseek-ai/cordis-plugin-include'
import type { ProfilePatchReload } from '@deepseek-ai/dsh-package-manifest'
import type { ComposedStack, RowConflict } from './compose-stack.ts'
import type { BundleTrust, Profile, ProfileLayer } from './profile.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The booted profile's facts and recomposition; provided by the profile launcher. */
    profileRuntime: ProfileRuntime
  }
}

/** Where one mounted row came from. */
export interface RowOrigin {
  /** Who supplied the layer that inserted the row. */
  readonly trust: BundleTrust
  /** The bundle package that inserted the row. */
  readonly packageName: string
  /** The package's version, when its manifest declares one. */
  readonly version?: string
}

/** What the launcher hands the service. */
export interface ProfileRuntimeOptions {
  /** The profile as booted. */
  profile: Profile
  /** The stack the tree booted with, as `compose` rendered it for `profile`. */
  stack: ComposedStack
  /** Re-read the profile from disk, re-resolving its bundle layers. */
  loadProfile: () => Profile
  /** The complete patch stack for a profile — bundle layers, user layers, overlays — with the rows it left out. */
  compose: (profile: Profile) => ComposedStack
  /** The root Include entry, once mounted. */
  rootEntry: () => Entry | undefined
}

/** The profile and stack the tree runs, published together once the root include accepted the stack. */
interface CommittedComposition {
  readonly profile: Profile
  readonly stack: ComposedStack
}

/** Facts and recomposition of the booted profile. */
export class ProfileRuntime extends Service {
  private committed: CommittedComposition
  /** The recomposition in flight, or a settled promise; the next one chains behind it. */
  private queue: Promise<void> = Promise.resolve()

  constructor(ctx: Context, private readonly options: ProfileRuntimeOptions) {
    super(ctx, 'profileRuntime')
    this.committed = { profile: options.profile, stack: options.stack }
  }

  /** The profile as last composed; re-read by a `recompose({ reloadBundles: true })` the include accepted. */
  get current(): Profile {
    return this.committed.profile
  }

  /** The profile name (`dsh --profile <name>`). */
  get profileName(): string {
    return this.committed.profile.name
  }

  /** Absolute profile directory. */
  get dir(): string {
    return this.committed.profile.dir
  }

  /** Absolute path of the profile's own user patch file. */
  get patchPath(): string {
    return this.committed.profile.patchPath
  }

  /** Whether user patch files reload while the profile runs. */
  get patchReload(): ProfilePatchReload {
    return this.committed.profile.patchReload
  }

  /** The bundle layers currently composed, in application order. */
  get layers(): readonly ProfileLayer[] {
    return this.committed.profile.layers
  }

  /** The rows the current composition left out: bundles skipped over a row id and user inserts of taken ids. */
  get conflicts(): readonly RowConflict[] {
    return this.committed.stack.conflicts
  }

  /**
   * Where one mounted row came from.
   * @param rowId - the row's id as the composition declares it.
   * @returns the origin, or undefined for a row no bundle layer owns (a user or overlay row, or a bundle left out by a conflict).
   */
  originOf(rowId: string): RowOrigin | undefined {
    const layer = this.committed.stack.owners.get(rowId)
    if (layer === undefined) return undefined
    return {
      trust: layer.trust,
      packageName: layer.packageName,
      ...layer.version === undefined ? {} : { version: layer.version },
    }
  }

  /**
   * Row ids the user patch layers disable with a literal `disabled: true`,
   * as the committed composition read them. The set describes the running
   * tree: a user file the include rejected, or one that cannot be parsed,
   * changes nothing here until a composition with it is accepted.
   * @returns the ids, from the committed composition.
   */
  userDisabledRowIds(): ReadonlySet<string> {
    return this.committed.stack.userDisabledRowIds
  }

  /**
   * Whether the user patch layers disable an entry: its own row id, or the
   * id of a group holding it, is among {@link userDisabledRowIds}. The Loader
   * disables every descendant of a disabled group, so a child's own id alone
   * does not say who switched it off.
   * @param entry - the Loader entry.
   * @returns true when the user's patches disable the entry or one of the groups holding it.
   */
  userDisables(entry: Entry): boolean {
    return userDisablesEntry(entry, this.committed.stack.userDisabledRowIds)
  }

  /**
   * Recompose the host tree from the profile's layers and the user patch files
   * as they stand now. The root Include re-applies the stack transactionally:
   * a row whose options changed is updated in place, a row that appeared is
   * created, a row that vanished is disposed, and a failure rolls the whole
   * update back with the previous tree still running. The candidate profile,
   * its ownership, and its conflicts become the committed composition only
   * once the update holds; until then, and after a rejection, `current`,
   * `layers`, `originOf`, and `conflicts` keep describing the running tree.
   * Calls queue: one that arrives while another is in flight starts after it
   * settled and reads what it committed. A rejection is that call's outcome
   * alone and does not stop the ones behind it.
   * @param options - `reloadBundles` re-reads the profile manifest first, so a
   * bundle enabled or installed since boot joins the stack.
   * @throws when the root include is not mounted, or the Loader rejected the update.
   */
  async recompose(options: { reloadBundles?: boolean } = {}): Promise<void> {
    const run = this.queue.then(() => this.recomposeNow(options))
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async recomposeNow(options: { reloadBundles?: boolean }): Promise<void> {
    const entry = this.options.rootEntry()
    if (entry === undefined) throw new Error('profileRuntime: the root include is not mounted')
    const profile = options.reloadBundles === true ? this.options.loadProfile() : this.committed.profile
    const stack = this.options.compose(profile)
    const { patches: _previousPatches, ...includeConfig } = entry.options.config as Include.Config
    await entry.update({
      config: {
        ...includeConfig,
        patches: stack.patches,
      },
    })
    this.committed = { profile, stack }
  }
}

/** The walk behind {@link ProfileRuntime.userDisables}: the entry, then each group holding it, outward. */
function userDisablesEntry(entry: Entry, userDisabled: ReadonlySet<string>): boolean {
  for (let current: Entry | undefined = entry; current !== undefined; current = current.parent.ctx.fiber.entry) {
    if (typeof current.options.id === 'string' && userDisabled.has(current.options.id)) return true
  }
  return false
}
