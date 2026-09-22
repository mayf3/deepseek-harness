/** Real Git transport deadlines, process cleanup, and bounded connection diagnostics. */
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as subprocess from 'execa'
import { expect, it, onTestFinished, vi } from 'vitest'
import { checkGithubConnection } from '../src/github-connection.ts'
import { parseInstallSpec } from '../src/install-spec.ts'

vi.mock('execa', async (original) => {
  const module = await original<typeof import('execa')>()
  return { ...module, execa: vi.fn(module.execa) }
})

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-github-check-'))
  onTestFinished(() => rm(dir, { recursive: true, force: true }))
  const controller = new AbortController()
  const tasks: Promise<unknown>[] = []
  onTestFinished(async () => { controller.abort(); await Promise.allSettled(tasks) })
  const config = join(dir, 'git.config')
  await writeFile(config, '')
  const check = (spec: string, timeoutMs = 3000, outputBytes = 4096) => {
    const task = checkGithubConnection(parseInstallSpec(spec), dir, {
      timeoutMs, outputBytes, signal: controller.signal,
      env: { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' },
    })
    tasks.push(task)
    return task
  }
  return { dir, config, controller, check }
}

async function proxy(config: string, fail: boolean) {
  const sockets = new Set<Socket>()
  const connected = Promise.withResolvers<undefined>()
  const disconnected = Promise.withResolvers<undefined>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => { sockets.delete(socket); disconnected.resolve(undefined) })
    socket.once('data', () => { connected.resolve(undefined); if (fail) socket.destroy() })
  })
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('proxy did not bind a TCP port')
  await writeFile(config, `[http "https://github.com/"]\n proxy = http://127.0.0.1:${String(address.port)}\n`)
  return { connected: connected.promise, disconnected: disconnected.promise, sockets }
}

it('leaves registry packages and other Git hosts to the installer', async () => {
  const { check, dir } = await fixture()
  expect(await check('@acme/plugin')).toBeUndefined()
  expect(await check('https://gitlab.com/acme/plugin.git')).toBeUndefined()
  await expect(readFile(join(dir, '.plugin-manager', 'logs'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([
  ['https://github.com/acme/plugin.git#main', 'https://github.com/'],
  ['github:acme/plugin#main', 'https://github.com/'],
  ['git+https://github.com/acme/plugin.git#main', 'https://github.com/'],
  ['git+ssh://git@github.com:22/acme/plugin.git#main', 'ssh://git@github.com:22/'],
  ['git@github.com:acme/plugin.git#main', 'git@github.com:'],
  ['gist:acme/plugin#main', 'https://gist.github.com/'],
])('checks %s through the profile Git configuration without downloading a package', async (spec, prefix) => {
  const { check, dir, config } = await fixture()
  const repository = join(dir, 'empty.git')
  await subprocess.execa('git', ['init', '--bare', repository])
  // Match both forms exactly; a fragment reaching Git would fail to resolve this repository.
  await writeFile(config, `[url "${pathToFileURL(repository).href}"]\n insteadOf = ${prefix}acme/plugin.git\n insteadOf = ${prefix}acme/plugin\n`)
  expect(await check(spec)).toBeUndefined()
})

it('reports an immediate transport failure without waiting for the deadline', async () => {
  const { check, config } = await fixture()
  const transport = await proxy(config, true)
  const result = await check('https://github.com/acme/plugin.git')
  await transport.connected
  expect(result).toMatchObject({ exitCode: 128, kind: 'network', truncated: false })
  expect(await readFile(result!.logPath, 'utf8')).toBe(result!.output)
  await transport.disconnected
  expect(transport.sockets.size).toBe(0)
})

it('ends a silent proxy connection and its Git child at the connection deadline', async () => {
  const { check, config } = await fixture()
  const transport = await proxy(config, false)
  const running = check('https://github.com/acme/plugin.git')
  await transport.connected
  const result = await running
  expect(result?.kind).toBe('timeout')
  expect(result!.output).toContain('connection to github.com timed out after 3000ms')
  await transport.disconnected
  expect(transport.sockets.size).toBe(0)
})

it('cancels a connected Git probe and closes its transport before the deadline', async () => {
  const { check, config, controller } = await fixture()
  const transport = await proxy(config, false)
  const running = check('https://github.com/acme/plugin.git', 60000)
  await transport.connected
  controller.abort()
  const result = await running
  expect(result?.kind).toBe('unknown')
  await transport.disconnected
  expect(transport.sockets.size).toBe(0)
})

it.each([undefined, 'Git could not start'])('retains a diagnostic when Git writes no stderr (%s)', async (shortMessage) => {
  const { check } = await fixture()
  const run = vi.spyOn(subprocess, 'execa').mockResolvedValue({ failed: true, shortMessage } as Awaited<ReturnType<typeof subprocess.execa>>)
  onTestFinished(() => run.mockRestore())
  const result = await check('github:acme/plugin')
  expect(result).toMatchObject({ exitCode: 1, kind: 'unknown', output: shortMessage ?? 'GitHub connection check failed' })
  expect(await readFile(result!.logPath, 'utf8')).toBe(result!.output)
})

it('bounds returned diagnostics while retaining Git stderr in the operation log', async () => {
  const { check } = await fixture()
  const run = vi.spyOn(subprocess, 'execa').mockImplementation((...args: unknown[]) => {
    const options = args[2] as { stderr: { file: string } }
    appendFileSync(options.stderr.file, '0123456789')
    return Promise.resolve({ failed: true, exitCode: 128 }) as ReturnType<typeof subprocess.execa>
  })
  onTestFinished(() => run.mockRestore())
  const result = await check('github:acme/plugin', 3000, 4)
  expect(result).toMatchObject({ output: '6789', truncated: true })
  expect(await readFile(result!.logPath, 'utf8')).toBe('0123456789')
})
