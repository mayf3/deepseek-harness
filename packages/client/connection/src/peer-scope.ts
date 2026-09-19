/**
 * Peer registry: one `PeerScope` per party admitted to this Host.
 *
 * The framework knows a Peer only by its `PeerId` and the scope it owns. Who
 * the Peer is and what it may do belong to whoever admitted it; that party
 * attaches its state through `peer.ctx` or a registry keyed by the scope.
 * @module @deepseek-ai/dsh-client-connection/src/peer-scope
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { PeerRegistryHandle } from './rpc.ts'

/**
 * One admitted Peer. The instance is its own scope key, so `scopeOf(peer.ctx)`
 * returns it and events dispatched with `scopeTarget(subject, peer)` reach
 * listeners registered through `peer.ctx` and nobody else.
 */
class AdmittedPeer implements PeerScope {
  readonly id: PeerId = randomUUID() as PeerId
  readonly ctx: Context
  private readonly scope: Scope
  private disposing: Promise<void> | undefined

  /**
   * @param owner - Connection plugin context the scope fiber hangs under.
   * @param onClosed - registry callback run once disposal completes.
   */
  constructor(owner: Context, private readonly onClosed: (peer: AdmittedPeer) => void) {
    this.scope = createScope(owner, this)
    this.ctx = this.scope.ctx
  }

  /** Tear down every connection-lifetime registration; racing calls share one completion. */
  dispose(): Promise<void> {
    this.disposing ??= this.scope.dispose().then(() => { this.onClosed(this) })
    return this.disposing
  }
}

/** Host-wide registry of Peers and the carriers that speak for them. */
export class PeerRegistry implements PeerRegistryHandle {
  readonly operator: PeerScope
  private readonly peers = new Set<AdmittedPeer>()
  private readonly carriers = new WeakMap<object, PeerScope>()

  /** @param ctx - Connection plugin context; every scope fiber is its child. */
  constructor(private readonly ctx: Context) {
    this.operator = this.open()
  }

  /**
   * Admit one Peer on behalf of an admitter.
   * @returns the opened scope; the admitter disposes it when the Peer leaves.
   */
  open(): PeerScope {
    const peer = new AdmittedPeer(this.ctx, (closed) => { this.peers.delete(closed) })
    this.peers.add(peer)
    return peer
  }

  /**
   * Record which Peer one carrier object speaks for.
   * @param carrier - node request, upgrade request, WebSocket, or Fetch `Request`.
   * @param peer - the Peer it was admitted as.
   */
  bind(carrier: object, peer: PeerScope): void {
    this.carriers.set(carrier, peer)
  }

  /**
   * Read the Peer a carrier object was bound to.
   * @param carrier - node request, upgrade request, WebSocket, or Fetch `Request`.
   * @returns the bound Peer, or undefined when nobody bound one.
   */
  of(carrier: object): PeerScope | undefined {
    return this.carriers.get(carrier)
  }

  /**
   * Dispose every open Peer, the operator included. Each scope's registrations
   * are torn down; sockets bound to a Peer close with it.
   * @returns settles once every scope has quiesced.
   */
  async dispose(): Promise<void> {
    await Promise.all([...this.peers].map(peer => peer.dispose()))
  }
}
