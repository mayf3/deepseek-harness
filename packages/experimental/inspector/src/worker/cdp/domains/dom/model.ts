/** Worker projection from Cordis snapshots to a connection-neutral semantic DOM. */

import type { CordisTreeNode } from '../../../../shared/cordis/snapshot.ts'
import type { InspectorSourceDescriptor } from '../../../../shared/bridge/messages/observation.ts'
import type { InspectorObjectReference } from '../../../../shared/cordis/object-reference.ts'
import type { InspectorRealmDescriptor } from '../../../inspection/realm.ts'
import { cdpNumericId, type CdpBackendNodeId } from '../../ids.ts'
import type {
  CordisTreeObjectRoute,
  CordisTreeSourceSnapshot,
  CordisTreeStore,
  CordisTreeStoreEvent,
} from '../../../inspection/cordis-store.ts'

/** One Worker-global backend node independent of any DevTools connection. */
export interface CordisDomNode {
  readonly backendNodeId: CdpBackendNodeId
  readonly key: string
  readonly name: string
  readonly attributes: readonly (readonly [string, string])[]
  readonly description: string
  readonly object?: CordisTreeObjectRoute
  readonly children: readonly CordisDomNode[]
}

/** Immutable document revision shared by all current DevTools sessions. */
export interface CordisDomDocument {
  readonly revision: number
  readonly root: CordisDomNode
  readonly byBackendId: ReadonlyMap<CdpBackendNodeId, CordisDomNode>
  readonly parentByBackendId: ReadonlyMap<CdpBackendNodeId, CdpBackendNodeId>
}

/** A full tree replacement or an in-place source availability change. */
export type CordisDomChange =
  | { readonly type: 'document-updated' }
  | { readonly type: 'source-disconnected'; readonly source: InspectorSourceDescriptor }

/** Assigns durable backend ids and projects the latest source snapshots. */
export class CordisDomBackend {
  private readonly backendIdByKey = new Map<string, CdpBackendNodeId>()
  private readonly listeners = new Set<(event: CordisDomChange) => void>()
  private documentValue: CordisDomDocument
  private nextBackendNodeId = 1
  private nextRevision = 1
  private readonly unsubscribe: () => void
  private readonly nodeByObject = new Map<string, CordisDomNode>()

  constructor(private readonly trees: CordisTreeStore) {
    this.documentValue = this.build()
    this.unsubscribe = trees.subscribe((event) => {
      const previous = this.documentValue
      this.documentValue = this.build()
      const change = this.change(event, previous)
      for (const listener of [...this.listeners]) {
        try {
          listener(change)
        } catch {
          // One closed CDP connection cannot prevent sibling sessions from receiving the new document.
        }
      }
    })
  }

  /**
   * Read the latest connection-neutral semantic document.
   * @returns The current immutable document revision.
   */
  document(): CordisDomDocument {
    return this.documentValue
  }

  /**
   * Subscribe to full document replacements and in-place realm state changes.
   * @param listener - Called after a new backend revision is installed.
   * @returns A disposer removing the listener.
   */
  subscribe(listener: (event: CordisDomChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release repository subscriptions at Worker shutdown. */
  close(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  /**
   * Resolve one source-local object reference to its current projected node.
   * @param source - Connected source generation that owns the reference.
   * @param reference - Realm-local registry and object handle.
   * @returns The current projected node, when present.
   */
  nodeForObject(source: InspectorSourceDescriptor, reference: InspectorObjectReference): CordisDomNode | undefined {
    return this.nodeByObject.get(objectKey(source, reference))
  }

  /**
   * Resolve a reference when a Runtime route identifies only Host or Client ownership.
   * @param kind - Host or Client ownership inferred by the Runtime adapter.
   * @param reference - Realm-local registry and object handle.
   * @returns The current projected node, when present.
   */
  nodeForObjectKind(kind: InspectorSourceDescriptor['kind'], reference: InspectorObjectReference): CordisDomNode | undefined {
    const route = this.trees.resolveObjectInKind(kind, reference)
    return route === undefined ? undefined : this.nodeForObject(route.source, reference)
  }

  /**
   * Resolve one realm-neutral Runtime reference to its current projected node.
   * @param realm - Realm that exposed the Runtime object.
   * @param reference - Realm-local registry and object handle.
   * @returns The current projected node, when present.
   */
  nodeForRealm(realm: InspectorRealmDescriptor, reference: InspectorObjectReference): CordisDomNode | undefined {
    if (realm.kind === 'host') return this.nodeForObjectKind('host', reference)
    const route = this.trees.resolveObjectIdentity(realm.sourceId, realm.generation, reference)
    return route === undefined ? undefined : this.nodeForObject(route.source, reference)
  }

  private build(): CordisDomDocument {
    const byBackendId = new Map<CdpBackendNodeId, CordisDomNode>()
    const parentByBackendId = new Map<CdpBackendNodeId, CdpBackendNodeId>()
    this.nodeByObject.clear()
    const tree = this.trees.tree()
    const root = this.node('document', '#document', [], '#document')
    const host = this.node('host', 'host', [], '<host>')
    if (tree.host !== null) host.children.push(this.entity(tree.host, tree.host.snapshot.root))
    const clients = this.node('clients', 'clients', [], '<clients>')
    for (const clientTree of tree.clients) {
      const client = this.node(`client:${clientTree.source.sourceId}`, 'client', [], '<client>')
      client.children.push(this.entity(clientTree, clientTree.snapshot.root))
      clients.children.push(client)
    }
    root.children.push(host, clients)
    const retainedKeys = new Set<string>()
    const freeze = (node: MutableDomNode, parent?: MutableDomNode): CordisDomNode => {
      const value: CordisDomNode = { ...node, children: node.children.map(child => freeze(child, node)) }
      retainedKeys.add(value.key)
      byBackendId.set(value.backendNodeId, value)
      if (parent !== undefined) parentByBackendId.set(value.backendNodeId, parent.backendNodeId)
      if (value.object?.connection.state === 'connected') this.nodeByObject.set(objectKey(value.object.source, {
        registryId: value.object.snapshot.objectRegistryId,
        handle: value.object.node.objectHandle,
      }), value)
      return value
    }
    const frozenRoot = freeze(root)
    for (const key of this.backendIdByKey.keys()) {
      if (!retainedKeys.has(key)) this.backendIdByKey.delete(key)
    }
    return { revision: this.nextRevision++, root: frozenRoot, byBackendId, parentByBackendId }
  }

  private entity(
    tree: CordisTreeSourceSnapshot,
    node: CordisTreeNode,
  ): MutableDomNode {
    const { source, snapshot } = tree
    const key = `entity:${objectKey(source, { registryId: snapshot.objectRegistryId, handle: node.objectHandle })}`
    const object = { ...tree, node }
    const attributes: readonly (readonly [string, string])[] = node.kind === 'fiber'
      ? [['uid', String(node.uid)]]
      : []
    const projected = this.node(key, node.kind, attributes, elementDescription(node.kind, attributes), object)
    projected.children.push(...node.children.map(child => this.entity(tree, child)))
    return projected
  }

  private node(
    key: string,
    name: string,
    attributes: readonly (readonly [string, string])[],
    description: string,
    object?: CordisTreeObjectRoute,
  ): MutableDomNode {
    let backendNodeId = this.backendIdByKey.get(key)
    if (backendNodeId === undefined) {
      backendNodeId = cdpNumericId<'CdpBackendNodeId'>(this.nextBackendNodeId++, 'backendNodeId')
      this.backendIdByKey.set(key, backendNodeId)
    }
    return { backendNodeId, key, name, attributes, description, ...(object === undefined ? {} : { object }), children: [] }
  }

  private change(event: CordisTreeStoreEvent, previous: CordisDomDocument): CordisDomChange {
    if (event.type === 'source-disconnected' && sameNodeSet(previous, this.documentValue)) {
      return { type: 'source-disconnected', source: event.source }
    }
    return { type: 'document-updated' }
  }
}

interface MutableDomNode extends Omit<CordisDomNode, 'children'> {
  readonly children: MutableDomNode[]
}

function elementDescription(name: string, attributes: readonly (readonly [string, string])[]): string {
  const rendered = attributes.map(([key, value]) => value === '' ? key : `${key}=${JSON.stringify(value)}`).join(' ')
  return `<${name}${rendered === '' ? '' : ` ${rendered}`}>`
}

function objectKey(source: InspectorSourceDescriptor, reference: InspectorObjectReference): string {
  return `${source.sourceId}\0${source.generation}\0${reference.registryId}\0${reference.handle}`
}

function sameNodeSet(left: CordisDomDocument, right: CordisDomDocument): boolean {
  if (left.byBackendId.size !== right.byBackendId.size) return false
  for (const backendNodeId of left.byBackendId.keys()) {
    if (!right.byBackendId.has(backendNodeId)) return false
  }
  return true
}
