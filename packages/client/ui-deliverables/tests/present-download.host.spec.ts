/** Saved Presented file downloads over the real Connection route and local attachment store. */
import { mkdtemp, rm } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { bridge } from '@deepseek-ai/dsh-client-connection/src/http-bridge.ts'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PresentedFile } from '@deepseek-ai/dsh-tool-present/types'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type { SessionEventReadRequest } from '@deepseek-ai/dsh-session-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerPresentDownload } from '../src/present-download.ts'
import { presentedFileUrl, PRESENT_DOWNLOAD_PATH } from '../src/presented.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-present-download-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LocalAttachmentStore, { dshHome: root })
  const ref = await ctx.attachments.saveFile({ data: Uint8Array.of(80, 75, 0, 255), name: "日记模板('1').docx" })
  const artifact: PresentedFile = { ...ref, path: 'deleted/日记模板.docx' }
  const readEvent = vi.fn(async (request: SessionEventReadRequest) => {
    if (request.sessionId !== 'owner') throw new SessionQueryError('missing', 'SESSION_QUERY_SESSION_NOT_FOUND')
    if (request.seq !== 7) throw new SessionQueryError('missing', 'SESSION_QUERY_EVENT_NOT_FOUND')
    return { target: { type: 'deliverables/presented', data: { turn: 1, callId: 'present-call', files: [artifact] } } as SessionEvent }
  })
  ctx.provide('sessionQuery', { readEvent } as never)
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin({ inject: ['connection', 'sessionQuery', 'attachments'], apply: registerPresentDownload })
  await fiber
  const fetch = (query = '?sessionId=owner&seq=7&index=0', signal?: AbortSignal) => connection
    .createSharedFetchHandler('/api').fetch(new Request(`http://localhost${PRESENT_DOWNLOAD_PATH}${query}`, { signal: signal ?? null }))
  return { ctx, fiber, artifact, readEvent, fetch, handler: connection.createSharedFetchHandler('/api') }
}

describe('Presented file download route', () => {
  it('downloads the saved bytes with a Unicode filename without opening the workspace path', async () => {
    const { fetch, fiber } = await fixture()
    const response = await fetch()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''%E6%97%A5%E8%AE%B0%E6%A8%A1%E6%9D%BF%28%271%27%29.docx")
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(80, 75, 0, 255))
    expect(presentedFileUrl(SessionId('owner'), 7, 0)).toBe(`${PRESENT_DOWNLOAD_PATH}?sessionId=owner&seq=7&index=0`)
    await fiber.dispose()
    expect((await fetch()).status).toBe(404)
  })

  it.each(['correct', 'smaller', 'zero', 'larger'] as const)('finishes HTTP downloads only after integrity verification: %s length', async (length) => {
    const { ctx, artifact, handler } = await fixture()
    const data = new Uint8Array(131072).fill(65)
    Object.assign(artifact, await ctx.attachments.saveFile({ data, name: 'data.bin' }))
    if (length !== 'correct') artifact.bytes = length === 'smaller' ? 1 : length === 'zero' ? 0 : data.byteLength + 1
    const errors: unknown[] = []
    const requests = new Set<Promise<void>>()
    const server = createServer((req, res) => {
      const pending = bridge(req, res, handler).catch((error: unknown) => {
        errors.push(error)
        res.destroy()
      }).finally(() => { requests.delete(pending) })
      requests.add(pending)
    })
    cleanups.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
        server.closeAllConnections()
      })
      await Promise.all(requests)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener')
    const download = async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}${PRESENT_DOWNLOAD_PATH}?sessionId=owner&seq=7&index=0`)
      return new Uint8Array(await response.arrayBuffer())
    }
    if (length === 'correct') {
      expect(await download()).toEqual(data)
      expect(errors).toEqual([])
    } else {
      await expect(download()).rejects.toThrow()
      expect(errors).toEqual([expect.objectContaining({ code: 'ATTACHMENT_CORRUPT' })])
    }
  })

  it.each(['', '?seq=7&index=0', '?sessionId=owner&index=0', '?sessionId=owner&seq=7',
    '?sessionId=owner&seq=-1&index=0', '?sessionId=owner&seq=7&index=0.1',
    '?sessionId=owner&seq=9007199254740992&index=0', '?sessionId=owner&seq=7&index=9007199254740992',
  ])('rejects invalid coordinates before reading: %s', async (query) => {
    const { fetch, readEvent } = await fixture()
    expect((await fetch(query)).status).toBe(400)
    expect(readEvent).not.toHaveBeenCalled()
  })

  it('refuses unrelated Sessions, absent events, and undeclared Presented file indices', async () => {
    const { fetch, readEvent } = await fixture()
    expect((await fetch('?sessionId=other&seq=7&index=0')).status).toBe(404)
    expect((await fetch('?sessionId=owner&seq=8&index=0')).status).toBe(404)
    expect((await fetch('?sessionId=owner&seq=7&index=1')).status).toBe(404)
    readEvent.mockResolvedValueOnce({ target: { type: 'turn/start' } as SessionEvent })
    expect((await fetch()).status).toBe(404)
    readEvent.mockResolvedValueOnce({ target: { type: 'tool/result', data: {} } as SessionEvent })
    expect((await fetch()).status).toBe(404)
  })

  it('reports an absent snapshot and query failures without leaking Host paths', async () => {
    const { fetch, artifact, readEvent } = await fixture()
    artifact.attachmentId = AttachmentId(`sha256:${'0'.repeat(64)}`)
    expect((await fetch()).status).toBe(404)
    readEvent.mockRejectedValueOnce(new Error('/private/host/path'))
    const response = await fetch()
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('/private/host/path')
    readEvent.mockRejectedValueOnce(new SessionQueryError('corrupt', 'SESSION_QUERY_CORRUPT_SESSION'))
    expect((await fetch()).status).toBe(500)
  })

  it.each([null, { name: 4 }, 'invalid'])('returns 404 for a malformed recorded Presented file: %j', async (artifact) => {
    const { ctx, fetch, readEvent } = await fixture()
    const data: unknown = JSON.parse(JSON.stringify({ type: 'deliverables/presented', data: { turn: 1, callId: 'present-call', files: [artifact] } }))
    readEvent.mockResolvedValueOnce({ target: data as SessionEvent })
    const read = vi.spyOn(ctx.attachments, 'readFileStream')
    expect((await fetch()).status).toBe(404)
    expect(read).not.toHaveBeenCalled()
  })

  it.each([null, [], 'invalid', {}, { turn: 1, callId: 'call', files: null }])('returns 404 for malformed delivery data: %j', async (data) => {
    const { ctx, fetch, readEvent } = await fixture()
    readEvent.mockResolvedValueOnce({ target: { type: 'deliverables/presented', data } as unknown as SessionEvent })
    const read = vi.spyOn(ctx.attachments, 'readFileStream')
    expect((await fetch()).status).toBe(404)
    expect(read).not.toHaveBeenCalled()
  })

  it('closes the provider iterator on browser cancellation, even before the first browser read', async () => {
    const { ctx, fetch } = await fixture()
    const returned = Promise.withResolvers<undefined>()
    const stop = vi.fn(async () => { returned.resolve(undefined); return { done: true as const, value: undefined } })
    vi.spyOn(ctx.attachments, 'readFileStream').mockReturnValue({
      [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false, value: new Uint8Array(65536) }), return: stop }),
    })
    const response = await fetch()
    await response.body!.cancel()
    await returned.promise
    expect(stop).toHaveBeenCalledOnce()
  })

  it('delivers an empty saved file and reports a corrupt snapshot as a server failure', async () => {
    const { ctx, fetch, artifact } = await fixture()
    Object.assign(artifact, await ctx.attachments.saveFile({ data: new Uint8Array(), name: 'empty.txt' }))
    const empty = await fetch()
    expect(empty.status).toBe(200)
    expect(await empty.text()).toBe('')
    vi.spyOn(ctx.attachments, 'readFileStream').mockImplementation(async function* () {
      throw new AttachmentError('corrupt', 'ATTACHMENT_CORRUPT')
    })
    expect((await fetch()).status).toBe(500)
  })

  it('propagates cancellation while authorizing the download', async () => {
    const { readEvent, fetch } = await fixture()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    readEvent.mockRejectedValueOnce(controller.signal.reason)
    await expect(fetch(undefined, controller.signal)).rejects.toThrow('cancelled')
  })

  it('fails the response stream if stored-byte integrity verification fails', async () => {
    const { ctx, fetch } = await fixture()
    vi.spyOn(ctx.attachments, 'readFileStream').mockImplementation(async function* () {
      yield Uint8Array.of(1)
      throw new AttachmentError('corrupt', 'ATTACHMENT_CORRUPT')
    })
    const response = await fetch()
    await expect(response.arrayBuffer()).rejects.toThrow('corrupt')
  })
})
