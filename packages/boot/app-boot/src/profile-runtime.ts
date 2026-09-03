/**
 * The `profileRuntime` service: the booted profile's facts and the one
 * recomposition entry point every live change to the host tree goes through —
 * user patch-file reloads, bundle enable/disable, and hot install. Before
 * this service the composition closure lived in the launcher and bundle
 * layers were frozen at boot, so nothing in the tree could learn which
 * profile it ran in or add a layer while running.
 * @module @deepseek-ai/dsh-app-boot/profile-runtime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type Include from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { composeExternalLayer, isJsDisabled } from './external-bundles.ts'
import type { BundleTrust, Profile, ProfileLayer, ProfilePatchReload } from './profile.ts'

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
  /** For an external row: the id the bundle's own patch declared, before prefixing. */
  readonly originalId?: string
}

/** What the launcher hands the service. */
export interface ProfileRuntimeOptions {
  /** The profile as booted. */
  profile: Profile
  /** Re-read the profile from disk, re-resolving its bundle layers. */
  loadProfile: () => Profile
  /** The complete patch stack for a profile: bundle layers, user layers, overlays. */
  compose: (profile: Profile) => PatchOptions[]
  /** The root Include entry, once mounted. */
  rootEntry: () => Entry | undefined
  /** The user patch layers as they stand on disk (profile file, then home file). */
  readUserPatches: () => PatchOptions[]
}

/** Collect every id a patch list inserts, recursing into inserted groups. */
function insertedIds(patches: readonly PatchOptions[], into: Set<string>): void {
  const visit = (row: EntryOptions): void => {
    if (typeof row.id === 'string') into.add(row.id)
    if (row.group && Array.isArray(row.config)) (row.config as EntryOptions[]).forEach(visit)
  }
  for (const patch of patches) patch.insert?.forEach(visit)
}

/** Facts and recomposition of the booted profile. */
export class ProfileRuntime extends Service {
  private profile: Profile
  private origins: Map<string, RowOrigin> | undefined

  constructor(ctx: Context, private readonly options: ProfileRuntimeOptions) {
    super(ctx, 'profileRuntime')
    this.profile = options.profile
  }

  /** The profile as currently composed; re-read by a `recompose({ reloadBundles: true })`. */
  get current(): Profile {
    return this.profile
  }

  /** The profile name (`dsh --profile <name>`). */
  get profileName(): string {
    return this.profile.name
  }

  /** Absolute profile directory. */
  get dir(): string {
    return this.profile.dir
  }

  /** Absolute path of the profile's own user patch file. */
  get patchPath(): string {
    return this.profile.patchPath
  }

  /** Whether user patch files reload while the profile runs. */
  get patchReload(): ProfilePatchReload {
    return this.profile.patchReload
  }

  /** The bundle layers currently composed, in application order. */
  get layers(): readonly ProfileLayer[] {
    return this.profile.layers
  }

  /**
   * Where one mounted row came from.
   * @param rowId - the row's tree-wide id.
   * @returns the origin, or undefined for a row no bundle layer inserted (a user or overlay row).
   */
  originOf(rowId: string): RowOrigin | undefined {
    this.origins ??= this.computeOrigins()
    return this.origins.get(rowId)
  }

  /**
   * Row ids the user patch layers disable with a literal `disabled: true`.
   * A `!!js` gate in a user file is a condition, not a user decision, and is
   * left to the composition.
   * @returns the ids, re-read from disk on every call.
   */
  userDisabledRowIds(): Set<string> {
    const ids = new Set<string>()
    for (const patch of this.options.readUserPatches()) {
      if (patch.insert !== undefined || patch.id === undefined) continue
      if (patch.disabled === true && !isJsDisabled(patch.disabled)) ids.add(patch.id)
    }
    return ids
  }

  /**
   * Recompose the host tree from the profile's layers and the user patch files
   * as they stand now. The root Include re-applies the stack transactionally:
   * a row whose options changed is updated in place, a row that appeared is
   * created, a row that vanished is disposed, and a failure rolls the whole
   * update back with the previous tree still running.
   * @param options - `reloadBundles` re-reads the profile manifest first, so a
   * bundle enabled or installed since boot joins the stack.
   * @throws when the root include is not mounted, or the Loader rejected the update.
   */
  async recompose(options: { reloadBundles?: boolean } = {}): Promise<void> {
    const entry = this.options.rootEntry()
    if (entry === undefined) throw new Error('profileRuntime: the root include is not mounted')
    if (options.reloadBundles === true) {
      this.profile = this.options.loadProfile()
      this.origins = undefined
    }
    const { patches: _previousPatches, ...includeConfig } = entry.options.config as Include.Config
    await entry.update({
      config: {
        ...includeConfig,
        patches: this.options.compose(this.profile),
      },
    })
  }

  private computeOrigins(): Map<string, RowOrigin> {
    const origins = new Map<string, RowOrigin>()
    for (const layer of this.profile.layers) {
      const base = { trust: layer.trust, packageName: layer.packageName, ...layer.version === undefined ? {} : { version: layer.version } }
      if (layer.trust === 'external' && layer.stage === 'runtime') {
        for (const [id, origin] of composeExternalLayer(layer).rows) {
          origins.set(id, { ...base, originalId: origin.originalId })
        }
        continue
      }
      const ids = new Set<string>()
      insertedIds(layer.patches, ids)
      for (const id of ids) origins.set(id, base)
    }
    return origins
  }
}
