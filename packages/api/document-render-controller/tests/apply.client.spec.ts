/** The document Remote is available only while its Client plugin owns the mount. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'

const descriptor = vi.hoisted(() => ({ package: '@deepseek-ai/dsh-api-document-render-controller', descriptors: [] }))
vi.mock('@deepseek-ai/dsh-api-document-render-controller/remote', () => ({ default: descriptor }))
import * as client from '../src/client/index.ts'

it('waits for the Remote carrier, mounts its descriptor, and joins namespace disposal', async () => {
  const ctx = new Context()
  const released = Promise.withResolvers<undefined>()
  const dispose = vi.fn(() => released.promise)
  const mount = vi.fn(async () => dispose)
  const fiber = ctx.plugin(client)
  try {
    expect(mount).not.toHaveBeenCalled()
    ctx.provide('remote', { $mount: mount } as never)
    await fiber.await()
    expect(mount).toHaveBeenCalledExactlyOnceWith(descriptor)
    let closed = false
    const closing = fiber.dispose().then(() => { closed = true })
    await expect.poll(() => dispose.mock.calls.length).toBe(1)
    expect(closed).toBe(false)
    released.resolve(undefined)
    await closing
    expect(closed).toBe(true)
  } finally { released.resolve(undefined); await fiber.dispose() }
})
