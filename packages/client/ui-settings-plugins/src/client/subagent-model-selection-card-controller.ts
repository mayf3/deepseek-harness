/** Staged editor for the Host-owned subagent model allowlist. */

import type {
  IApiClient,
  ModelCatalogFailure,
  ModelProviderGroup,
} from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardShell } from './card-form.ts'

/** Namespace of the Host-owned subagent model-selection preference. */
export const SUBAGENT_MODEL_SELECTION_NS = 'subagent-model-selection'

/** One exact provider/model route stored as user authorization. */
export interface AllowedSubagentModel {
  provider: string
  model: string
}

/** Settings fields stored for subagent model selection. */
export interface SubagentModelSelectionSettings {
  /** Exact child routes offered to newly composed top-level Sessions. */
  allowedModels?: AllowedSubagentModel[]
}

/** One catalog row joined with a stored route that may no longer be advertised. */
export interface SubagentModelCandidate extends AllowedSubagentModel {
  /** Stable opaque identity used only for lookup. */
  key: string
  /** Adapter-owned provider display name. */
  providerName: string
  /** Adapter-owned model display name. */
  modelName: string
  /** Whether the current adapter catalog advertises this exact route. */
  available: boolean
  /** Whether the current draft authorizes this route. */
  selected: boolean
}

/** State rendered by the staged allowlist card. */
export interface SubagentModelSelectionCardState extends CardShell {
  /** Whether the draft enables model-facing child route selection. */
  enabled: boolean
  /** Live catalog joined with stored routes. */
  candidates: readonly SubagentModelCandidate[]
  /** Adapter-directory request state. */
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Provider-local failures that did not block other candidates. */
  catalogFailures: readonly ModelCatalogFailure[]
  /** Whether the latest save landed. */
  saved: boolean
}

/** Registration-side face for the subagent model-selection card. */
export interface SubagentModelSelectionCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useSubagentModelSelectionCard. */
    subagentModelSelectionCard: SnapshotStore<SubagentModelSelectionCardState>
  }
  /** Stage the enabled state; enabling also loads the adapter directory. */
  toggleEnabled: () => void
  /** Stage one exact route as allowed or denied. */
  toggleModel: (key: string) => void
  /** Retry the adapter directory. */
  retryCatalog: () => void
  /** Persist the whole exact route list as one revision-fenced field write. */
  save: () => void
  /** Drop the staged enabled state and route choices. */
  discard: () => void
}

/**
 * Stable identity for one exact route; callers resolve it by lookup and never parse it.
 * @param route - Provider/model route to identify.
 * @returns Opaque key for lookup within the card.
 */
export function subagentModelKey(route: AllowedSubagentModel): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Join live adapter metadata with stored routes that remain removable after disappearance.
 * @param groups - Current model directory grouped by provider.
 * @param stored - Routes in the effective settings value.
 * @param selected - Opaque route keys selected in the current draft.
 * @returns Candidate rows for the card.
 */
export function subagentModelCandidates(
  groups: readonly ModelProviderGroup[],
  stored: readonly AllowedSubagentModel[],
  selected: ReadonlySet<string>,
): SubagentModelCandidate[] {
  const storedByKey = new Map(stored.map(route => [subagentModelKey(route), route]))
  const candidates = groups.flatMap(group => group.models.map((model): SubagentModelCandidate => {
    const route = { provider: group.id, model: model.id }
    const key = subagentModelKey(route)
    storedByKey.delete(key)
    return {
      ...route,
      key,
      providerName: group.name,
      modelName: model.name,
      available: true,
      selected: selected.has(key),
    }
  }))
  for (const route of storedByKey.values()) {
    const key = subagentModelKey(route)
    candidates.push({
      ...route,
      key,
      providerName: route.provider,
      modelName: route.model,
      available: false,
      selected: selected.has(key),
    })
  }
  return candidates
}

function sameRoutes(left: readonly AllowedSubagentModel[], right: readonly AllowedSubagentModel[]): boolean {
  if (left.length !== right.length) return false
  const rightKeys = new Set(right.map(subagentModelKey))
  return left.every(route => rightKeys.has(subagentModelKey(route)))
}

/** Bridges one settings scope and the live adapter directory onto a staged card. */
export class SubagentModelSelectionCardController {
  private catalogGroups: readonly ModelProviderGroup[] = []
  private catalogFailures: readonly ModelCatalogFailure[] = []
  private catalogStatus: SubagentModelSelectionCardState['catalogStatus'] = 'idle'
  private draftEnabled: boolean | undefined
  private draftSelected: Set<string> | undefined
  private saving = false
  private saved = false
  private failed = false
  private disposed = false
  private saveGeneration = 0
  private catalogGeneration = 0
  private readonly store: SnapshotStore<SubagentModelSelectionCardState>
  private readonly unsubscribe: () => void

  /**
   * @param scope - bound `subagent-model-selection` settings scope.
   * @param api - Host LLM directory face.
   */
  constructor(
    private readonly scope: SettingsScope<SubagentModelSelectionSettings>,
    private readonly api: Pick<IApiClient, 'llm'>,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (this.currentRoutes().length > 0 && this.catalogStatus === 'idle') void this.loadCatalog()
      this.publish()
    })
  }

  /** Stop observing settings and suppress late directory/write settlements. */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.catalogGeneration += 1
    this.unsubscribe()
  }

  /**
   * Build the renderer face for this card.
   * @returns The snapshot and staged card actions injected into the renderer.
   */
  inject(): SubagentModelSelectionCardFace {
    return {
      hooks: { subagentModelSelectionCard: this.store },
      toggleEnabled: () => { this.toggleEnabled() },
      toggleModel: (key) => { this.toggleModel(key) },
      retryCatalog: () => { void this.loadCatalog() },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  private currentRoutes(): AllowedSubagentModel[] {
    return this.scope.getSnapshot().value?.allowedModels?.map(route => ({ ...route })) ?? []
  }

  private selected(): Set<string> {
    return this.draftSelected ?? new Set(this.currentRoutes().map(subagentModelKey))
  }

  private enabled(): boolean {
    return this.draftEnabled ?? this.currentRoutes().length > 0
  }

  private beginDraft(): Set<string> {
    this.draftEnabled ??= this.currentRoutes().length > 0
    this.draftSelected ??= new Set(this.currentRoutes().map(subagentModelKey))
    return this.draftSelected
  }

  private toggleEnabled(): void {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    this.beginDraft()
    this.draftEnabled = !this.draftEnabled
    this.saved = false
    this.failed = false
    if (this.draftEnabled && this.catalogStatus === 'idle') void this.loadCatalog()
    this.publish()
  }

  private toggleModel(key: string): void {
    if (!this.enabled() || this.saving || !this.scope.getSnapshot().writable) return
    if (!this.candidates().some(candidate => candidate.key === key)) return
    const selected = this.beginDraft()
    if (selected.has(key)) selected.delete(key)
    else selected.add(key)
    this.saved = false
    this.failed = false
    this.publish()
  }

  private discard(): void {
    if (this.saving) return
    this.draftEnabled = undefined
    this.draftSelected = undefined
    this.saved = false
    this.failed = false
    this.publish()
  }

  private candidates(): SubagentModelCandidate[] {
    return subagentModelCandidates(this.catalogGroups, this.currentRoutes(), this.selected())
  }

  private desiredRoutes(): AllowedSubagentModel[] {
    if (!this.enabled()) return []
    return this.candidates()
      .filter(candidate => candidate.selected)
      .map(({ provider, model }) => ({ provider, model }))
  }

  private async save(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    const desired = this.desiredRoutes()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving
      || sameRoutes(this.currentRoutes(), desired) || (this.enabled() && desired.length === 0)) return
    const generation = this.saveGeneration
    this.saving = true
    this.saved = false
    this.failed = false
    this.publish()
    await this.scope.set('allowedModels', desired)
    if (generation !== this.saveGeneration) return
    const landed = sameRoutes(this.currentRoutes(), desired)
    this.saving = false
    this.saved = landed
    this.failed = !landed
    if (landed) {
      this.draftEnabled = undefined
      this.draftSelected = undefined
    }
    this.publish()
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogGroups = []
    this.catalogFailures = []
    this.publish()
    try {
      const response = await this.api.llm.models({})
      if (generation !== this.catalogGeneration) return
      if (!response.result.ok) throw new Error(response.result.error.message)
      this.catalogGroups = response.result.value.groups
      this.catalogFailures = response.result.value.failures
      this.catalogStatus = 'ready'
    } catch {
      if (generation !== this.catalogGeneration) return
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  private projection(): SubagentModelSelectionCardState {
    const snapshot = this.scope.getSnapshot()
    const current = this.currentRoutes()
    const desired = this.desiredRoutes()
    const enabled = this.enabled()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: !sameRoutes(current, desired),
      invalid: enabled && desired.length === 0,
      saving: this.saving,
      failed: this.failed,
      enabled,
      candidates: this.candidates(),
      catalogStatus: this.catalogStatus,
      catalogFailures: this.catalogFailures,
      saved: this.saved,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
