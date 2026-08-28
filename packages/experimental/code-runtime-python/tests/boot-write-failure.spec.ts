import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
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

/** A child whose fd-3 pipe accepts the boot write, then rejects the run write. */
function fakeChildWithAckThenThrowingFd3(): EventEmitter {
  const child = new EventEmitter() as EventEmitter & {
    pid?: number
    stdout: PassThrough
    stderr: PassThrough
    stdio: unknown[]
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const proto = new PassThrough()
  let writes = 0
  proto.write = () => {
    writes += 1
    if (writes === 1) return true // The boot frame goes out.
    throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' })
  }
  child.stdio = [new PassThrough(), child.stdout, child.stderr, proto]
  // Emit the boot-ack after the boot write, so the run-frame write fires and
  // hits the throwing pipe.
  setImmediate(() => proto.emit('data', Buffer.from('{"type":"boot-ack"}\n')))
  return child
}

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

  it('resolves a worker-exit and removes the staging dir when spawn throws synchronously', async () => {
    // `spawn` can throw same-tick — EMFILE on a descriptor-exhausted host, or a
    // libuv-level failure — before the Promise executor and its settlement path
    // exist. Left uncaught it rejected run() (the seam permits rejection only for
    // misuse) and stranded the staging directory materializePyScripts had just
    // written, which only settle() removes. The fix catches it, unlinks the
    // directory, and resolves the same `worker-exit` class as an async ENOENT.
    //
    // Capture THIS run's exact staging dir from the argv the mocked spawn
    // received (`['-I', <dir>/bootstrap.py]`) and assert only that path is gone.
    // A tmpdir scan — even a set difference against a pre-run snapshot — would
    // flake under vitest's forks pool: a sibling worker creating its own
    // `dsh-code-runtime-python-*` dir in the window reads as a leak here. Keying
    // off our own argv is fully isolated from concurrent staging.
    let stagedBootstrap: string | undefined
    spawnMock.mockImplementation((_bin: string, args: string[]) => {
      stagedBootstrap = args[args.length - 1]
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
    })
    const ctx = new Context()
    const fiber = await ctx.plugin(PythonCodeRuntime)
    const runtime = ctx.codeRuntime as InstanceType<typeof PythonCodeRuntime>

    const result = await runtime.run({ program: 'return 1', bindings: [] })

    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('python spawn error')
    expect(stagedBootstrap).toBeDefined()
    expect(existsSync(dirname(stagedBootstrap as string))).toBe(false)
    await fiber.dispose()
  })

  it('resolves a worker-exit when the run write after boot-ack throws', async () => {
    // The run frame goes out from the boot-ack handler; a pipe that accepts
    // the boot frame but rejects the run write must settle the run as a
    // worker-exit rather than reject run() or leave it hanging.
    spawnMock.mockImplementation(() => fakeChildWithAckThenThrowingFd3())
    const ctx = new Context()
    const fiber = await ctx.plugin(PythonCodeRuntime)
    const runtime = ctx.codeRuntime as InstanceType<typeof PythonCodeRuntime>

    const result = await runtime.run({ program: 'return 1', bindings: [] })

    expect(result.error?.kind).toBe('worker-exit')
    expect(result.error?.message).toContain('failed to boot python subprocess')
    await fiber.dispose()
  })
})
