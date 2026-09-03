/**
 * The contained group: a Loader group whose rows fail individually instead of
 * failing the group. The vendored `EntryGroup.update` is all-or-nothing — one
 * rejected row rolls the whole group back and rethrows, which at boot unwinds
 * the whole tree. External bundles mount under this group so their startup
 * failures are recorded and reported rather than fatal, while built-in rows
 * keep the fatal path.
 * @module @deepseek-ai/dsh-app-boot/contained-group
 */

import type { Context } from '@deepseek-ai/cordis'
import { Group, type Entry, type EntryGroup, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'

/** The lifecycle step at which a contained row failed. */
export type ContainedFailureStage = 'import' | 'apply' | 'inject-pending' | 'unknown'

/** One recorded failure of a row inside a contained group. */
export interface ContainedFailure {
  /** The row's tree-wide id, as `Entry.id` spells it (`include:<row id>` under the root include). */
  readonly entryId: string
  /** The row id as the composition declares it — the key patches and provenance use. */
  readonly rowId: string
  /** The module specifier the row named. */
  readonly moduleName: string
  /** The contained group the row belongs to. */
  readonly groupId: string
  /** Which lifecycle step failed. */
  readonly stage: ContainedFailureStage
  /** The failure text, with the Loader's per-row wrapper folded in. */
  readonly message: string
}

/**
 * Failures recorded by contained groups of one runtime. Rows are keyed by
 * their tree-wide id; recording a row again replaces its earlier record, and a
 * row that later mounts clears it.
 */
export class ContainedFailureRegistry {
  private readonly failures = new Map<string, ContainedFailure>()

  /**
   * Record one failure, replacing an earlier record of the same row.
   * @param failure - the failure to record.
   */
  record(failure: ContainedFailure): void {
    this.failures.set(failure.entryId, failure)
  }

  /**
   * Forget one row's failure, for a row that mounted on a later attempt.
   * @param entryId - the row's tree-wide id.
   */
  clear(entryId: string): void {
    this.failures.delete(entryId)
  }

  /**
   * Every recorded failure in record order.
   * @returns the failures.
   */
  list(): ContainedFailure[] {
    return [...this.failures.values()]
  }

  /**
   * One row's failure.
   * @param entryId - the row's tree-wide id.
   * @returns the record, or undefined when the row is not failed.
   */
  get(entryId: string): ContainedFailure | undefined {
    return this.failures.get(entryId)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Failures recorded by contained groups; provided on the root by the boot glue. */
    pluginFailures?: ContainedFailureRegistry
  }
}

/**
 * Parse the Loader's `failed to <stage> loader entry` wrapper into a stage.
 * Every row failure reaches {@link ContainedGroup.create} through that
 * wrapper, so `unknown` is the guard for a message shape this build has not
 * seen rather than a path a row can take.
 */
function stageOf(message: string): ContainedFailureStage {
  const match = /^failed to (import|apply) loader entry /.exec(message)
  /* v8 ignore next -- the Loader wraps every row failure with one of the two stages, so the `unknown` arm is unreachable */
  return match === null ? 'unknown' : match[1] === 'import' ? 'import' : 'apply'
}

/**
 * A group that contains its rows' startup failures. `create()` is the one
 * per-row step `EntryGroup.update` awaits, so catching there is what turns a
 * row failure from a group rejection into a record: the group activates, the
 * failed row is absent from the tree, and the record names it.
 */
export class ContainedGroup extends Group {
  override async create(options: Omit<EntryOptions, 'id'>): Promise<string> {
    try {
      const id = await super.create(options)
      this.registry()?.clear(id)
      return id
    } catch (error) {
      const registry = this.registry()
      // `ensureId` assigned the id before the row started, so a failed row
      // still carries the id the tree would have used.
      const rowId = (options as EntryOptions).id
      // The same spelling `Entry.id` gives a live row: prefixed with the
      // owning include's id when this tree is an included one.
      const treeOwner = this.tree.ctx.fiber.entry
      const entryId = treeOwner === undefined ? rowId : `${treeOwner.id}:${rowId}`
      /* v8 ignore next -- the Loader wraps a row's thrown value in an Error before it reaches here */
      const message = error instanceof Error ? error.message : String(error)
      registry?.record({
        entryId,
        rowId,
        moduleName: options.name,
        groupId: this.groupId(),
        stage: stageOf(message),
        message,
      })
      this.ctx.logger.warn(`contained group ${this.groupId()}: row ${rowId} failed and was isolated: ${message}`)
      return rowId
    }
  }

  /** The registry provided on the runtime root, if the boot glue provided one. */
  private registry(): ContainedFailureRegistry | undefined {
    return this.ctx.get('pluginFailures')
  }

  /** This group's own entry id, as the tree names it. */
  private groupId(): string {
    /* v8 ignore next -- a group always runs as a Loader entry; the fallback keeps a direct `ctx.plugin(ContainedGroup)` readable */
    return this.ctx.fiber.entry?.id ?? '(unknown group)'
  }
}

/**
 * Whether an entry sits inside a contained group, at any depth.
 * @param entry - the Loader entry to classify.
 * @returns true when some owning group is a {@link ContainedGroup}.
 */
export function isContainedEntry(entry: Entry): boolean {
  let group: EntryGroup | undefined = entry.parent
  while (group !== undefined) {
    if (group instanceof ContainedGroup) return true
    group = group.ctx.fiber.entry?.parent
  }
  return false
}

/**
 * The contained failure registry of a runtime, creating and providing one on
 * the root the first time it is asked for.
 * @param ctx - any context of the runtime.
 * @returns the registry.
 */
export function ensurePluginFailures(ctx: Context): ContainedFailureRegistry {
  const existing = ctx.get('pluginFailures')
  if (existing !== undefined) return existing
  const registry = new ContainedFailureRegistry()
  ctx.root.provide('pluginFailures', registry)
  return registry
}
