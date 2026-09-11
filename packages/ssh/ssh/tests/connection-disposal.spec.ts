import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SshRpcPeer } from '../src/protocol.ts'
import { SshConnection } from '../src/index.ts'

const transport = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn(), connect: vi.fn(), tlsConnect: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: transport.spawn,
  execFile: transport.execFile,
}))
vi.mock('node:net', async importOriginal => ({
  ...await importOriginal<typeof import('node:net')>(),
  createConnection: transport.connect,
}))

vi.mock('node:tls', async importOriginal => ({
  ...await importOriginal<typeof import('node:tls')>(),
  connect: transport.tlsConnect,
}))

class PendingSocket extends Duplex {
  override _read(): void {}
  override _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback()
  }

  disableRenegotiation(): void {}
}

class HelperChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private stopped = false

  kill(): boolean {
    if (!this.stopped) {
      this.stopped = true
      queueMicrotask(() => { this.emit('close', 0, null) })
    }
    return true
  }
}

async function setup(phase: 'connect' | 'authenticate') {
  const child = new HelperChild()
  const helper = new SshRpcPeer(child.stdin, child.stdout, 4096, 8, async (method) => {
    if (method === 'close' || method === 'heartbeat') return null
    if (method !== 'hello') throw new Error(`unexpected helper operation: ${method}`)
    return { protocol: 1, hash: 'a'.repeat(64), platform: 'linux', nodeVersion: 'v24.19.0', node: '/usr/bin/node', root: '/tmp/remote-helper', workspace: '/workspace' }
  })
  const rawSocket = new PendingSocket()
  const secureSocket = new PendingSocket()
  const authenticating = Promise.withResolvers<undefined>()
  const allocated = Promise.withResolvers<undefined>()
  transport.spawn.mockReturnValue(child)
  transport.execFile.mockImplementation((
    _file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void,
  ) => {
    queueMicrotask(() => { callback(null, '', '') })
  })
  transport.connect.mockImplementation(() => {
    allocated.resolve(undefined)
    if (phase === 'authenticate') queueMicrotask(() => { rawSocket.emit('connect') })
    return rawSocket
  })
  transport.tlsConnect.mockImplementation(() => {
    rawSocket.on('error', (error) => { secureSocket.destroy(error) })
    rawSocket.once('close', () => { secureSocket.destroy() })
    secureSocket.once('close', () => { rawSocket.destroy() })
    authenticating.resolve(undefined)
    return secureSocket
  })
  const socket = phase === 'connect' ? rawSocket : secureSocket
  const ctx = new Context()
  const fiber = ctx.plugin(SshConnection, {
    host: 'hermetic-test', node: '/usr/bin/node', helper: '/opt/dsh/helper.js', helperHash: 'a'.repeat(64), workspace: '/workspace',
    requestTimeoutMs: 10_000, maxFrameBytes: 4096, maxPending: 8, leaseMs: 30_000,
  })
  onTestFinished(async () => {
    rawSocket.destroy()
    secureSocket.destroy()
    helper.close()
    child.stderr.destroy()
    child.kill()
    await fiber.dispose()
    vi.clearAllMocks()
  })
  await fiber
  const pending = ctx.ssh.connectStream({ path: '/tmp/remote-helper/control', capability: 'b'.repeat(64) })
  const observed = pending.then(value => ({ value }), error => ({ error: error as unknown }))
  await allocated.promise
  if (phase === 'authenticate') await authenticating.promise
  return { service: ctx.ssh, socket, observed }
}

describe.skipIf(process.platform === 'win32')('SSH stream establishment disposal', () => {
  it.each(['connect', 'authenticate'] as const)('rejects a close-only socket while awaiting %s', async (phase) => {
    const { socket, observed } = await setup(phase)
    const errors: Error[] = []
    socket.on('error', (error) => { errors.push(error) })
    socket.destroy()
    const result = await observed
    expect(result).toHaveProperty('error')
    expect(String('error' in result ? result.error : '')).toMatch(/closed|lost|refused/)
    expect(errors).toEqual([])
    expect(socket.listenerCount('connect')).toBe(0)
    expect(socket.listenerCount('data')).toBe(0)
    expect(socket.listenerCount('end')).toBe(0)
    expect(socket.listenerCount('secureConnect')).toBe(0)
  })

  it.each(['connect', 'authenticate'] as const)('settles establishment when the connection is disposed during %s', async (phase) => {
    const { service, socket, observed } = await setup(phase)
    await service.dispose()
    const result = await observed
    expect(result).toHaveProperty('error')
    expect(String('error' in result ? result.error : '')).toMatch(/closed|lost|refused/)
    expect(socket.destroyed).toBe(true)
    expect(socket.listenerCount('connect')).toBe(0)
    expect(socket.listenerCount('data')).toBe(0)
    expect(socket.listenerCount('end')).toBe(0)
    expect(socket.listenerCount('secureConnect')).toBe(0)
  })
})
