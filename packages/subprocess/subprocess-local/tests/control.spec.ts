import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { SUBPROCESS_CONTROL_ENV } from '@deepseek-ai/dsh-subprocess/control'
import { LocalSubprocessRuntime } from '../src/index.ts'

const fixture = fileURLToPath(new URL('./fixtures/control-child.ts', import.meta.url))
const helper = fileURLToPath(new URL('../../subprocess/src/control.ts', import.meta.url))
let ctx: Context | undefined
let root: string | undefined
let handle: SubprocessHandle | undefined

afterEach(async () => {
  handle?.control?.destroy()
  await ctx?.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
  handle = undefined
})

describe('managed subprocess control pipe', () => {
  it('closes the caller endpoint when service disposal terminates an active program', async () => {
    ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    handle = ctx.subprocess.spawn({
      argv: [process.execPath, '--input-type=module', '-e',
        'import { Socket } from "node:net"; const c = new Socket({fd:7,readable:true,writable:true}); c.write("ready"); setInterval(()=>{},60000)'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 }, control: 'pipe' },
      graceMs: 1000,
    })
    const channel = handle.control
    if (channel === undefined) throw new Error('requested control pipe is absent')
    await once(channel, 'data')
    await ctx.fiber.dispose()
    expect(channel.destroyed).toBe(true)
    expect(await handle.waitForExit()).toBe(true)
  })

  it('leaves the channel absent on an ordinary spawn', async () => {
    ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    handle = ctx.subprocess.spawn({
      argv: [process.execPath, '-e', 'process.stdout.write("plain")'],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 32 } },
      graceMs: 1000,
    })
    expect(handle.control).toBeUndefined()
    expect(await handle.done).toEqual({ exitCode: 0, signal: null })
    expect(handle.collected.stdout?.readFrom(0).text).toBe('plain')
    expect(await handle.waitForExit()).toBe(true)
  })

  it('returns exact binary control bytes independently of stdout and stderr', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-control-'))
    ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    const input = Buffer.alloc(256 * 1024)
    for (let index = 0; index < input.length; index++) input[index] = index % 256
    handle = ctx.subprocess.spawn({
      argv: [process.execPath, fixture, helper, String(input.length)],
      cwd: root,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 }, control: 'pipe' },
      graceMs: 1000,
    })
    const channel = handle.control
    if (channel === undefined) throw new Error('requested control pipe is absent')
    const received = (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of channel) chunks.push(Buffer.from(chunk as Uint8Array))
      return Buffer.concat(chunks)
    })()
    channel.write(input)
    expect(await received).toEqual(input)
    expect(await handle.done).toEqual({ exitCode: 0, signal: null })
    expect(handle.collected.stdout?.readFrom(0).text).toBe('ordinary stdout\n')
    expect(handle.collected.stderr?.readFrom(0).text).toBe('ordinary stderr\n')
    expect(await handle.waitForExit()).toBe(true)
  })

  it('rejects a caller-authored control marker before starting a child', async () => {
    ctx = new Context()
    await ctx.plugin(LocalSubprocessRuntime)
    expect(() => ctx?.subprocess.spawn({
      argv: [process.execPath, '-e', 'throw new Error("must not execute")'],
      cwd: process.cwd(),
      env: { [SUBPROCESS_CONTROL_ENV]: 'pipe' },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 1000,
    })).toThrow('reserved')
  })
})
