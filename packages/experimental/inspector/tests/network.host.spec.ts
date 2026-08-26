/** Worker-side Network projection behavior. */

import { describe, expect, it, vi } from 'vitest'
import { NetworkDomain, type NetworkSink } from '../src/worker/cdp/domains/network/session.ts'
import { NetworkStore } from '../src/worker/inspection/network-store.ts'
import { inspectorId } from '../src/shared/bridge/ids.ts'
import type { InspectorSourceDescriptor } from '../src/shared/bridge/messages/observation.ts'
import type { IngestedInspectorRecord } from '../src/worker/bridge/hub.ts'

const source: InspectorSourceDescriptor = {
  sourceId: inspectorId<'InspectorSourceId'>('host-network', 'sourceId'),
  generation: inspectorId<'InspectorSourceGeneration'>('network-generation', 'generation'),
  kind: 'host',
  label: 'Host',
  timeOriginMs: performance.timeOrigin,
  capabilities: [],
}

describe('Inspector Network domain', () => {
  it('bounds incomplete bodies and marks the retained prefix truncated', () => {
    const sendEvent = vi.fn()
    const sink: NetworkSink = { sendEvent }
    const store = new NetworkStore({ maxRetainedRequests: 10, maxJournalBytes: 4 })
    const network = new NetworkDomain(store)
    network.enable(sink)
    store.append(source, requestRecords('first', 'abcdef'))

    const response = network.handle('Network.getResponseBody', { requestId: requestId('first') }, sink)
    expect(response).toEqual({
      body: Buffer.from('abcd').toString('base64'),
      base64Encoded: true,
      dshInspectorTruncated: true,
    })
    const dataEvent = sendEvent.mock.calls.find(call => call[0] === 'Network.dataReceived')
    expect(dataEvent?.[1]).toMatchObject({ dataLength: 6, encodedDataLength: 6 })
    expect(dataEvent?.[1]).not.toHaveProperty('data')
  })

  it('evicts completed requests before retaining a later body', () => {
    const sink: NetworkSink = { sendEvent: vi.fn() }
    const store = new NetworkStore({ maxRetainedRequests: 10, maxJournalBytes: 4 })
    const network = new NetworkDomain(store)
    store.append(source, requestRecords('first', 'aaaa'))
    store.append(source, requestRecords('second', 'bbbb'))

    expect(() => network.handle('Network.getResponseBody', { requestId: requestId('first') }, sink)).toThrow(
      'No resource with given identifier',
    )
    expect(network.handle('Network.getResponseBody', { requestId: requestId('second') }, sink)).toEqual({
      body: Buffer.from('bbbb').toString('base64'),
      base64Encoded: true,
      dshInspectorTruncated: false,
    })
  })

  it('streams later response chunks only to CDP sessions that opted in', () => {
    const firstSend = vi.fn()
    const secondSend = vi.fn()
    const first: NetworkSink = { sendEvent: firstSend }
    const second: NetworkSink = { sendEvent: secondSend }
    const store = new NetworkStore({ maxRetainedRequests: 10, maxJournalBytes: 1_024 })
    const network = new NetworkDomain(store)
    network.enable(first)
    network.enable(second)
    const records = requestRecords('stream', 'data: first\n\n')
    store.append(source, records.slice(0, 2))

    expect(network.handle('Network.streamResourceContent', { requestId: requestId('stream') }, first)).toEqual({
      bufferedData: '',
    })
    store.append(source, records.slice(2, 3))

    const firstData = firstSend.mock.calls.findLast(call => call[0] === 'Network.dataReceived')
    const secondData = secondSend.mock.calls.findLast(call => call[0] === 'Network.dataReceived')
    expect(firstData?.[1]).toMatchObject({ data: Buffer.from('data: first\n\n').toString('base64') })
    expect(secondData?.[1]).not.toHaveProperty('data')
    expect(network.handle('Network.streamResourceContent', { requestId: requestId('stream') }, second)).toEqual({
      bufferedData: Buffer.from('data: first\n\n').toString('base64'),
    })

    const later = Buffer.from('data: second\n\n').toString('base64')
    store.append(source, [{
      sequence: 4,
      monotonicMs: 4,
      topic: 'fetch/response-body-chunk',
      payload: { requestId: 'stream', data: later },
    }])
    expect(firstSend.mock.calls.findLast(call => call[0] === 'Network.dataReceived')?.[1]).toMatchObject({ data: later })
    expect(secondSend.mock.calls.findLast(call => call[0] === 'Network.dataReceived')?.[1]).toMatchObject({ data: later })
  })

  it('bounds active request metadata and does not retain per-chunk events for replay', () => {
    const firstSend = vi.fn()
    const store = new NetworkStore({ maxRetainedRequests: 1, maxJournalBytes: 1_024 })
    const network = new NetworkDomain(store)
    network.enable({ sendEvent: firstSend })
    store.append(source, requestRecords('active-first', 'first').slice(0, 1))
    store.append(source, requestRecords('active-second', 'second').slice(0, 1))

    expect(firstSend).toHaveBeenCalledWith('Network.loadingFailed', expect.objectContaining({
      requestId: requestId('active-first'),
      canceled: true,
    }))
    expect(() => network.handle(
      'Network.getRequestPostData',
      { requestId: requestId('active-first') },
      { sendEvent: vi.fn() },
    )).toThrow('No resource with given identifier')
    expect(() => { store.append(source, requestRecords('active-first', 'first').slice(1)) }).not.toThrow()

    store.append(source, requestRecords('active-second', 'second').slice(1))
    const replay = vi.fn()
    network.enable({ sendEvent: replay })
    expect(replay.mock.calls.some(call => call[0] === 'Network.dataReceived')).toBe(false)
    expect(replay).toHaveBeenCalledTimes(3)
    expect(replay).toHaveBeenNthCalledWith(1, 'Network.requestWillBeSent', expect.any(Object))
    expect(replay).toHaveBeenNthCalledWith(2, 'Network.responseReceived', expect.any(Object))
    expect(replay).toHaveBeenNthCalledWith(3, 'Network.loadingFinished', expect.any(Object))
  })
})

function requestRecords(localId: string, body: string): IngestedInspectorRecord[] {
  return [
    {
      sequence: 1,
      monotonicMs: 1,
      topic: 'fetch/start',
      payload: { requestId: localId, url: 'https://example.test/', method: 'GET', headers: [], hasBody: false, wallTimeMs: 1 },
    },
    {
      sequence: 2,
      monotonicMs: 2,
      topic: 'fetch/response',
      payload: { requestId: localId, url: 'https://example.test/', status: 200, statusText: 'OK', headers: [], mimeType: 'text/plain' },
    },
    {
      sequence: 3,
      monotonicMs: 3,
      topic: 'fetch/response-body-chunk',
      payload: { requestId: localId, data: Buffer.from(body).toString('base64') },
    },
    {
      sequence: 4,
      monotonicMs: 4,
      topic: 'fetch/end',
      payload: { requestId: localId, capturedBytes: body.length, responseBodyTruncated: false },
    },
  ]
}

function requestId(localId: string): string {
  return `${source.sourceId}:${source.generation}:${localId}`
}
