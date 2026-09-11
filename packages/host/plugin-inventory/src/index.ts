/** Read-only projection of the current Cordis Loader plugin entries. */

import type { Context, FiberState } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
// Type-only: the optional agent-preset roster resolved through `ctx.get`.
import type {} from '@deepseek-ai/dsh-agent-presets'
// Profile provenance and live entry diagnostics share the boot implementation.
import { inspectEntryIssues } from '@deepseek-ai/dsh-app-boot'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import type {
  AgentPresetPluginGroup,
  PluginEntryId,
  PluginFiberPhase,
  PluginInventoryEntry,
  PluginInventorySnapshot,
  PluginPackageRef,
} from './types.ts'

export type * from './types.ts'

/** Brand an existing Loader-tree entry id at the owning boundary. */
function pluginEntryId(value: string): PluginEntryId {
  return value as PluginEntryId
}

/** The wire view of a row's package origin. */
function packageRef(origin: { packageName: string; version?: string }): PluginPackageRef {
  return {
    name: origin.packageName,
    ...origin.version === undefined ? {} : { version: origin.version },
  }
}

/** Runtime mirror: FiberState is a cross-package const enum. */
const FIBER_STATE = {
  PENDING: 0 as FiberState.PENDING,
  LOADING: 1 as FiberState.LOADING,
  ACTIVE: 2 as FiberState.ACTIVE,
  FAILED: 3 as FiberState.FAILED,
  DISPOSED: 4 as FiberState.DISPOSED,
  UNLOADING: 5 as FiberState.UNLOADING,
} as const

/** Complete public projection of Cordis Fiber states. */
const FIBER_PHASE = {
  [FIBER_STATE.PENDING]: 'pending',
  [FIBER_STATE.LOADING]: 'loading',
  [FIBER_STATE.ACTIVE]: 'active',
  [FIBER_STATE.FAILED]: 'failed',
  [FIBER_STATE.DISPOSED]: null,
  [FIBER_STATE.UNLOADING]: 'unloading',
} as const satisfies Record<FiberState, PluginFiberPhase>

/** Remote-only service exposing the Loader's current non-group entry state. */
export class PluginInventoryGateway extends TypertRemoteService {
  static inject = ['loader']

  constructor(ctx: Context) {
    super(ctx, 'pluginInventory')
  }

  /**
   * Read the Loader directly on every call. Cordis's internal plugin/status
   * events already maintain Entry.fiber and Fiber.state, so a second cache
   * would only add another lifecycle truth to keep synchronized.
   *
   * When an agent-preset roster is composed, the snapshot also carries each
   * preset's composition rows, because those rows — not the Loader's own
   * entries — are where a deployment that mounts the roster runs its
   * model-facing plugins.
   * @returns Current non-group Loader entries in Loader order, with per-preset
   * compositions when a roster is composed.
   */
  @Remote('list')
  async list(): Promise<PluginInventorySnapshot> {
    const entries: PluginInventoryEntry[] = []
    const runtime = this.ctx.get('profileRuntime')
    const failures = new Map((await inspectEntryIssues(this.ctx)).map(issue => [issue.entry, issue]))
    for (const entry of this.ctx.loader.entries()) {
      if (entry.options.group) continue
      // Provenance and user patches address rows by the id the composition
      // declares; the tree-wide `entry.id` adds the owning include's prefix.
      const origin = runtime?.originOfEntry(entry)
      const failure = failures.get(entry)
      const enabled = failure?.stage === 'disabled-expression' || !entry.disabled
      entries.push({
        entryId: pluginEntryId(entry.id),
        moduleName: entry.options.name,
        enabled,
        fiberPhase: entry.fiber === undefined ? (failure === undefined ? null : 'failed') : FIBER_PHASE[entry.fiber.state],
        trust: origin?.trust ?? 'builtin',
        ...origin === undefined ? {} : { package: packageRef(origin) },
        ...enabled ? {} : { disabledBy: runtime?.userDisables(entry) === true ? 'user' as const : 'composition' as const },
        ...failure === undefined ? {} : { failure: { stage: failure.stage, message: failure.message } },
      })
    }
    // A row the composition left out never reached the tree; the conflict
    // names the layer that lost, so no lookup of the id's owner is needed.
    if (runtime !== undefined) {
      for (const conflict of runtime.conflicts) {
        const version = runtime.layers.find(candidate => candidate.packageName === conflict.packageName)?.version
        entries.push({
          entryId: pluginEntryId(`conflict:${conflict.layer}:${conflict.rowId}`),
          moduleName: conflict.moduleName,
          enabled: true,
          fiberPhase: 'failed',
          trust: conflict.packageName === undefined ? 'user' : 'external',
          ...conflict.packageName === undefined
            ? {}
            : { package: packageRef({ packageName: conflict.packageName, ...version === undefined ? {} : { version } }) },
          failure: { stage: 'conflict', message: conflict.message },
        })
      }
    }
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return { entries }
    const agentPresets: AgentPresetPluginGroup[] = (await presets.compositionInventory()).map(
      composition => ({
        ...composition,
        rows: composition.rows.map(({ fiberState, ...row }) => ({
          ...row,
          fiberPhase: fiberState === undefined ? null : FIBER_PHASE[fiberState],
        })),
      }),
    )
    return { entries, agentPresets }
  }
}

export default PluginInventoryGateway
