/** Client observation and Runtime endpoint over the Inspector Worker's ingest WebSocket. */

import type { InspectorClientBootstrap } from '../../shared/bridge/messages/control.ts'
import type { InspectorSourceGeneration } from '../../shared/bridge/ids.ts'
import { isJsonValue, jsonByteLength, type InspectorJsonValue } from '../../shared/json.ts'
import type { InspectorQuery, InspectorQueryResultFor } from '../../shared/bridge/messages/query/commands.ts'
import {
  INSPECTOR_PROTOCOL_VERSION,
  parseWorkerSourceFrame,
  type SourceCloseFrame,
  type SourceOpenFrame,
} from '../../shared/bridge/messages/observation.ts'
import type { InspectorConnection } from '../../shared/bridge/publisher.ts'
import { ClientConsoleObserver } from '../cdp/console.ts'
import { ClientRuntimeExecutor } from '../cdp/runtime.ts'
import {
  ClientSourceCatalog,
  ClientSourceCatalogError,
  discoverInspectorClientSourceCatalog,
} from '../cdp/sources.ts'
import type { ClientSourceRequestFrame, ClientSourceResponseFrame } from '../../shared/bridge/messages/sources/index.ts'
import { ClientRealmSource } from '../inspection/realm.ts'
import { NETWORK_TOPICS } from '../inspection/network.ts'
import { ClientBridgeLifecycle } from './lifecycle.ts'
import { ClientBridgePublisher } from './publisher.ts'
import { ClientBridgeRpc } from './rpc.ts'
import { dispatchBridgeFrame } from './dispatcher.ts'

/** Reconnecting Client source whose bounded queue never blocks page work. */
export class ClientInspectorSource implements InspectorConnection {
  private readonly realmSource: ClientRealmSource
  private readonly publisher: ClientBridgePublisher
  private socket: WebSocket | undefined
  private generation: InspectorSourceGeneration | undefined
  private accepted = false
  private closed = false
  private readonly runtime: ClientRuntimeExecutor
  private readonly console: ClientConsoleObserver
  private readonly queries: ClientBridgeRpc
  private readonly lifecycle: ClientBridgeLifecycle

  constructor(
    private readonly bootstrap: InspectorClientBootstrap,
    label = document.title || 'Client',
    private readonly sourceCatalog: ClientSourceCatalog | undefined = discoverInspectorClientSourceCatalog(),
  ) {
    this.realmSource = new ClientRealmSource(label)
    this.lifecycle = new ClientBridgeLifecycle(bootstrap.reconnectBaseMs, bootstrap.reconnectMaxMs)
    this.publisher = new ClientBridgePublisher({
      topics: ['*'],
      maxQueuedRecords: bootstrap.maxQueuedRecords,
      maxQueuedBytes: bootstrap.maxQueuedBytes,
      maxRecordsPerFrame: bootstrap.maxRecordsPerFrame,
      maxFrameBytes: bootstrap.maxFrameBytes,
    }, bootstrap.maxQueuedBytes)
    this.runtime = new ClientRuntimeExecutor({
      maxObjectsPerSession: bootstrap.maxRuntimeObjectsPerSession,
      maxPropertiesPerResult: bootstrap.maxRuntimePropertiesPerResult,
      maxResponseBytes: bootstrap.maxFrameBytes,
    }, url => this.sourceCatalog?.scriptKeyForUrl(url))
    this.console = new ClientConsoleObserver(this.runtime, (sessionId, event) => {
      const socket = this.socket
      const generation = this.generation
      if (this.closed
        || !this.accepted
        || socket?.readyState !== WebSocket.OPEN
        || generation === undefined) return
      const frame = {
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'client-console/event',
        sourceId: this.realmSource.sourceId,
        generation,
        sessionId,
        event,
      } as const
      if (!isJsonValue(frame) || jsonByteLength(frame) > this.bootstrap.maxFrameBytes) return
      try {
        socket.send(JSON.stringify(frame))
      } catch {
        // The socket close path resets this generation's Runtime and Console state.
      }
    }, url => this.sourceCatalog?.scriptKeyForUrl(url))
    this.queries = new ClientBridgeRpc({
      timeoutMs: bootstrap.queryTimeoutMs,
      maxFrameBytes: bootstrap.maxFrameBytes,
    })
    this.connect()
  }

  /** Publish one JSON observation without waiting on the ingest socket. */
  publish(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()): void {
    if (this.closed) return
    this.publisher.publish(topic, payload, monotonicMs)
  }

  /** Retain and publish one state value for reconnect and resnapshot recovery. */
  setState(topic: string, payload: InspectorJsonValue, monotonicMs = performance.now()): void {
    if (this.closed) throw new Error('inspector: Client source is closed')
    this.publisher.setState(topic, payload, monotonicMs)
  }

  /** Execute one non-CDP query through the accepted Client source generation. */
  request<Query extends InspectorQuery>(query: Query): Promise<InspectorQueryResultFor<Query>> {
    return this.queries.request(query)
  }

  /** Permanently stop reconnecting and close the active source generation. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.console.close()
    this.runtime.reset()
    this.queries.close('Inspector Client source closed')
    this.lifecycle.close()
    this.publisher.close()
    const socket = this.socket
    const generation = this.generation
    if (socket?.readyState === WebSocket.OPEN && generation !== undefined) {
      const frame: SourceCloseFrame = {
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'source/close',
        sourceId: this.realmSource.sourceId,
        generation,
      }
      socket.send(JSON.stringify(frame))
      socket.close(1000, 'Client source closed')
    } else {
      socket?.close()
    }
    this.socket = undefined
  }

  private connect(): void {
    if (this.closed) return
    this.console.reset()
    this.runtime.reset()
    this.queries.disconnect('Inspector Client source reconnecting')
    const source = this.realmSource.connect(this.sourceCatalog !== undefined)
    const generation = source.generation
    const socket = new WebSocket(this.bootstrap.endpoint, this.bootstrap.protocol)
    this.socket = socket
    this.generation = generation
    this.accepted = false
    this.publisher.connect(socket, source)
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.closed) return
      const frame: SourceOpenFrame = {
        v: INSPECTOR_PROTOCOL_VERSION,
        t: 'source/open',
        source,
        topics: ['*', ...NETWORK_TOPICS],
      }
      socket.send(JSON.stringify(frame))
    })
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return
      try {
        if (new TextEncoder().encode(event.data).byteLength > this.bootstrap.maxFrameBytes) {
          throw new Error(`inspector protocol: Worker frame exceeds ${String(this.bootstrap.maxFrameBytes)} bytes`)
        }
        const value = JSON.parse(event.data) as unknown
        if (this.queries.receive(value)) return
        const frame = parseWorkerSourceFrame(value)
        if (frame.t !== 'source/rejected'
          && (frame.sourceId !== this.realmSource.sourceId || frame.generation !== generation)) return
        dispatchBridgeFrame(frame, {
          accepted: () => {
            this.accepted = true
            this.lifecycle.connected()
            this.queries.connect(source, socket)
            this.publisher.accept(socket)
          },
          resnapshot: () => { this.publisher.replace(socket) },
          rejected: (rejected) => {
            console.error(`[inspector] Client source rejected: ${rejected.message}`)
            socket.close(1008, 'source rejected')
          },
          runtime: (request) => {
            void this.executeRuntime(socket, generation, request).catch((error: unknown) => {
              console.error('[inspector] Client Runtime transport failed:', error)
              socket.close(1011, 'Client Runtime transport failed')
            })
          },
          runtimeClosed: (closed) => {
            this.console.disable(closed.sessionId)
            this.runtime.closeSession(closed.sessionId)
          },
          consoleEnabled: (enabled) => { this.console.enable(enabled.sessionId) },
          consoleDisabled: (disabled) => { this.console.disable(disabled.sessionId) },
          sources: (request) => {
            void this.executeSourceRequest(socket, generation, request).catch((error: unknown) => {
              console.error('[inspector] Client Sources transport failed:', error)
              socket.close(1011, 'Client Sources transport failed')
            })
          },
          sourcesClosed: () => {},
        })
      } catch (error) {
        console.error('[inspector] invalid Worker control frame:', error)
        socket.close(1008, 'invalid Worker control frame')
      }
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket || this.closed) return
      this.socket = undefined
      this.accepted = false
      this.publisher.disconnect(socket)
      this.console.reset()
      this.runtime.reset()
      this.queries.disconnect('Inspector Client source disconnected')
      this.lifecycle.reconnect(() => { this.connect() })
    })
    socket.addEventListener('error', () => {
      // `close` owns reconnection and keeps one timer.
    })
  }

  private async executeRuntime(
    socket: WebSocket,
    generation: InspectorSourceGeneration,
    frame: Extract<ReturnType<typeof parseWorkerSourceFrame>, { t: 'client-runtime/request' }>,
  ): Promise<void> {
    const response = await this.runtime.execute(frame)
    if (this.closed || this.socket !== socket || this.generation !== generation || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(response))
  }

  private async executeSourceRequest(
    socket: WebSocket,
    generation: InspectorSourceGeneration,
    frame: ClientSourceRequestFrame,
  ): Promise<void> {
    let outcome: ClientSourceResponseFrame['outcome']
    try {
      if (this.sourceCatalog === undefined) {
        throw new ClientSourceCatalogError('invalid-request', 'Client source catalog is unavailable')
      }
      outcome = { ok: true, result: await this.sourceCatalog.execute(frame.command, this.bootstrap.maxClientSourceBytes) }
    } catch (error) {
      outcome = {
        ok: false,
        error: {
          code: error instanceof ClientSourceCatalogError ? error.code : 'internal-error',
          message: renderError(error).slice(0, 2_048),
        },
      }
    }
    let response: ClientSourceResponseFrame = {
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'client-sources/response',
      sourceId: this.realmSource.sourceId,
      generation,
      sessionId: frame.sessionId,
      requestId: frame.requestId,
      outcome,
    }
    if (!isJsonValue(response) || jsonByteLength(response) > this.bootstrap.maxFrameBytes) {
      response = {
        ...response,
        outcome: {
          ok: false,
          error: { code: 'result-too-large', message: 'Client source result exceeds the source-frame byte limit' },
        },
      }
    }
    if (this.closed || this.socket !== socket || this.generation !== generation || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(response))
  }

}

function renderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
