/** Watch initialization and asynchronous release at the Chokidar adapter. */
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey } from '@deepseek-ai/dsh-fs'
import * as chokidar from 'chokidar'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocalFileSystem } from '../src/index.ts'

vi.mock('chokidar', async (importOriginal) => {
  const original = await importOriginal<typeof import('chokidar')>()
  return { ...original, watch: vi.fn(original.watch) }
})

afterEach(() => { vi.restoreAllMocks() })

async function setup() {
  const watcher = new chokidar.FSWatcher()
  onTestFinished(() => watcher.close())
  const watch = vi.mocked(chokidar.watch).mockReset().mockReturnValue(watcher)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem)
  const target = { targetKey: FsTargetKey('/workspace/file.txt'), displayPath: 'file.txt' }
  const changed = vi.fn<(error?: Error) => void>()
  const controller = new AbortController()
  onTestFinished(() => { controller.abort() })
  return { watcher, watch, fs: ctx.fs, target, changed, controller }
}

describe('local filesystem watch', () => {
  it('waits for ready, forwards invalidation, and awaits watcher closure', async () => {
    const h = await setup()
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    expect(h.watch).toHaveBeenCalledExactlyOnceWith('/workspace/file.txt', { ignoreInitial: true, depth: 0 })
    let ready = false
    void pending.then(() => { ready = true })
    await Promise.resolve(undefined)
    expect(ready).toBe(false)
    h.watcher.emit('ready')
    const close = await pending
    h.watcher.emit('all', 'change', '/workspace/file.txt')
    expect(h.changed).toHaveBeenCalledExactlyOnceWith()
    const closed = Promise.withResolvers<undefined>()
    onTestFinished(() => { closed.resolve(undefined) })
    const nativeClose = h.watcher.close.bind(h.watcher)
    vi.spyOn(h.watcher, 'close').mockImplementationOnce(async () => { await closed.promise; await nativeClose() })
    const closing = close()
    try {
      expect(h.watcher.closed).toBe(false)
    } finally {
      closed.resolve(undefined)
      await closing
    }
    expect(h.watcher.closed).toBe(true)
  })

  it('rejects an already-cancelled initialization without acquiring a watcher', async () => {
    const h = await setup()
    h.controller.abort()
    await expect(h.fs.watch(h.target, h.changed, h.controller.signal)).rejects.toThrow()
    expect(h.watch).not.toHaveBeenCalled()
  })

  it('closes the acquired watcher when initialization is cancelled', async () => {
    const h = await setup()
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    h.controller.abort()
    await rejected
    expect(h.watcher.closed).toBe(true)
    expect(h.changed).not.toHaveBeenCalled()
  })

  it('reports initialization errors and closes before rejecting', async () => {
    const h = await setup()
    const error = new Error('watch failed')
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toBe(error)
    h.watcher.emit('error', error)
    await rejected
    expect(h.changed).toHaveBeenCalledExactlyOnceWith(error)
    expect(h.watcher.closed).toBe(true)
  })

  it('normalizes watcher errors after initialization', async () => {
    const h = await setup()
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    h.watcher.emit('ready')
    const close = await pending
    const error = new Error('watch failed')
    h.watcher.emit('error', error)
    // EventEmitter callbacks can receive non-Error values from the external watcher.
    h.watcher.emit('error', 'watch unavailable')
    expect(h.changed.mock.calls).toEqual([[error], [new Error('watch unavailable')]])
    await close()
    expect(h.watcher.closed).toBe(true)
  })
})
