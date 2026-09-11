/** Serialized profile recomposition with declared provenance and observed per-entry outcomes. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type Include from '@deepseek-ai/cordis-plugin-include'
import type { BundleStage, ProfilePatchReload } from '@deepseek-ai/dsh-package-manifest'
import type { ComposedStack, RowConflict } from './compose-stack.ts'
import type { BundleTrust, Profile, ProfileLayer } from './profile.ts'
import { inspectEntryIssues, type EntryIssue } from './entry-issues.ts'

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
  /** Effective startup-failure policy of the supplying bundle. */
  readonly stage: BundleStage
  /** The bundle package that inserted the row. */
  readonly packageName: string
  /** The package's version, when its manifest declares one. */
  readonly version?: string
}

/** What the launcher hands the service. */
export interface ProfileRuntimeOptions {
  /** The profile as booted. */
  profile: Profile
  /** Absolute path of the dsh app's package.json: the first resolution anchor for profile packages. */
  installAnchor: string
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
  static inject = ['loader']

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

  /** Absolute path of the dsh app's package.json, the anchor profile packages resolve from. */
  get installAnchor(): string {
    return this.options.installAnchor
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
      stage: layer.stage,
      packageName: layer.packageName,
      ...layer.version === undefined ? {} : { version: layer.version },
    }
  }

  /**
   * Resolve provenance within its Loader tree; nested includes inherit their owning entry.
   * @param entry - the live entry, including an entry inside another Include.
   * @returns its supplying bundle, or undefined for a user-owned entry.
   */
  originOfEntry(entry: Entry): RowOrigin | undefined {
    const rootTree = this.options.rootEntry()?.subtree
    let current: Entry | undefined = entry
    while (current !== undefined) {
      if (current.parent.tree === rootTree) return this.originOf(current.options.id)
      current = current.parent.tree.ctx.fiber.entry
    }
    return undefined
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
   * Apply a fresh profile stack and wait for live entries and removed fibers to settle.
   * Parse/composition failures leave the applied stack unchanged. Accepted options
   * can coexist with failed entries or fibers running their previous valid config.
   * Calls serialize; a failed call does not block later changes.
   * @param options - whether to reread installed bundle layers from disk.
   * @returns current entry issues after application, without rolling back successful siblings.
   * @throws when preparation fails or the root Include cannot accept the update.
   */
  async recompose(options: { reloadBundles?: boolean } = {}): Promise<readonly EntryIssue[]> {
    const run = this.queue.then(() => this.recomposeNow(options))
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  private async recomposeNow(options: { reloadBundles?: boolean }): Promise<readonly EntryIssue[]> {
    const entry = this.options.rootEntry()
    if (entry === undefined) throw new Error('profileRuntime: the root include is not mounted')
    const profile = options.reloadBundles === true ? this.options.loadProfile() : this.committed.profile
    const stack = this.options.compose(profile)
    const { patches: _previousPatches, ...includeConfig } = entry.options.config as Include.Config
    const before = [...this.ctx.loader.entries()].flatMap(row => row.fiber === undefined ? [] : [row.fiber])
    await entry.update({
      config: {
        ...includeConfig,
        patches: structuredClone(stack.patches),
      },
    })
    await this.ctx.loader.await()
    const current = new Set([...this.ctx.loader.entries()].map(row => row.fiber))
    // Removed entries are absent from Loader.getTasks(), but still own teardown.
    await Promise.allSettled(before.filter(fiber => fiber.uid === null || !current.has(fiber)).map(fiber => fiber.await()))
    await this.ctx.loader.await()
    this.committed = { profile, stack }
    return inspectEntryIssues(this.ctx)
  }

  /**
   * Wait for recompositions already queued when called, including removed-fiber cleanup.
   * Observers may read accepted composition facts afterwards; a failed operation
   * still reports its error to its caller and does not reject this observation.
   * @returns after the current recomposition queue settles.
   */
  whenIdle(): Promise<void> {
    return this.queue
  }
}

/** The walk behind {@link ProfileRuntime.userDisables}: the entry, then each group holding it, outward. */
function userDisablesEntry(entry: Entry, userDisabled: ReadonlySet<string>): boolean {
  for (let current: Entry | undefined = entry; current !== undefined; current = current.parent.ctx.fiber.entry) {
    if (typeof current.options.id === 'string' && userDisabled.has(current.options.id)) return true
  }
  return false
}
