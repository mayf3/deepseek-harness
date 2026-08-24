/** Direct preference controller for model-selectable subagent delegation. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'

/** Namespace of the Host-owned subagent model-selection preference. */
export const SUBAGENT_MODEL_SELECTION_NS = 'subagent-model-selection'

/** Settings fields stored for subagent model selection. */
export interface SubagentModelSelectionSettings {
  /** Whether new top-level Sessions may expose child model selection. */
  enabled?: boolean
}

/** State rendered by the direct preference card. */
export interface SubagentModelSelectionCardState {
  /** Whether the Host serves this namespace. */
  available: boolean
  /** Whether the settings document accepts writes. */
  writable: boolean
  /** Effective preference; absent values resolve off. */
  enabled: boolean
  /** Whether one switch write is crossing the wire. */
  saving: boolean
  /** Whether the latest write landed. */
  saved: boolean
  /** Whether the latest write settled without changing the Host value. */
  failed: boolean
}

/** Registration-side face for the subagent model-selection card. */
export interface SubagentModelSelectionCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useSubagentModelSelectionCard. */
    subagentModelSelectionCard: SnapshotStore<SubagentModelSelectionCardState>
  }
  /** Flip and immediately persist the preference. */
  toggle: () => void
}

/** Bridges the settings scope onto one immediate-save switch. */
export class SubagentModelSelectionCardController {
  private saving = false
  private saved = false
  private failed = false
  private disposed = false
  private generation = 0
  private readonly store: SnapshotStore<SubagentModelSelectionCardState>
  private readonly unsubscribe: () => void

  /** @param scope - the bound `subagent-model-selection` settings scope. */
  constructor(private readonly scope: SettingsScope<SubagentModelSelectionSettings>) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => { this.publish() })
  }

  /** Stop observing the settings scope. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    this.unsubscribe()
  }

  /**
   * Build the face injected into the card slot.
   * @returns the card snapshot and its direct toggle action.
   */
  inject(): SubagentModelSelectionCardFace {
    return {
      hooks: { subagentModelSelectionCard: this.store },
      toggle: () => { void this.toggle() },
    }
  }

  private async toggle(): Promise<void> {
    const current = this.scope.getSnapshot()
    if (this.disposed || current.status !== 'ready' || !current.writable || this.saving) return
    const desired = current.value?.enabled !== true
    const generation = this.generation
    this.saving = true
    this.saved = false
    this.failed = false
    this.publish()
    await this.scope.set('enabled', desired)
    if (generation !== this.generation) return
    const landed = this.scope.getSnapshot().value?.enabled === desired
    this.saving = false
    this.saved = landed
    this.failed = !landed
    this.publish()
  }

  private projection(): SubagentModelSelectionCardState {
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      enabled: snapshot.value?.enabled === true,
      saving: this.saving,
      saved: this.saved,
      failed: this.failed,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
