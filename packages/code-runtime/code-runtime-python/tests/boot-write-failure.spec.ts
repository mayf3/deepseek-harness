import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'

/**
 * A synchronous `proto.write` throw on the fd-3 pipe is the one boot path a real
 * subprocess cannot be coerced into from a test: the pipe accepts queued bytes
 * until the kernel buffer fills, and a same-tick EPIPE needs fd 3 already closed
 * before the first write. `spawn` is mocked so fd 3 throws on the boot frame,
 * which is exactly the branch that regressed. The mock is confined to this file
 * so the real-subprocess suite in runtime.spec.ts is untouched.
 */
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}))

const { PythonCodeRuntime } = await import('../src/index.ts')

/** A `child_process.ChildProcess` stand-in whose fd-3 pipe rejects every write. */
function fakeChildWithThrowingFd3(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number
    stdout: PassThrough
    stderr: PassThrough
    stdio: unknown[]
  }
  // Leave `pid` absent: `finish()` still runs its `clearTimeout(wallTimer)` /
  // `removeEventListener(onAbort)` prologue (the TDZ site) before short-
  // circuiting on `child.pid === undefined` to `settle` instead of waiting on a
  // `close` this fake never emits, so the run resolves promptly.
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  // A duplex whose `write` throws synchronously, standing in for an fd-3 pipe
  // that fails the moment the boot frame is issued.
  const proto = new PassThrough()
  proto.write = () => { throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' }) }
  child.stdio = [new PassThrough(), child.stdout, child.stderr, proto]
  return child
}

afterEach(() => {
  spawnMock.mockReset()
})

describe('PythonCodeRuntime — boot-write failure', () => {
  it('resolves a worker-exit when the fd-3 boot write throws (no TDZ ReferenceError)', async () => {
    // Before the fix, the boot-write block ran BEFORE `wallTimer`, `onAbort`,
    // and `live` were initialized, so its `finish()` (which clears `wallTimer`,
    // removes `onAbort`, and — through `settle` — deletes `live`) hit the
    // temporal dead zone and threw a ReferenceError. That escaped the Promise
    // executor and REJECTED run() instead of resolving the worker-exit the catch
    // constructs. This test would see that rejection; the fix makes it resolve.
    spawnMock.mockImplementation(() => fakeChildWithThrowingFd3())
    const ctx = new Context()
    const fiber = await ctx.plugin(PythonCodeRuntime)
    const runtime = ctx.codeRuntime as InstanceType<typeof PythonCodeRuntime>

    const result = await runtime.run({ program: 'return 1', bindings: [] })

    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('failed to boot python subprocess')
    await fiber.dispose()
  })
})
