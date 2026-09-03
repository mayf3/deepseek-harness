/**
 * Structured composition reads for plugin-listing surfaces: the plugin rows
 * each preset names, with each row's effective enablement. A preset with a
 * live standing mount answers from that mount's Loader entries — evaluated
 * `disabled`, real root-fiber states; a preset no session has composed since
 * boot answers from its composition file, with `!!js` disabled expressions
 * evaluated through the caller-supplied Loader evaluator so the file answer
 * matches the decision a mount on this host would make. A row whose
 * expression the evaluator refuses stays `'conditional'`. Either way the
 * preset's user patch layer is accounted for: a row the layer inserted reads
 * `source: 'user'`, and a row it switched off with a literal `disabled: true`
 * reads `disabledBy: 'user'`.
 * @module @deepseek-ai/dsh-agent-presets/composition-inventory
 */

import { readFile } from 'node:fs/promises'
import { load } from 'js-yaml'
import type { FiberState } from '@deepseek-ai/cordis'
import { isJsExpr, type EntryOptions, type EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { entryListProblem } from './discovery.ts'
import type { PresetTrust } from './preset.ts'

/**
 * Effective enablement of one composition row: a literal or evaluated
 * boolean, or `'conditional'` when a `!!js` disabled expression could not be
 * evaluated outside a mount.
 */
export type CompositionRowEnablement = boolean | 'conditional'

/**
 * Evaluate one `!!js` disabled expression the way the Loader would at a mount
 * decision. Throwing refuses the answer: the row is reported `'conditional'`
 * rather than guessed.
 */
export type DisabledExpressionEvaluator = (expression: string) => unknown

/** Who put a row into a preset's composition: its file, or the user patch layer over it. */
export type CompositionRowSource = 'preset' | 'user'

/** Why a row is off: the composition's own gate, or the user patch layer's literal `disabled: true`. */
export type CompositionRowDisabledBy = 'composition' | 'user'

/** One plugin row a preset composition names. */
export interface AgentPresetCompositionRow {
  /**
   * The Loader-tree entry id when read from a live mount, else the id the
   * composition file declares; null when the file row declares none.
   */
  readonly entryId: string | null
  /** Module specifier the row names. */
  readonly moduleName: string
  /** Effective enablement, including disabled ancestor groups. */
  readonly enabled: CompositionRowEnablement
  /** The row's own `!!js` disabled expression, when it carries one. */
  readonly condition?: string
  /** Root-fiber state, present only when read from a live mount. */
  readonly fiberState?: FiberState
  /** Whether the composition file or the user patch layer supplied the row. */
  readonly source: CompositionRowSource
  /** Present exactly when `enabled` is false. */
  readonly disabledBy?: CompositionRowDisabledBy
}

/** What a user patch layer decided about a composition's rows, by row id. */
export interface OverlayFacts {
  /** Ids of rows the layer inserted, including rows inside inserted groups. */
  readonly inserted: ReadonlySet<string>
  /** Ids of rows the layer switched off with a literal `disabled: true`. */
  readonly disabled: ReadonlySet<string>
}

/**
 * Read one user patch layer's decisions by row id. A `!!js` gate in the layer
 * is a condition, not a user decision, and is left to the composition.
 * @param patches - the layer's patch list, parsed; empty when the preset has none.
 * @returns the inserted and user-disabled row ids.
 */
export function overlayFacts(patches: readonly PatchOptions[]): OverlayFacts {
  const inserted = new Set<string>()
  const disabled = new Set<string>()
  const visit = (row: EntryOptions): void => {
    if (typeof row.id === 'string') inserted.add(row.id)
    if (row.group && Array.isArray(row.config)) (row.config as EntryOptions[]).forEach(visit)
  }
  for (const patch of patches) {
    if (patch.insert !== undefined) {
      patch.insert.forEach(visit)
      continue
    }
    if (typeof patch.id === 'string' && patch.disabled === true) disabled.add(patch.id)
  }
  return { inserted, disabled }
}

/** The empty layer: nothing inserted, nothing switched off. */
const NO_OVERLAY: OverlayFacts = { inserted: new Set(), disabled: new Set() }

/** One preset's roster identity beside its composition rows. */
export interface AgentPresetComposition {
  /** Stable preset id. */
  readonly id: string
  /** Whether the deployment ships the preset or the user owns it. */
  readonly trust: PresetTrust
  /** Display name the preset published. */
  readonly name?: string
  /** Whether a session naming no preset composes this one. */
  readonly isDefault: boolean
  /** Why this preset's rows cannot be read; absent when {@link rows} answers. */
  readonly broken?: string
  /** Composition rows in composition order; empty when the preset is broken. */
  readonly rows: readonly AgentPresetCompositionRow[]
}

/**
 * One `disabled` node's contribution to effective enablement, mirroring the
 * Loader's own reading: a `!!js` expression is asked of the evaluator — a
 * refusal (throw) leaves the decision to a mount — and anything else disables
 * exactly when `Boolean(value)` does.
 * @param value - the raw `disabled` node of one composition row.
 * @param evaluateExpression - the Loader-context evaluator for `!!js` nodes.
 * @returns true (disabled), false (enabled), or `'conditional'`.
 */
function disabledContribution(
  value: unknown,
  evaluateExpression: DisabledExpressionEvaluator,
): boolean | 'conditional' {
  if (isJsExpr(value)) {
    try {
      return Boolean(evaluateExpression(value.__jsExpr))
    } catch {
      // The evaluator refused (a malformed or context-dependent expression);
      // only a real mount decision can answer, so the row stays conditional.
      return 'conditional'
    }
  }
  return Boolean(value)
}

/**
 * Combine an ancestor group's disabled state with a row's own, the way the
 * Loader walks owning groups: any literal true disables, otherwise any
 * expression leaves the decision to a mount.
 * @param outer - the combined ancestor contribution.
 * @param own - this row's contribution.
 * @returns the row's effective disabled state.
 */
function combineDisabled(
  outer: boolean | 'conditional',
  own: boolean | 'conditional',
): boolean | 'conditional' {
  if (outer === true || own === true) return true
  if (outer === 'conditional' || own === 'conditional') return 'conditional'
  return false
}

/** A parsed composition row after {@link entryListProblem} accepted the list. */
interface RawRow {
  readonly id?: unknown
  readonly name: string
  readonly group?: unknown
  readonly config?: unknown
  readonly disabled?: unknown
}

/**
 * Flatten one parsed row list into plugin rows. Group rows are structural —
 * the Loader reports a group entry as always enabled and lets children
 * inherit its `disabled` — so only their children are emitted.
 * @param rows - the parsed rows, shape-checked by the caller.
 * @param outerDisabled - the combined ancestor-group disabled state.
 * @param evaluateExpression - the Loader-context evaluator for `!!js` nodes.
 * @param found - the accumulator receiving flattened rows.
 */
function flattenRows(
  rows: readonly unknown[],
  outerDisabled: boolean | 'conditional',
  evaluateExpression: DisabledExpressionEvaluator,
  overlay: OverlayFacts,
  found: AgentPresetCompositionRow[],
): void {
  for (const value of rows) {
    const row = value as RawRow
    const disabled = combineDisabled(outerDisabled, disabledContribution(row.disabled, evaluateExpression))
    if (row.group === true) {
      flattenRows(row.config as readonly unknown[], disabled, evaluateExpression, overlay, found)
      continue
    }
    const id = typeof row.id === 'string' && row.id !== '' ? row.id : null
    found.push({
      entryId: id,
      moduleName: row.name,
      enabled: disabled === true ? false : disabled === 'conditional' ? 'conditional' : true,
      ...isJsExpr(row.disabled) ? { condition: row.disabled.__jsExpr } : {},
      ...rowProvenance(id, disabled === true, overlay),
    })
  }
}

/** The `source` and `disabledBy` fields of one row, from the layer's decisions. */
function rowProvenance(
  id: string | null, disabled: boolean, overlay: OverlayFacts,
): Pick<AgentPresetCompositionRow, 'source' | 'disabledBy'> {
  const userRow = id !== null && overlay.inserted.has(id)
  return {
    source: userRow ? 'user' : 'preset',
    ...disabled ? { disabledBy: id !== null && overlay.disabled.has(id) ? 'user' as const : 'composition' as const } : {},
  }
}

/**
 * Plugin rows of one composition file, for a preset with no live mount.
 *
 * Parsed with the Loader's own dialect ({@link entryListSchema}), so the rows
 * reported are the rows a mount would start from, with the user patch layer
 * applied through the include's own patch algorithm. A file that stopped
 * reading as a composition — discovery judged the preset healthy moments
 * earlier, so only an edit racing this read gets here — answers as broken
 * with the raced reason rather than dropping the rows silently.
 * @param path - absolute path of the composition file.
 * @param evaluateExpression - the Loader-context evaluator for `!!js` nodes.
 * @param overlay - the preset's user patch layer, parsed; empty when it has none.
 * @returns flattened rows in composition order, or why they cannot be read.
 */
export async function fileComposition(
  path: string,
  evaluateExpression: DisabledExpressionEvaluator,
  overlay: readonly PatchOptions[] = [],
): Promise<{ rows: AgentPresetCompositionRow[] } | { broken: string }> {
  let rows: unknown
  try {
    rows = load(await readFile(path, 'utf8'), { schema: entryListSchema })
  } catch (error) {
    /* v8 ignore next -- fs and js-yaml throw Errors for every failure here; the fallback keeps a hostile value readable */
    return { broken: error instanceof Error ? error.message : String(error) }
  }
  const problem = entryListProblem(rows)
  if (problem !== undefined) return { broken: problem }
  // Silent: a patch that matches no row is the Loader's warning at mount
  // time, not an inventory failure.
  const composed = applyEntryPatches(rows as EntryOptions[], [...overlay], () => {})
  const found: AgentPresetCompositionRow[] = []
  flattenRows(composed, false, evaluateExpression, overlay.length === 0 ? NO_OVERLAY : overlayFacts(overlay), found)
  return { rows: found }
}

/**
 * Plugin rows of one live standing composition, in Loader-entry order.
 * @param tree - the standing mount's entry tree.
 * @param overlay - the preset's user patch layer, parsed; empty when it has none.
 * @returns rows with the Loader's evaluated enablement and root-fiber states.
 */
export function mountedCompositionRows(tree: EntryTree, overlay: readonly PatchOptions[] = []): AgentPresetCompositionRow[] {
  const facts = overlay.length === 0 ? NO_OVERLAY : overlayFacts(overlay)
  const found: AgentPresetCompositionRow[] = []
  for (const entry of tree.entries()) {
    if (entry.options.group) continue
    found.push({
      entryId: entry.id,
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      ...isJsExpr(entry.options.disabled) ? { condition: entry.options.disabled.__jsExpr } : {},
      ...entry.fiber === undefined ? {} : { fiberState: entry.fiber.state },
      // Provenance and user patches address rows by the id the composition
      // declares; the tree-wide `entry.id` carries the include's prefix.
      ...rowProvenance(entry.options.id, entry.disabled, facts),
    })
  }
  return found
}
