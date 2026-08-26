// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { HistoricalImageCache } from '../src/client/conversation/historical-images.ts'

describe('HistoricalImageCache', () => {
  it('invalidates a pending image load when its Session binding is released', async () => {
    const read = Promise.withResolvers<Awaited<ReturnType<SessionFace['readAttachment']>>>()
    const runtime = await SlotTestRuntime.create()
    const sessionId = await runtime.sessions.add({
      id: 's1',
      session: { readAttachment: () => read.promise },
    })
    const cache = new HistoricalImageCache(runtime.ctx, runtime.ctx.sessions)
    const attachment = {
      attachmentId: AttachmentId('image-1'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    } as const

    const pending = cache.resolve(sessionId, attachment)
    await runtime.sessions.remove(sessionId)
    read.resolve({ ok: true, value: { attachment, data: Uint8Array.of(1) } })

    await expect(pending).rejects.toThrow('ui-conversation image scope was released before loading completed')
    await runtime.dispose()
  })

  it('adopts a seeded URL, reuses it for later resolves, and revokes it with the Session scope', async () => {
    const revoked: string[] = []
    const originalRevoke = URL.revokeObjectURL.bind(URL)
    URL.revokeObjectURL = (url: string) => { revoked.push(url) }
    try {
      const runtime = await SlotTestRuntime.create()
      const sessionId = await runtime.sessions.add({ id: 's1', session: {} })
      const cache = new HistoricalImageCache(runtime.ctx, runtime.ctx.sessions)
      const attachment = {
        attachmentId: AttachmentId('image-seeded'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
      } as const

      expect(cache.seed(sessionId, attachment, 'blob:seeded')).toBe(true)
      // Ownership is exclusive: a second seed of the same reference refuses,
      // and resolve() serves the adopted URL without a byte round-trip.
      expect(cache.seed(sessionId, attachment, 'blob:duplicate')).toBe(false)
      await expect(cache.resolve(sessionId, attachment)).resolves.toBe('blob:seeded')

      await runtime.sessions.remove(sessionId)
      await Promise.resolve()
      expect(revoked).toContain('blob:seeded')
      await runtime.dispose()
    } finally {
      URL.revokeObjectURL = originalRevoke
    }
  })

  it('refuses to seed for an unknown session', async () => {
    const runtime = await SlotTestRuntime.create()
    const cache = new HistoricalImageCache(runtime.ctx, runtime.ctx.sessions)
    const attachment = {
      attachmentId: AttachmentId('image-unknown'), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    } as const
    expect(cache.seed('missing' as never, attachment, 'blob:orphan')).toBe(false)
    await runtime.dispose()
  })
})
