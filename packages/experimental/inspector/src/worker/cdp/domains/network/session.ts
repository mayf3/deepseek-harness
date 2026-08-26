/** CDP Network projection over the Worker-owned normalized network store. */

import { Buffer } from 'node:buffer'
import type { InspectorHeader } from '../../../../shared/network/observation.ts'
import type { NetworkStore, NetworkStoreEvent } from '../../../inspection/network-store.ts'

/** CDP session slice used by the Network domain. */
export interface NetworkSink {
  sendEvent(method: string, params: Readonly<Record<string, unknown>>): void
}

/** Projects retained and live network observations into connection-local CDP state. */
export class NetworkDomain {
  private readonly enabled = new Set<NetworkSink>()
  private readonly streamedRequests = new Map<NetworkSink, Set<string>>()
  private readonly unsubscribe: () => void

  constructor(private readonly store: NetworkStore) {
    this.unsubscribe = store.subscribe((event) => { this.receive(event) })
  }

  /**
   * Enable Network for one DevTools connection and replay retained lifecycle events.
   * @param session - Connection receiving replay and subsequent events.
   */
  enable(session: NetworkSink): void {
    if (this.enabled.has(session)) return
    for (const event of this.store.replay()) this.send(session, event)
    this.enabled.add(session)
  }

  /**
   * Stop Network events for one DevTools connection.
   * @param session - Connection leaving the enabled set.
   */
  disable(session: NetworkSink): void {
    this.enabled.delete(session)
    this.streamedRequests.delete(session)
  }

  /**
   * Forget a closed DevTools connection.
   * @param session - Closed DevTools connection.
   */
  detach(session: NetworkSink): void {
    this.disable(session)
  }

  /** Release the repository subscription and all connection-local state. */
  close(): void {
    this.unsubscribe()
    this.enabled.clear()
    this.streamedRequests.clear()
  }

  /**
   * Handle one Worker-local Network method.
   * @param method - CDP method name.
   * @param params - Parsed request parameters.
   * @param session - Calling DevTools connection.
   * @returns The CDP result fields.
   */
  handle(method: string, params: Readonly<Record<string, unknown>>, session: NetworkSink): unknown {
    switch (method) {
      case 'Network.enable':
        this.enable(session)
        return {}
      case 'Network.disable':
        this.disable(session)
        return {}
      case 'Network.getResponseBody': {
        const body = this.store.responseBody(params.requestId)
        return {
          body: Buffer.from(body.bytes).toString('base64'),
          base64Encoded: true,
          dshInspectorTruncated: body.truncated,
          ...(body.captureError === undefined ? {} : { dshInspectorCaptureError: body.captureError }),
        }
      }
      case 'Network.getRequestPostData': {
        const body = this.store.requestBody(params.requestId)
        return {
          postData: Buffer.from(body.bytes).toString('utf8'),
          dshInspectorTruncated: body.truncated,
          ...(body.captureError === undefined ? {} : { dshInspectorCaptureError: body.captureError }),
        }
      }
      case 'Network.streamResourceContent': {
        const body = this.store.responseBody(params.requestId)
        if (typeof params.requestId !== 'string') throw new Error('Network requestId must be a string')
        if (!body.complete) {
          let requests = this.streamedRequests.get(session)
          if (requests === undefined) this.streamedRequests.set(session, requests = new Set())
          requests.add(params.requestId)
        }
        return { bufferedData: Buffer.from(body.bytes).toString('base64') }
      }
      case 'Network.setCacheDisabled':
      case 'Network.setBypassServiceWorker':
      case 'Network.setExtraHTTPHeaders':
      case 'Network.clearBrowserCache':
      case 'Network.clearBrowserCookies':
        return {}
      default:
        throw new Error(`unsupported Network method ${method}`)
    }
  }

  private receive(event: NetworkStoreEvent): void {
    if (event.type === 'request-evicted') {
      for (const [session, requests] of this.streamedRequests) {
        requests.delete(event.requestKey)
        if (requests.size === 0) this.streamedRequests.delete(session)
      }
      return
    }
    for (const session of this.enabled) this.send(session, event)
  }

  private send(session: NetworkSink, event: Exclude<NetworkStoreEvent, { readonly type: 'request-evicted' }>): void {
    const timestamp = (event.timestampMs - performance.timeOrigin) / 1_000
    switch (event.type) {
      case 'request-started':
        session.sendEvent('Network.requestWillBeSent', {
          requestId: event.requestId,
          loaderId: 'dsh-inspector-loader',
          documentURL: 'dsh://host',
          request: {
            url: event.url,
            method: event.method,
            headers: cdpHeaders(event.headers),
            hasPostData: event.hasBody,
          },
          timestamp,
          wallTime: event.wallTimeMs / 1_000,
          initiator: { type: 'other' },
          type: 'Fetch',
        })
        return
      case 'response-received':
        session.sendEvent('Network.responseReceived', {
          requestId: event.requestId,
          loaderId: 'dsh-inspector-loader',
          frameId: 'dsh-inspector-host-frame',
          timestamp,
          type: 'Fetch',
          response: {
            url: event.url,
            status: event.status,
            statusText: event.statusText,
            headers: cdpHeaders(event.headers),
            mimeType: event.mimeType,
            connectionReused: false,
            connectionId: 0,
            encodedDataLength: 0,
            securityState: 'neutral',
          },
        })
        return
      case 'response-data':
        session.sendEvent('Network.dataReceived', {
          requestId: event.requestId,
          timestamp,
          dataLength: event.byteLength,
          encodedDataLength: event.byteLength,
          ...(this.streamedRequests.get(session)?.has(event.requestKey) === true ? { data: event.data } : {}),
        })
        return
      case 'request-finished':
        session.sendEvent('Network.loadingFinished', {
          requestId: event.requestId,
          timestamp,
          encodedDataLength: event.encodedDataLength,
          dshInspectorTruncated: event.truncated,
        })
        this.stopStreaming(event.requestKey)
        return
      case 'request-failed':
        session.sendEvent('Network.loadingFailed', {
          requestId: event.requestId,
          timestamp,
          type: 'Fetch',
          errorText: event.errorText,
          canceled: event.canceled,
        })
        this.stopStreaming(event.requestKey)
        return
      default:
        return assertNever(event)
    }
  }

  private stopStreaming(requestKey: string): void {
    for (const [session, requests] of this.streamedRequests) {
      requests.delete(requestKey)
      if (requests.size === 0) this.streamedRequests.delete(session)
    }
  }
}

function cdpHeaders(entries: readonly InspectorHeader[]): Record<string, string> {
  const headers: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [name, value] of entries) {
    headers[name] = headers[name] === undefined ? value : `${headers[name]}\n${value}`
  }
  return headers
}

function assertNever(value: never): never {
  throw new Error(`Unexpected network event: ${JSON.stringify(value)}`)
}
