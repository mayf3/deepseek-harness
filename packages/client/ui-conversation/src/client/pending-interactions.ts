/** Presentation-only pending interactions received through Remote Events. */
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore,
  type ObservableSnapshot,
  type PendingInteraction,
  type PendingInteractionStatus,
} from '@deepseek-ai/dsh-client-runtime/client'

const EMPTY_INTERACTIONS: readonly PendingInteraction[] = []
const ABSENT_INTERACTIONS: ObservableSnapshot<readonly PendingInteraction[]> = {
  getSnapshot: () => EMPTY_INTERACTIONS,
  subscribe: () => () => {},
}

interface PendingEntry {
  readonly interaction: PendingInteraction
  readonly status: PendingInteractionStatus
  readonly precedence: number
}

interface PendingPresentationSnapshot {
  readonly interactions: ReadonlyMap<SessionId, readonly PendingInteraction[]>
  readonly statuses: ReadonlyMap<SessionId, PendingInteractionStatus>
}

/** Presentation sources shared by the composer and Session navigation. */
export interface PendingInteractionPresentation {
  /** Effective pending-interaction status by Session. */
  readonly statuses: ObservableSnapshot<ReadonlyMap<SessionId, PendingInteractionStatus>>
  /**
   * Resolve the effective composer interaction for one Session.
   * @param sessionId - current Session identity, or absence outside a Session scope.
   * @returns an identity-stable observable source.
   */
  forSession(sessionId: SessionId | undefined): ObservableSnapshot<readonly PendingInteraction[]>
  /**
   * Publish one domain-owned interaction until its disposer runs.
   * @param interaction - answerable presentation object.
   * @param status - sidebar presentation kind.
   * @param precedence - deterministic cross-domain priority; larger values win.
   * @returns idempotent removal function.
   */
  present(
    interaction: PendingInteraction,
    status: PendingInteractionStatus,
    precedence: number,
  ): () => void
}

/** Aggregate domain-owned Remote Event waits without putting them on Session state. */
export class PendingInteractionPresenter implements PendingInteractionPresentation {
  private readonly entries = new Map<string, PendingEntry>()
  private readonly sources = new Map<SessionId, ObservableSnapshot<readonly PendingInteraction[]>>()
  private readonly state = createSnapshotStore<PendingPresentationSnapshot>({
    interactions: new Map(),
    statuses: new Map(),
  })

  /** Effective pending-interaction status by Session. */
  readonly statuses: ObservableSnapshot<ReadonlyMap<SessionId, PendingInteractionStatus>> = {
    getSnapshot: () => this.state.getSnapshot().statuses,
    subscribe: listener => this.state.subscribe(listener),
  }

  /** @inheritdoc */
  forSession(sessionId: SessionId | undefined): ObservableSnapshot<readonly PendingInteraction[]> {
    if (sessionId === undefined) return ABSENT_INTERACTIONS
    let source = this.sources.get(sessionId)
    if (source === undefined) {
      source = {
        getSnapshot: () => this.state.getSnapshot().interactions.get(sessionId) ?? EMPTY_INTERACTIONS,
        subscribe: listener => this.state.subscribe(listener),
      }
      this.sources.set(sessionId, source)
    }
    return source
  }

  /** @inheritdoc */
  present(
    interaction: PendingInteraction,
    status: PendingInteractionStatus,
    precedence: number,
  ): () => void {
    if (this.entries.has(interaction.key)) {
      throw new Error(`ui-conversation: duplicate pending interaction key '${interaction.key}'`)
    }
    const entry = { interaction, status, precedence }
    this.entries.set(interaction.key, entry)
    this.publish()
    let active = true
    return () => {
      if (!active) return
      active = false
      interaction.markSettled()
      this.entries.delete(interaction.key)
      this.publish()
    }
  }

  private publish(): void {
    const selected = new Map<SessionId, PendingEntry>()
    for (const entry of this.entries.values()) {
      const previous = selected.get(entry.interaction.sessionId)
      if (previous === undefined || entry.precedence >= previous.precedence) {
        selected.set(entry.interaction.sessionId, entry)
      }
    }
    this.state.set({
      interactions: new Map(
        [...selected].map(([sessionId, entry]) => [sessionId, [entry.interaction]] as const),
      ),
      statuses: new Map(
        [...selected].map(([sessionId, entry]) => [sessionId, entry.status] as const),
      ),
    })
  }
}
