/** Host-side non-CDP query bridge over the Worker MessagePort. */

import type { MessagePort } from 'node:worker_threads'
import type { InspectorSourceDescriptor } from '../../shared/bridge/messages/observation.ts'
import type { InspectorQuery, InspectorQueryResultFor } from '../../shared/bridge/messages/query/commands.ts'
import { InspectorQueryConnection, type InspectorQueryConnectionOptions } from '../../shared/bridge/rpc.ts'

/** Owns query correlation for one Host source generation. */
export class HostBridgeRpc {
  private readonly connection: InspectorQueryConnection

  constructor(private readonly port: MessagePort, options: InspectorQueryConnectionOptions) {
    this.connection = new InspectorQueryConnection(options)
  }

  /**
   * Connect query writes after the Worker accepts the Host source.
   * @param source - Accepted Host source descriptor.
   */
  connect(source: InspectorSourceDescriptor): void {
    this.connection.connect(source.sourceId, source.generation, {
      send: (frame) => { this.port.postMessage(frame) },
    })
  }

  /**
   * Consume a potential query response.
   * @param value - Decoded Worker message.
   * @returns Whether the message belonged to this RPC protocol.
   */
  receive(value: unknown): boolean {
    return this.connection.receive(value)
  }

  /**
   * Execute one non-CDP query through the active Host generation.
   * @param query - Typed query operation.
   * @returns Its correlated typed result.
   */
  request<Query extends InspectorQuery>(query: Query): Promise<InspectorQueryResultFor<Query>> {
    return this.connection.request(query)
  }

  /**
   * Reject pending requests while retaining the reusable Host bridge.
   * @param reason - Failure reported to pending callers.
   */
  disconnect(reason: string): void {
    this.connection.disconnect(reason)
  }

  /**
   * Permanently reject all current and future requests.
   * @param reason - Failure reported to pending callers.
   */
  close(reason: string): void {
    this.connection.close(reason)
  }
}
