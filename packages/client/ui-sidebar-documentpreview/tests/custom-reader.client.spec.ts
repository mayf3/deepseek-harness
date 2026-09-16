/** Converted bytes have distinct read generations and cancel when their tab or renderer changes. */
import { expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { DocumentFileBytes } from '../src/client/rpc.ts'
import { textFace } from '../src/client/face.ts'
import { createTextStore } from '../src/client/store.ts'
import type { DocumentPreviewDefinition } from '../src/client/document/registry.ts'
import type { ReadDocumentBytes } from '../src/client/rpc.ts'

it('cancels converted reads on reload, raw-reader selection, and tab closure without publishing old results', async () => {
  const store = createTextStore().create()
  const source = { sessionId: 'session' as SessionId, path: 'report.docx' }
  const tab = 'tab' as TabId
  const lifetime = new AbortController()
  const result = (data: string): RemoteResult<DocumentFileBytes> => ({
    ok: true, value: { absolutePath: '/report.docx', version: 'source-v1', offset: 0, eof: true, data: new TextEncoder().encode(data) },
  })
  const pending: { signal: AbortSignal; settle: (value: RemoteResult<DocumentFileBytes>) => void }[] = []
  const read: ReadDocumentBytes = (_file, signal) => new Promise(resolve => pending.push({ signal, settle: resolve }))
  const reader: DocumentPreviewDefinition = { id: 'office', title: () => 'Office', extensions: ['docx'], loading: 'bytes-complete', read }
  const raw = vi.fn<ReadDocumentBytes>().mockResolvedValue(result('ZIP'))
  const face = textFace(vi.fn(), raw)(source.sessionId, store.actions)
  face.loadAll(tab, source, lifetime.signal, 'source-v1', reader)
  expect(raw).not.toHaveBeenCalled()
  face.reloadAll(tab, source, lifetime.signal, 'source-v1', reader)
  expect(pending[0]!.signal.aborted).toBe(true)
  pending[0]!.settle(result('obsolete PDF'))
  await Promise.resolve()
  expect(store.getSnapshot().byTab[tab]?.complete).toBeUndefined()
  face.loadAll(tab, source, lifetime.signal)
  expect(pending[1]!.signal.aborted).toBe(true)
  pending[1]!.settle(result('also obsolete'))
  await Promise.resolve()
  expect(new TextDecoder().decode(store.getSnapshot().byTab[tab]!.complete!.data)).toBe('ZIP')
  expect(store.getSnapshot().byTab[tab]!.readerId).toBeUndefined()
  face.loadAll(tab, source, lifetime.signal, 'source-v1', reader)
  lifetime.abort()
  expect(pending[2]!.signal.aborted).toBe(true)
  pending[2]!.settle(result('late PDF'))
  await Promise.resolve()
  expect(store.getSnapshot().byTab[tab]).toBeUndefined()
})

it.each(['reload', 'renderer', 'close'] as const)('ignores a reader rejection after %s', async (transition) => {
  const store = createTextStore().create()
  const source = { sessionId: 'session' as SessionId, path: 'report.docx' }
  const tab = 'tab' as TabId
  const lifetime = new AbortController()
  const pending = Promise.withResolvers<RemoteResult<DocumentFileBytes>>()
  let readSignal: AbortSignal | undefined
  const read = vi.fn<ReadDocumentBytes>().mockImplementationOnce((_file, signal) => {
    readSignal = signal
    return pending.promise
  }).mockResolvedValue({ ok: true, value: { absolutePath: '/report.docx', version: 'v1', offset: 0, eof: true, data: new TextEncoder().encode('PDF') } })
  const reader: DocumentPreviewDefinition = { id: 'office', title: () => 'Office', extensions: ['docx'], loading: 'bytes-complete', read }
  const face = textFace(vi.fn(), read)(source.sessionId, store.actions)
  try {
    face.loadAll(tab, source, lifetime.signal, 'v1', reader)
    if (transition === 'reload') face.reloadAll(tab, source, lifetime.signal, 'v1', reader)
    else if (transition === 'renderer') face.loadAll(tab, source, lifetime.signal, 'v1', { ...reader, id: 'other' })
    else lifetime.abort()
    expect(readSignal?.aborted).toBe(true)
    pending.reject(readSignal?.reason)
    await pending.promise.catch(() => {})
    if (transition === 'close') expect(store.getSnapshot().byTab[tab]).toBeUndefined()
    else {
      expect(store.getSnapshot().byTab[tab]?.failure).toBeUndefined()
      expect(new TextDecoder().decode(store.getSnapshot().byTab[tab]?.complete?.data)).toBe('PDF')
    }
  } finally {
    lifetime.abort()
    pending.resolve({ ok: true, value: { absolutePath: '/report.docx', version: 'v1', offset: 0, eof: true, data: new Uint8Array() } })
    await pending.promise.catch(() => {})
  }
})

it.each([new Error('conversion connection closed'), 'conversion connection closed'])('reports an active reader rejection (%s) as a Remote failure', async (failure) => {
  const store = createTextStore().create()
  const source = { sessionId: 'session' as SessionId, path: 'report.docx' }
  const tab = 'tab' as TabId
  const lifetime = new AbortController()
  const pending = Promise.withResolvers<RemoteResult<DocumentFileBytes>>()
  const reader: DocumentPreviewDefinition = {
    id: 'office', title: () => 'Office', extensions: ['docx'], loading: 'bytes-complete', read: () => pending.promise,
  }
  try {
    textFace(vi.fn(), vi.fn())(source.sessionId, store.actions).loadAll(tab, source, lifetime.signal, 'v1', reader)
    pending.reject(failure)
    await pending.promise.catch(() => {})
    expect(store.getSnapshot().byTab[tab]).toMatchObject({
      loading: false, failure: { code: 'gateway/internal', message: 'conversion connection closed', cause: failure },
    })
  } finally {
    lifetime.abort()
    pending.resolve({ ok: true, value: { absolutePath: '/report.docx', version: 'v1', offset: 0, eof: true, data: new Uint8Array() } })
    await pending.promise.catch(() => {})
  }
})
