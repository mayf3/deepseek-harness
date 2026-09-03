/**
 * The configurable tab's scope switch: the global instance, or one agent
 * preset's named scope. The options come from the preset roster when the
 * deployment composes one, plus any named scope the settings document
 * already holds a section for — a scope whose preset was deleted still
 * shows, under its raw id, so its section is never hidden.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ScopeSelection } from './scoped-form.ts'

/** Scope id prefix the agent-preset roster names its standing scopes with. */
export const PRESET_SCOPE_PREFIX = 'preset/'

/** One roster preset as the switch lists it. */
export interface PresetScopeRow {
  /** The preset id; its scope is `preset/<id>`. */
  readonly id: string
  /** Shipped or locally authored, which decides how its name resolves. */
  readonly trust: 'system' | 'user'
  /** Locally authored display name, when the preset declares one. */
  readonly name?: string
  /** Whether a session that names no preset is composed from it. */
  readonly isDefault: boolean
  /** Why discovery could not load the preset, when it could not. */
  readonly broken?: string
}

/** What the switch renders. */
export interface ScopeSwitcherState {
  /** The selected scope; undefined for the global instance. */
  scope: string | undefined
  /** Roster presets, in roster order. */
  presets: readonly PresetScopeRow[]
  /** Named scopes the document holds that no roster preset owns, as raw ids. */
  extraScopes: readonly string[]
  /** Roster request state; `idle` until the tab first renders. */
  status: 'idle' | 'loading' | 'ready' | 'error'
}

/** The registration-side face the tab injects for its switch. */
export interface ScopeSwitcherFace {
  hooks: {
    /** Switch snapshot bound by the renderer as useScopeSwitcher. */
    scopeSwitcher: SnapshotStore<ScopeSwitcherState>
  }
  /** Select the scope every card edits; null selects the global instance. */
  selectScope: (scope: string | null) => void
  /** Read the roster the first time the tab renders, and retry after a failure. */
  ensureScopes: () => void
  /** Display name for one roster preset, resolved through the agent-preset dictionaries. */
  presetName: (preset: PresetScopeRow) => string
}

/** Answers the roster, when the deployment composes one; undefined when the Host refused it. */
export type RosterReader = () => Promise<readonly PresetScopeRow[] | undefined>

/** Derives the switch options from the roster and the global describe answer. */
export class ScopeSwitcherController {
  private readonly store: SnapshotStore<ScopeSwitcherState>
  private presets: readonly PresetScopeRow[] = []
  private status: ScopeSwitcherState['status'] = 'idle'
  private generation = 0
  private disposed = false
  private readonly disposers: Array<() => void>

  /**
   * @param selection - the scope selection shared with every card.
   * @param describeFace - the global describe face, whose `scopes` names the document's sections.
   * @param roster - reads the preset roster; undefined when the deployment composes none.
   * @param presetName - display name for one roster preset.
   */
  constructor(
    private readonly selection: ScopeSelection,
    private readonly describeFace: SettingsDescribeFace,
    private readonly roster: RosterReader | undefined,
    private readonly presetName: (preset: PresetScopeRow) => string,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.disposers = [
      selection.subscribe(() => { this.publish() }),
      describeFace.subscribe(() => { this.publish() }),
    ]
  }

  /** Stop following the selection and the mirror, and drop late roster answers. */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    for (const dispose of this.disposers) dispose()
  }

  /**
   * Re-read the roster after a (re)connect: the Host behind the page may differ.
   */
  reset(): void {
    if (this.disposed) return
    this.generation += 1
    this.status = 'idle'
    this.presets = []
    this.publish()
  }

  /**
   * Build the face the tab's slot registration injects.
   * @returns the switch snapshot and its actions.
   */
  inject(): ScopeSwitcherFace {
    return {
      hooks: { scopeSwitcher: this.store },
      selectScope: (scope) => { this.selection.select(scope ?? undefined) },
      ensureScopes: () => { void this.load() },
      presetName: this.presetName,
    }
  }

  /**
   * Read the roster once from `idle` or `error`; a read in flight or a held
   * answer is kept.
   * @returns settlement after the answer is published.
   */
  async load(): Promise<void> {
    if (this.disposed || this.status === 'loading' || this.status === 'ready') return
    if (this.roster === undefined) {
      this.status = 'ready'
      this.publish()
      return
    }
    const generation = ++this.generation
    this.status = 'loading'
    this.publish()
    const presets = await this.roster()
    // Disposal and reset both advance the generation, which is the one
    // liveness check a settled read needs.
    if (generation !== this.generation) return
    if (presets === undefined) {
      this.status = 'error'
    } else {
      this.presets = presets
      this.status = 'ready'
    }
    this.publish()
  }

  private projection(): ScopeSwitcherState {
    const owned = new Set(this.presets.map(preset => `${PRESET_SCOPE_PREFIX}${preset.id}`))
    const described = this.describeFace.getSnapshot().view?.scopes ?? []
    return {
      scope: this.selection.current(),
      presets: this.presets,
      extraScopes: described.filter(scope => !owned.has(scope)),
      status: this.status,
    }
  }

  private publish(): void {
    const next = this.projection()
    const previous = this.store.getSnapshot()
    // Every settings commit refreshes the mirror; keep the reference until a
    // fact moves (packages/client/AGENTS.md reactive rule 5).
    if (previous.scope === next.scope && previous.status === next.status
      && previous.presets === next.presets
      && previous.extraScopes.length === next.extraScopes.length
      && previous.extraScopes.every((scope, index) => scope === next.extraScopes[index])) return
    this.store.set(next)
  }
}
