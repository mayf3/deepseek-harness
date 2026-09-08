/** Delivery gestures share pending state, report failures, and cancel with the plugin. */
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { PresentedOpenController } from '../src/client/present-open.ts'

afterEach(() => { vi.unstubAllGlobals() })

const id = SessionId('fork')
const url = '/api/present.open?sessionId=fork&seq=2&index=1'

it('coalesces concurrent card and mention gestures, then allows another open', async () => {
  const reply = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValue(reply.promise)
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  const first = controller.open(id, 2, 1)
  await controller.open(id, 2, 1)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher).toHaveBeenCalledWith(url, { method: 'POST', signal: expect.any(AbortSignal) as AbortSignal })
  expect(controller.state.getSnapshot()[url]).toBe('opening')
  reply.resolve(new Response(null, { status: 204 }))
  await first
  expect(controller.state.getSnapshot()[url]).toBe('opened')
  await controller.open(id, 2, 1)
  expect(fetcher).toHaveBeenCalledTimes(2)
  await controller.dispose()
})

it.each(['http', 'network'])('publishes retryable %s failures', async (failure) => {
  const fetcher = vi.fn()
  if (failure === 'http') fetcher.mockResolvedValueOnce(new Response(null, { status: 500 }))
  else fetcher.mockRejectedValueOnce(new Error('offline'))
  fetcher.mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  await controller.open(id, 2, 1)
  expect(controller.state.getSnapshot()[url]).toBe('error')
  await controller.open(id, 2, 1)
  expect(controller.state.getSnapshot()[url]).toBe('opened')
  await controller.dispose()
})

it('awaits cancellation and prevents late state publication or new requests after disposal', async () => {
  const aborted = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<Response>()
  const fetcher = vi.fn((_url: string, { signal }: RequestInit) => {
    signal!.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
    return release.promise
  })
  vi.stubGlobal('fetch', fetcher)
  const controller = new PresentedOpenController()
  const open = controller.open(id, 2, 1)
  const state = controller.state.getSnapshot()
  let disposed = false
  const disposal = controller.dispose().then(() => { disposed = true })
  await aborted.promise
  expect(disposed).toBe(false)
  release.resolve(new Response(null, { status: 204 }))
  await Promise.all([open, disposal])
  expect(controller.state.getSnapshot()).toBe(state)
  await controller.open(id, 2, 1)
  expect(fetcher).toHaveBeenCalledOnce()
})
