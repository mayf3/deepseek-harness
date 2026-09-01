import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { SessionCommandController } from '../src/commands.ts'
import {
  handleSessionFileUploadHttp, registerSessionFileUploadHttp,
} from '../src/file-upload-http.ts'

function request(input: {
  method?: string
  sessionId?: string
  name?: string
  contentType?: string
  body?: Uint8Array
} = {}): Request {
  const query = new URLSearchParams()
  if (input.sessionId !== undefined) query.set('sessionId', input.sessionId)
  if (input.name !== undefined) query.set('name', input.name)
  const suffix = query.size === 0 ? '' : `?${query.toString()}`
  return new Request(`http://host/api/session/uploadFileBinary${suffix}`, {
    method: input.method ?? 'POST',
    headers: input.contentType === undefined ? {} : { 'content-type': input.contentType },
    ...(input.body === undefined ? {} : { body: new Blob([Uint8Array.from(input.body).buffer]) }),
  })
}

function commands(result: unknown): SessionCommandController & {
  uploadFileStream: Mock<SessionCommandController['uploadFileStream']>
  uploadedChunks: Uint8Array[]
} {
  const uploadedChunks: Uint8Array[] = []
  const uploadFileStream = vi.fn<SessionCommandController['uploadFileStream']>(async (input) => {
    for await (const chunk of input.data) uploadedChunks.push(chunk)
    return await result as Awaited<ReturnType<SessionCommandController['uploadFileStream']>>
  })
  return {
    uploadedChunks,
    uploadFileStream,
  } as unknown as SessionCommandController & {
    uploadFileStream: Mock<SessionCommandController['uploadFileStream']>
    uploadedChunks: Uint8Array[]
  }
}

describe('background file upload Fetch route', () => {
  it('registers one authenticated POST route on Connection', async () => {
    const ctx = new Context()
    const register = vi.fn((_route: unknown) => vi.fn(async () => {}))
    ctx.provide('connection', { fetch: { register } } as never)
    registerSessionFileUploadHttp(ctx, commands(Promise.resolve({})))
    await vi.waitFor(() => { expect(register).toHaveBeenCalledOnce() })
    const route = register.mock.calls[0]?.[0] as {
      path: string
      methods: string[]
      requestBody: string
      fetch(request: Request): Promise<Response>
    }
    expect(route.path).toBe('/api/session/uploadFileBinary')
    expect(route.methods).toEqual(['POST'])
    expect(route.requestBody).toBe('streaming')
    expect((await route.fetch(request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).status).toBe(200)
    await ctx.fiber.dispose()
  })

  it('rejects the wrong method, media type, and missing Session id without storing', async () => {
    const controller = commands(Promise.resolve({}))
    const wrongMethod = await handleSessionFileUploadHttp(controller, request({ method: 'GET' }))
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')

    const wrongType = await handleSessionFileUploadHttp(controller, request({ contentType: 'application/json' }))
    expect(wrongType.status).toBe(415)
    expect(await wrongType.text()).toBe('content type must be application/octet-stream')

    const missingSession = await handleSessionFileUploadHttp(
      controller,
      request({ contentType: 'application/octet-stream' }),
    )
    expect(missingSession.status).toBe(400)
    expect(await missingSession.text()).toBe('sessionId is required')
    expect(controller.uploadFileStream).not.toHaveBeenCalled()
  })

  it('stores the request bytes and returns the staged receipt', async () => {
    const value = {
      receiptId: 'receipt-1',
      file: { attachmentId: 'file-1', name: 'large & final.bin', bytes: 4 },
    }
    const controller = commands(Promise.resolve(value))
    const response = await handleSessionFileUploadHttp(controller, request({
      sessionId: 's1',
      name: 'large & final.bin',
      contentType: 'application/octet-stream; charset=binary',
      body: Uint8Array.of(1, 2, 3, 4),
    }))
    expect(controller.uploadFileStream).toHaveBeenCalledOnce()
    const upload = controller.uploadFileStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1', name: 'large & final.bin' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(controller.uploadedChunks).toEqual([Uint8Array.of(1, 2, 3, 4)])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ ok: true, value })
  })

  it('returns business and internal storage failures and keeps an absent name absent', async () => {
    const business = commands(Promise.reject(new RemoteError(
      'session/attachment-invalid', 'denied', { reason: 'NOPE' },
    )))
    const businessResponse = await handleSessionFileUploadHttp(business, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))
    expect(business.uploadFileStream).toHaveBeenCalledOnce()
    const upload = business.uploadFileStream.mock.calls[0]?.[0]
    expect(upload).toMatchObject({ sessionId: 's1' })
    expect(upload?.signal).toBeInstanceOf(AbortSignal)
    expect(business.uploadedChunks).toEqual([])
    expect(await businessResponse.json()).toEqual({
      ok: false,
      error: { code: 'session/attachment-invalid', message: 'denied', details: { reason: 'NOPE' } },
    })

    const internal = commands(Promise.reject(new Error('disk offline')))
    expect(await (await handleSessionFileUploadHttp(internal, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'disk offline', details: {} },
    })

    const foreignError = runInNewContext('new Error("disk exception")') as unknown as Error
    const exception = commands(Promise.reject(foreignError))
    expect(await (await handleSessionFileUploadHttp(exception, request({
      sessionId: 's1', contentType: 'application/octet-stream',
    }))).json()).toEqual({
      ok: false, error: { code: 'gateway/internal', message: 'Error: disk exception', details: {} },
    })
  })
})
