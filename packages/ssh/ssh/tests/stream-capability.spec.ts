import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { RemoteProcesses } from '../src/helper-processes.ts'
import type { SshStreamEndpoint } from '../src/schemas.ts'
import { authenticateStream } from '../src/stream-security.ts'

async function connect(endpoint: SshStreamEndpoint, capability: string): Promise<Socket> {
  const socket = createConnection(endpoint.path)
  socket.on('error', () => {})
  await once(socket, 'connect')
  return authenticateStream(socket, capability, 5000)
}

describe.skipIf(process.platform === 'win32')('SSH stream capabilities', () => {
  it('refuses another endpoint capability without consuming the legitimate reservation', async () => {
    const root = await mkdtemp('/tmp/dsh-ssh-auth-')
    const processes = new RemoteProcesses(new Context(), root, 4, 5000)
    const sockets: Socket[] = []
    try {
      const prepared = await processes.prepare({
        argv: ['true'], cwd: root, graceMs: 100,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' },
      })
      const control = prepared.streams.control!
      await expect(connect(control, prepared.streams.stderr!.capability)).rejects.toThrow()
      const legitimate = await connect(control, control.capability)
      sockets.push(legitimate)
      expect(legitimate.destroyed).toBe(false)
      expect(control.capability).not.toBe(prepared.streams.stdout!.capability)
      expect(control.capability).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      for (const socket of sockets) socket.destroy()
      await processes.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not treat administrative-looking bytes as a helper request on a data listener', async () => {
    const root = await mkdtemp('/tmp/dsh-ssh-auth-')
    const processes = new RemoteProcesses(new Context(), root, 4, 5000)
    let socket: Socket | undefined
    try {
      const prepared = await processes.prepare({
        argv: ['true'], cwd: root, graceMs: 100,
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      })
      socket = createConnection(prepared.streams.stdout!.path)
      socket.on('error', () => {})
      await once(socket, 'connect')
      const closed = once(socket, 'close')
      socket.end(Buffer.from('{"type":"request","method":"process.start","id":"forged","params":{}}'))
      await closed
      const legitimate = await connect(prepared.streams.stdout!, prepared.streams.stdout!.capability)
      socket = legitimate
      expect(legitimate.destroyed).toBe(false)
    } finally {
      socket?.destroy()
      await processes.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
