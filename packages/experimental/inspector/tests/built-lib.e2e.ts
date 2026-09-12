import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, onTestFinished } from 'vitest'
import { pnpmInvocation } from '../../../../scripts/pnpm-invocation.ts'

const packageDirectory = fileURLToPath(new URL('..', import.meta.url))
const built = [
  'lib/index.js',
  'node_modules/@deepseek-ai/schemastery/lib/index.mjs',
].every(file => existsSync(join(packageDirectory, file)))

describe.skipIf(!built)('experimental Inspector built artifact', () => {
  it('packs its sibling Worker and evaluates the Host from the tarball through plain Node', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-inspector-packed-'))
    const consumer = join(root, 'package')
    const dependencies = join(consumer, 'node_modules')
    let linked = false
    onTestFinished(async () => {
      if (linked) await unlink(dependencies)
      await rm(root, { recursive: true, force: true })
    })
    const invocation = pnpmInvocation(['pack', '--pack-destination', root])
    await execa(invocation.command, invocation.args, { cwd: packageDirectory, timeout: test.task.timeout })
    const archives = (await readdir(root)).filter(name => name.endsWith('.tgz'))
    expect(archives).toHaveLength(1)
    await execa('tar', ['-xzf', join(root, archives[0]!), '-C', root], { timeout: test.task.timeout })
    expect(existsSync(join(consumer, 'lib/worker.js'))).toBe(true)
    await symlink(join(packageDirectory, 'node_modules'), dependencies, process.platform === 'win32' ? 'junction' : 'dir')
    linked = true
    const script = `
      const { startInspector } = await import('@deepseek-ai/dsh-experimental-inspector')
      const { default: WebSocket } = await import('ws')
      globalThis.__builtInspectorProbe = 42
      const inspector = await startInspector({ port: 0, captureFetch: false, startupTimeoutMs: ${String(test.task.timeout)} })
      const socket = new WebSocket(inspector.endpoint.webSocketDebuggerUrl)
      try {
        await new Promise((resolve, reject) => {
          socket.once('open', resolve)
          socket.once('error', reject)
        })
        const response = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('CDP response timeout')), 5000)
          socket.on('message', data => {
            const message = JSON.parse(Buffer.from(data).toString('utf8'))
            if (message.id !== 1) return
            clearTimeout(timer)
            resolve(message)
          })
        })
        socket.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression: 'globalThis.__builtInspectorProbe', returnByValue: true },
        }))
        const message = await response
        console.log(JSON.stringify(message.result.result))
      } finally {
        socket.terminate()
        await inspector.close()
      }
    `
    const result = await execa(process.execPath, ['--input-type=module', '-e', script], {
      cwd: consumer,
      stdin: 'ignore',
      timeout: test.task.timeout,
      killSignal: 'SIGKILL',
      reject: false,
    })

    expect(result.timedOut, `stderr:\n${result.stderr}`).toBe(false)
    expect(result.signal, `stderr:\n${result.stderr}`).toBeUndefined()
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0)
    expect(JSON.parse(result.stdout.trim()) as unknown).toEqual({ type: 'number', value: 42, description: '42' })
  })
})
