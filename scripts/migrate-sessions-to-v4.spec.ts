/** The contributor command uses real persistence on private temporary corpora. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execa } from 'execa'
import type { SessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { encodeSegment, generationLogFilename, type JsonlCompression } from '../packages/session/session-persistence-jsonl/src/format.ts'
import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../packages/session/session-persistence-jsonl/src/zstd.ts'

const repository = resolve(import.meta.dirname, '..')
const script = join(repository, 'scripts/migrate-sessions-to-v4.ts')
const directories = new Set<string>()
const stopProcesses: Array<() => Promise<void>> = []

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-migrate-v4-test-'))
  directories.add(directory)
  return directory
}

async function run(...args: string[]) {
  const child = execa(process.execPath, ['--import', 'tsx', script, ...args], {
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
) {
  const directory = join(root, '_no-cwd', encodeSegment(id))
  await mkdir(directory, { recursive: true })
  const header = JSON.stringify({ type: 'session', version, id, createdAt: 1, delegationDepth: 0,
    ...version >= 2 ? { isSeeded: false } : {},
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
  it.each(['none', 'zstd'] as const)('publishes %s successors, preserves sources and current bytes on rerun', async (compression) => {
    const root = temporaryRoot()
    const old = await fixture(root, 'old', 0, compression)
    const older = await fixture(root, 'tool/session~名', 0, compression)
    const source = await fixture(root, 'tool/session~名', 3, compression, toolTurn)
    const current = await fixture(root, 'current', 4, compression)
    await mkdir(join(root, '_no-cwd', 'empty'))
    const first = await run('--sessions-dir', root)
    expect(first.status, first.stdout + first.stderr).toBe(0)
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

  it('reports a bad Session and still migrates a later good Session', async () => {
    const root = temporaryRoot()
    const bad = await fixture(root, 'a-bad', 3, 'none', [{ type: 'unrecognized/required', data: {} }])
    const good = await fixture(root, 'z-good', 3, 'none', toolTurn)
    const result = await run('--sessions-dir', root)
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stdout, readFileSync(result.logPath!, 'utf8')).toContain('converted=1, already-V4=0, failed=1, skipped=0')
    expect(result.stdout).toMatch(/\[1\/2\][\s\S]*FAILED[\s\S]*\[2\/2\][\s\S]*V3 -> V4/u)
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
    expect((await run('--help')).stdout).toContain('Defaults to ~/.dsh/sessions')
    expect((await run('--unknown')).status).toBe(1)
    const result = await run('--sessions-dir', join(temporaryRoot(), 'missing'))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('converted=0, already-V4=0, failed=1, skipped=0')
    expect(result.logPath).toBeDefined()
  })
})
