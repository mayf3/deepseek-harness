/** Client-side non-CDP query bridge over the active Worker WebSocket. */

import type { InspectorSourceDescriptor } from '../../shared/bridge/messages/observation.ts'
import type { InspectorQuery, InspectorQueryResultFor } from '../../shared/bridge/messages/query/commands.ts'
import { InspectorQueryConnection, type InspectorQueryConnectionOptions } from '../../shared/bridge/rpc.ts'

/** Owns query correlation across reconnecting Client source generations. */
export class ClientBridgeRpc {
  private readonly connection: InspectorQueryConnection

  constructor(options: InspectorQueryConnectionOptions) {
    this.connection = new InspectorQueryConnection(options)
  }

  /**
   * Connect query writes to one accepted Client WebSocket generation.
   * @param source - Accepted source descriptor.
   * @param socket - Active source WebSocket.
   */
  connect(source: InspectorSourceDescriptor, socket: WebSocket): void {
    this.connection.connect(source.sourceId, source.generation, {
      send: (frame) => {
        if (socket.readyState !== WebSocket.OPEN) throw new Error('Inspector Client query socket is not connected')
        socket.send(JSON.stringify(frame))
      },
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
   * Execute one non-CDP query through the active Client generation.
   * @param query - Typed query operation.
   * @returns Its correlated typed result.
   */
  request<Query extends InspectorQuery>(query: Query): Promise<InspectorQueryResultFor<Query>> {
    return this.connection.request(query)
  }

  /**
   * Reject pending requests while permitting a later Client generation.
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
