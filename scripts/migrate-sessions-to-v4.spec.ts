/** The contributor command uses real persistence on private temporary corpora. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import type { SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { encodeSegment, generationLogFilename, type JsonlCompression } from '../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../packages/session/session-persistence-jsonl/src/zstd.ts'
import { runMigrationJobs } from './migrate-sessions-to-v4.ts'

const repository = resolve(import.meta.dirname, '..')
const script = join(repository, 'scripts/migrate-sessions-to-v4.ts')
const directories = new Set<string>()
const stopProcesses: Array<() => Promise<void>> = []

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-migrate-v4-test-'))
  directories.add(directory)
  return directory
}

async function runAt(entrypoint: string, ...args: string[]) {
  const child = execa(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
    cwd: repository, reject: false,
  })
  stopProcesses.push(async () => { child.kill('SIGKILL'); await child })
  const result = await child
  const logPath = [...result.stdout.matchAll(/^Full log: (.+)$/gmu)].at(-1)?.[1]
  if (logPath !== undefined) directories.add(dirname(logPath))
  expect(result.timedOut, result.stderr).toBe(false)
  expect(result.signal, result.stderr).toBeUndefined()
  return { stdout: result.stdout, stderr: result.stderr, status: result.exitCode, logPath }
}

function run(...args: string[]) {
  return runAt(script, ...args)
}

afterEach(async () => {
  await Promise.all(stopProcesses.splice(0).map(stop => stop()))
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.clear()
})

const toolTurn: readonly SessionFormatJsonObject[] = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'request/header', data: { reason: 'initial', header: { config: { provider: 'mock', model: 'mock' } } } },
  { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: {
    id: 'assistant', role: 'assistant', source: { kind: 'model', provider: 'mock', model: 'mock' },
    content: [{ type: 'tool-call', id: 'call', name: 'read', arguments: '{}' }],
  } } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call', name: 'read', arguments: '{}' } },
  { type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: {
    id: 'result', role: 'user', source: { kind: 'tool', callId: 'call' },
    content: [{ type: 'tool-result', toolCallId: 'call', isError: false, content: [{ type: 'text', text: 'saved output' }] }],
  } } },
  { type: 'step/end', data: { turn: 1, step: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]

async function fixture(
  root: string, id: string, version: number, compression: JsonlCompression, events: readonly SessionFormatJsonObject[] = [],
  headerFields: SessionFormatJsonObject = {},
) {
  const directory = join(root, '_no-cwd', encodeSegment(id))
  await mkdir(directory, { recursive: true })
  const header = JSON.stringify({ type: 'session', version, id, createdAt: 1, delegationDepth: 0,
    ...version >= 2 ? { isSeeded: false } : {},
    ...headerFields,
  }) + '\n'
  const body = events.map((event, seq) => JSON.stringify({ ...event, seq, time: seq + 2 }) + '\n').join('')
  const bytes = compression === 'none' ? Buffer.from(header + body) : Buffer.concat([
    await compressZstdFrame(header), ...body === '' ? [] : [await compressZstdFrame(body)],
  ])
  const path = join(directory, generationLogFilename(version, compression))
  await writeFile(path, bytes)
  return { path, bytes, directory }
}

describe('one-time V4 migration command', () => {
  it('bounds active jobs and retries changed-source inputs only after the initial pass drains', async () => {
    const entered = Array.from({ length: 4 }, () => Promise.withResolvers<undefined>())
    const release = Array.from({ length: 4 }, () => Promise.withResolvers<undefined>())
    const initial: number[] = []
    const retries: number[] = []
    let active = 0
    let peak = 0
    const task = runMigrationJobs(4, 2, async (index, retry) => {
      if (retry) {
        expect(active).toBe(0)
        expect(initial.toSorted()).toEqual([0, 1, 2, 3])
        retries.push(index)
        return false
      }
      active += 1
      peak = Math.max(peak, active)
      entered[index]!.resolve(undefined)
      await release[index]!.promise
      active -= 1
      initial.push(index)
      return index === 0
    })
    try {
      await Promise.all([entered[0]!.promise, entered[1]!.promise])
      expect(active).toBe(2)
      release[1]!.resolve(undefined)
      await entered[2]!.promise
      expect(active).toBe(2)
      release[0]!.resolve(undefined)
      await entered[3]!.promise
      expect(active).toBe(2)
      expect(retries).toEqual([])
      release[2]!.resolve(undefined)
      release[3]!.resolve(undefined)
      await task
      expect(peak).toBe(2)
      expect(retries).toEqual([0])
    } finally {
      for (const barrier of release) barrier.resolve(undefined)
      await task
    }
  })

  it('runs each input to completion before starting the next with one job', async () => {
    const order: string[] = []
    await runMigrationJobs(3, 1, async (index, retry) => {
      expect(retry).toBe(false)
      order.push(`start ${index}`)
      await Promise.resolve()
      order.push(`end ${index}`)
      return false
    })
    expect(order).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2'])
  })

  it('drains ten thousand immediate inputs without exceeding the worker limit', async () => {
    const visits = new Uint8Array(10_000)
    let active = 0
    let peak = 0
    await runMigrationJobs(visits.length, 16, async (index, retry) => {
      expect(retry).toBe(false)
      visits[index]! += 1
      active += 1
      peak = Math.max(peak, active)
      await Promise.resolve()
      active -= 1
      return false
    })
    expect(visits.every(count => count === 1)).toBe(true)
    expect(peak).toBe(16)
    expect(active).toBe(0)
  })

  it.each(['none', 'zstd'] as const)('publishes %s successors, preserves sources and current bytes on rerun', async (compression) => {
    const root = temporaryRoot()
    const old = await fixture(root, 'old', 0, compression)
    const older = await fixture(root, 'tool/session~名', 0, compression)
    const source = await fixture(root, 'tool/session~名', 3, compression, toolTurn)
    const current = await fixture(root, 'current', 4, compression)
    await mkdir(join(root, '_no-cwd', 'empty'))
    const first = await run('--sessions-dir', root)
    expect(first.status, first.stdout + first.stderr).toBe(0)
    expect(first.stdout).toContain(`Session jobs: ${Math.min(availableParallelism(), 16)}`)
    expect(first.stdout).toContain('converted=2, already-V4=1, failed=0, skipped=1')
    expect(first.stdout).toContain('START session.v3.jsonl')
    expect(first.stdout).toContain('V3 -> V4: session.v4.jsonl')
    const target = join(source.directory, generationLogFilename(4, compression))
    const targetBytes = await readFile(target)
    const decoded = compression === 'none' ? targetBytes : Buffer.concat(await Promise.all(
      scanZstdFrames(targetBytes).frames.map(frame => decompressZstdFrame(targetBytes.subarray(frame.start, frame.end))),
    ))
    expect(decoded.toString()).toContain('"role":"tool"')
    expect(decoded.toString()).toContain('"text":"saved output"')
    expect(decoded.toString()).not.toContain('"type":"tool-result"')
    const second = await run('--sessions-dir', root)
    expect(second.status, second.stdout + second.stderr).toBe(0)
    expect(second.stdout).toContain('converted=0, already-V4=3, failed=0, skipped=1')
    expect(await readFile(target)).toEqual(targetBytes)
    for (const original of [old, older, source, current]) expect(await readFile(original.path)).toEqual(original.bytes)
    expect(first.logPath).toBeDefined()
    const log = readFileSync(first.logPath!, 'utf8')
    expect(log).toContain('Git HEAD: ')
    expect(log).toContain(`Node: ${process.version}; platform: ${process.platform}/${process.arch}`)
    expect(log).toContain(first.stdout.trim())
    if (process.platform !== 'win32') expect(statSync(first.logPath!).mode & 0o777).toBe(0o600)
  })

  it.each(['none', 'zstd'] as const)('preserves %s parent/child history and catalog with serial or parallel jobs', async (compression) => {
    const outputs: Buffer[][] = []
    for (const jobs of [1, 2]) {
      const root = temporaryRoot()
      const parent = await fixture(root, 'a-parent', 3, compression)
      const child = await fixture(root, 'z-child', 3, compression, [
        { type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'saved child' } },
      ], { origin: 'subagent', parentSession: 'a-parent', createdAt: 2, delegationDepth: 1 })
      const result = await run('--sessions-dir', root, '--jobs', String(jobs))
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('converted=2, already-V4=0, failed=0, skipped=0')
      expect(result.stdout).toContain('completed=2/2')
      const current: Buffer[] = []
      for (const original of [parent, child]) {
        expect(await readFile(original.path)).toEqual(original.bytes)
        const bytes = await readFile(join(original.directory, generationLogFilename(4, compression)))
        const decoded = compression === 'none' ? bytes : Buffer.concat(await Promise.all(
          scanZstdFrames(bytes).frames.map(frame => decompressZstdFrame(bytes.subarray(frame.start, frame.end))),
        ))
        current.push(decoded)
      }
      expect(current[0]!.toString().trim().split('\n').slice(1).map(line => JSON.parse(line) as unknown)).toMatchObject([
        { type: 'subagent/catalog', data: { childId: 'z-child', childCreatedAt: 2, mode: 'continuable', label: 'saved child' } },
      ])
      outputs.push(current)
    }
    expect(outputs[1]).toEqual(outputs[0])
  })

  it('reports a bad Session and still migrates a later good Session', async () => {
    const root = temporaryRoot()
    const bad = await fixture(root, 'a-bad', 3, 'none', [{ type: 'unrecognized/required', data: {} }])
    const good = await fixture(root, 'z-good', 3, 'none', toolTurn)
    const result = await run('--sessions-dir', root)
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stdout, readFileSync(result.logPath!, 'utf8')).toContain('converted=1, already-V4=0, failed=1, skipped=0')
    expect(result.stdout).toMatch(/\[1\/2\].*FAILED/u)
    expect(result.stdout).toMatch(/\[2\/2\].*V3 -> V4/u)
    expect(result.stdout).not.toContain('DEFERRED')
    expect(result.stdout).not.toContain('RETRY')
    expect(result.stdout).toContain('Failures (full stacks and causes are in the log):')
    expect(result.stdout).toContain(bad.path)
    expect(readFileSync(result.logPath!, 'utf8')).toContain('unrecognized/required')
    expect(await readFile(bad.path)).toEqual(bad.bytes)
    expect(existsSync(join(bad.directory, 'session.v4.jsonl'))).toBe(false)
    expect(existsSync(join(good.directory, 'session.v4.jsonl'))).toBe(true)
  })

  it('opens an existing V4 torn tail without repairing its bytes', async () => {
    const root = temporaryRoot()
    const current = await fixture(root, 'current', 4, 'none')
    const torn = Buffer.concat([current.bytes, Buffer.from('{"unfinished"')])
    await writeFile(current.path, torn)
    const result = await run('--sessions-dir', root)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('already V4 (opened successfully)')
    expect(await readFile(current.path)).toEqual(torn)
  })

  it('reports unsupported root-level logs and does not traverse directory links', async () => {
    const root = temporaryRoot()
    const outside = temporaryRoot()
    const original = await fixture(outside, 'outside', 3, 'none')
    await writeFile(join(root, 'legacy.jsonl'), original.bytes)
    await symlink(outside, join(root, 'linked-project'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await run('--sessions-dir', root)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('unsupported flat-file layout')
    expect(result.stdout).toContain('project symbolic links are not traversed')
    expect(existsSync(join(original.directory, 'session.v4.jsonl'))).toBe(false)
  })

  it('shows help, rejects unknown arguments, and logs a missing root failure', async () => {
    const help = await run('--help')
    expect(help.stdout).toContain('Defaults to ~/.dsh/sessions')
    expect(help.stdout).toContain('CPU count capped at 16')
    expect((await run('--unknown')).status).toBe(1)
    const result = await run('--sessions-dir', join(temporaryRoot(), 'missing'))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('converted=0, already-V4=0, failed=1, skipped=0')
    expect(result.logPath).toBeDefined()
  })

  it('accepts an explicit job count above the default cap', async () => {
    const result = await run('--sessions-dir', temporaryRoot(), '--jobs', '32')
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('Session jobs: 32')
    expect(result.stdout).toContain('converted=0, already-V4=0, failed=0, skipped=0')
  })

  it('runs the entrypoint through a symbolic link to the checkout', async () => {
    const checkout = join(temporaryRoot(), 'checkout')
    await symlink(repository, checkout, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      const result = await runAt(join(checkout, 'scripts/migrate-sessions-to-v4.ts'), '--help')
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('Usage: pnpm run migrate:sessions-to-v4')
    } finally {
      await unlink(checkout)
    }
  })

  it.each(['0', '-1', '1.5', 'NaN', '9007199254740992'])('rejects invalid --jobs %s before opening a corpus', async (jobs) => {
    const result = await run('--sessions-dir', join(temporaryRoot(), 'missing'), `--jobs=${jobs}`)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--jobs must be a positive safe integer')
    expect(result.stdout).not.toContain('Session migration')
    expect(result.logPath).toBeUndefined()
  })
})
