/** Source verifier transport, exit observation, and cancellation ownership. */

import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { spawnSourceVerifier } from '../src/verifier-source-process.ts'

const fork = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ fork }))

afterEach(() => { fork.mockReset() })

function childProcess() {
  const child = Object.assign(new EventEmitter(), { send: vi.fn(), kill: vi.fn() })
  fork.mockReturnValue(child)
  return child
}

it('sends the request to an ESM source process with BigInt-capable IPC', () => {
  const child = childProcess()
  const request = { path: '/stage', expectedId: 'session' }
  const entry = resolve('worker.ts')
  spawnSourceVerifier(pathToFileURL(entry), request)

  expect(fork).toHaveBeenCalledWith(entry, [], {
    execArgv: ['--import', import.meta.resolve('tsx/esm')],
    serialization: 'advanced', stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  expect(child.send).toHaveBeenCalledWith(request)
})

it('forwards response, error, and exit observations', () => {
  const child = childProcess()
  const verifier = spawnSourceVerifier(pathToFileURL(resolve('worker.ts')), {})
  const response = vi.fn()
  const error = vi.fn()
  const exit = vi.fn()
  verifier.once('message', response)
  verifier.once('error', error)
  verifier.once('exit', exit)
  const result = { identity: { ino: 1n } }
  const failure = new Error('spawn failed')
  child.emit('message', result)
  child.emit('error', failure)
  child.emit('exit', 7, null)

  expect(response).toHaveBeenCalledWith(result)
  expect(error).toHaveBeenCalledWith(failure)
  expect(exit).toHaveBeenCalledWith(7, null)
})

it('waits for process closure after requesting termination', async () => {
  const child = childProcess()
  const verifier = spawnSourceVerifier(pathToFileURL(resolve('worker.ts')), {})
  const terminated = verifier.terminate()
  let closed = false
  void terminated.then(() => { closed = true })

  expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  child.emit('exit', null, 'SIGKILL')
  await Promise.resolve()
  expect(closed).toBe(false)
  child.emit('close', null, 'SIGKILL')
  await expect(terminated).resolves.toBeNull()
})

it('keeps a closed process untouched when termination is requested later', async () => {
  const child = childProcess()
  const verifier = spawnSourceVerifier(pathToFileURL(resolve('worker.ts')), {})
  child.emit('close', 0, null)

  await expect(verifier.terminate()).resolves.toBe(0)
  expect(child.kill).not.toHaveBeenCalled()
})
