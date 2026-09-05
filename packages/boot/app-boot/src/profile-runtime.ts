/**
 * The `profileRuntime` service: the booted profile's facts and the one
 * recomposition entry point every live change to the host tree goes through —
 * user patch-file reloads, bundle enable/disable, and hot install. A
 * recomposition composes a candidate stack, applies it through the root
 * include, and publishes the profile, the stack's id ownership, and its
 * conflicts only once the include accepted it; a rejected update leaves the
 * committed composition in place, which describes the tree still running.
 * Before this service the composition closure lived in the launcher and
 * bundle layers were frozen at boot, so nothing in the tree could learn which
 * profile it ran in or add a layer while running.
 * @module @deepseek-ai/dsh-app-boot/profile-runtime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type Include from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
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
  /** The user patch layers as they stand on disk (profile file, then home file). */
  readUserPatches: () => PatchOptions[]
}

/** The profile and stack the tree runs, published together once the root include accepted the stack. */
interface CommittedComposition {
  readonly profile: Profile
  readonly stack: ComposedStack
}

/** Facts and recomposition of the booted profile. */
export class ProfileRuntime extends Service {
  private committed: CommittedComposition

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
   * Row ids the user patch layers disable with a literal `disabled: true`.
   * A `!!js` gate in a user file stays an expression node when read from
   * disk, so it is a condition, not a user decision, and is left to the
   * composition.
   * @returns the ids, re-read from disk on every call.
   */
  userDisabledRowIds(): Set<string> {
    const ids = new Set<string>()
    for (const patch of this.options.readUserPatches()) {
      if (patch.insert !== undefined || patch.id === undefined) continue
      if (patch.disabled === true) ids.add(patch.id)
    }
    return ids
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
   * @param options - `reloadBundles` re-reads the profile manifest first, so a
   * bundle enabled or installed since boot joins the stack.
   * @throws when the root include is not mounted, or the Loader rejected the update.
   */
  async recompose(options: { reloadBundles?: boolean } = {}): Promise<void> {
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
