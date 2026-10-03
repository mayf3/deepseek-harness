/** npm channel selection, collision prevention, and immutable-artifact retries. */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { attempt, attemptEchoed, type CommandResult } from './process.ts'
import { publishRelease } from './publish.ts'
import { packedIdentity, readPublishOrder } from './tarball.ts'

vi.mock('./process.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./process.ts')>(),
  attempt: vi.fn(),
  attemptEchoed: vi.fn(),
  isEntry: () => false,
}))

vi.mock('./tarball.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./tarball.ts')>(),
  packedIdentity: vi.fn(),
  readPublishOrder: vi.fn(),
}))

vi.mock('node:timers/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:timers/promises')>(),
  setTimeout: vi.fn(),
}))

const CHANNEL = 'dsh-0-2-1-alpha-1'
const ABSENT: CommandResult = { status: 1, stdout: '', stderr: 'npm error code E404' }
const SUCCESS: CommandResult = { status: 0, stdout: '', stderr: '' }

interface PackedFixture {
  readonly name: string
  readonly version: string
  readonly path: string
  readonly integrity: string
}

function packedRelease(versions: readonly string[]): { directory: string; packages: PackedFixture[] } {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-publish-channel-'))
  onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
  const packages = versions.map((version, index) => {
    const name = `@deepseek-ai/release-fixture-${String(index)}`
    const path = join(directory, `${String(index)}.tgz`)
    const bytes = Buffer.from(`${name}@${version}\n`)
    writeFileSync(path, bytes)
    return {
      name,
      version,
      path,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    }
  })
  vi.mocked(readPublishOrder).mockReturnValue(packages.map((_, index) => `${String(index)}.tgz`))
  vi.mocked(packedIdentity).mockImplementation((path) => {
    const entry = packages.find(entry => entry.path === path)
    if (entry === undefined) throw new Error(`Unexpected tarball ${path}`)
    return { name: entry.name, version: entry.version }
  })
  return { directory, packages }
}

function registry(
  tags: ReadonlyMap<string, unknown> = new Map(),
  integrities: ReadonlyMap<string, string> = new Map(),
): void {
  vi.mocked(attempt).mockImplementation((command, args) => {
    expect(command).toBe('npm')
    expect(args).toHaveLength(4)
    expect(args[0]).toBe('view')
    expect(args[3]).toBe('--json')
    const selector = args[1]
    if (selector === undefined) throw new Error('Missing npm view selector')
    if (args[2] === 'dist-tags') {
      if (!tags.has(selector)) return ABSENT
      return { ...SUCCESS, stdout: JSON.stringify(tags.get(selector)) }
    }
    if (args[2] === 'dist.integrity') {
      const integrity = integrities.get(selector)
      return integrity === undefined ? ABSENT : { ...SUCCESS, stdout: JSON.stringify(integrity) }
    }
    throw new Error(`Unexpected npm view field ${String(args[2])}`)
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(attemptEchoed).mockReturnValue(SUCCESS)
  vi.mocked(sleep).mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('release publication channels', () => {
  it.each([
    ['vendor', '1.0.6', undefined],
    ['vendor', '1.0.6-alpha.1', 'next'],
    ['dsh', '0.2.1', undefined],
    ['dsh', '0.2.1-alpha.1', 'alpha'],
    ['dsh', '0.2.1-canary.1', 'canary'],
    ['dsh', '0.2.1-rc.1', 'next'],
  ] as const)('uses the default %s channel for %s when no override is supplied', async (family, version, tag) => {
    const fixture = packedRelease([version])
    const [entry] = fixture.packages
    expect(entry).toBeDefined()
    registry()

    await publishRelease(family, fixture.directory)

    expect(attempt).toHaveBeenCalledExactlyOnceWith('npm', ['view', `${entry!.name}@${version}`, 'dist.integrity', '--json'])
    expect(attemptEchoed).toHaveBeenCalledExactlyOnceWith('npm', [
      'publish', entry!.path, ...tag === undefined ? [] : ['--tag', tag],
    ])
  })

  it('checks every custom channel before publishing in the recorded order', async () => {
    const fixture = packedRelease(['1.0.6-alpha.1', '4.0.5-alpha.1'])
    const [first, second] = fixture.packages
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    registry(new Map([[first!.name, { latest: '1.0.5', next: '1.0.5-rc.1' }]]))
    vi.mocked(attemptEchoed).mockImplementation(() => {
      expect(vi.mocked(attempt).mock.calls.filter(([, args]) => args[2] === 'dist-tags')).toEqual([
        ['npm', ['view', first!.name, 'dist-tags', '--json']],
        ['npm', ['view', second!.name, 'dist-tags', '--json']],
      ])
      return SUCCESS
    })

    await publishRelease('vendor', fixture.directory, CHANNEL)

    expect(vi.mocked(attemptEchoed).mock.calls).toEqual(fixture.packages.map(entry => [
      'npm', ['publish', entry.path, '--tag', CHANNEL],
    ]))
  })

  it('uses an explicit channel instead of the dsh prerelease default', async () => {
    const fixture = packedRelease(['0.2.1-alpha.1'])
    registry()

    await publishRelease('dsh', fixture.directory, CHANNEL)

    expect(attemptEchoed).toHaveBeenCalledExactlyOnceWith('npm', ['publish', fixture.packages[0]!.path, '--tag', CHANNEL])
  })

  it.each(['', ' ', ' next', '-release-preview', 'release/channel', '1.2.3', '^1.2', 'v1', 'x'])(
    'rejects invalid channel %j before reading artifacts or querying npm',
    async (tag) => {
      await expect(publishRelease('vendor', '/unused-release-artifacts', tag)).rejects.toThrow()

      expect(readPublishOrder).not.toHaveBeenCalled()
      expect(packedIdentity).not.toHaveBeenCalled()
      expect(attempt).not.toHaveBeenCalled()
      expect(attemptEchoed).not.toHaveBeenCalled()
    },
  )

  it('stops before publishing when a later package already assigns the custom channel elsewhere', async () => {
    const fixture = packedRelease(['1.0.6-alpha.1', '4.0.5-alpha.1'])
    const [first, second] = fixture.packages
    registry(new Map([
      [first!.name, {}],
      [second!.name, { [CHANNEL]: '4.0.4' }],
    ]))

    await expect(publishRelease('vendor', fixture.directory, CHANNEL)).rejects.toThrow()

    expect(vi.mocked(attempt).mock.calls).toEqual([
      ['npm', ['view', first!.name, 'dist-tags', '--json']],
      ['npm', ['view', second!.name, 'dist-tags', '--json']],
    ])
    expect(attemptEchoed).not.toHaveBeenCalled()
  })

  it.each([null, [], 'not an object', { [CHANNEL]: 42 }])('rejects malformed registry channels %j before publishing', async (payload) => {
    const fixture = packedRelease(['1.0.6-alpha.1'])
    registry(new Map([[fixture.packages[0]!.name, payload]]))

    await expect(publishRelease('vendor', fixture.directory, CHANNEL)).rejects.toThrow()

    expect(attemptEchoed).not.toHaveBeenCalled()
  })

  it('stops on a registry authorization failure before publishing', async () => {
    const fixture = packedRelease(['1.0.6-alpha.1'])
    vi.mocked(attempt).mockReturnValue({ status: 1, stdout: '', stderr: 'npm error code E403' })

    await expect(publishRelease('vendor', fixture.directory, CHANNEL)).rejects.toThrow(/E403/u)

    expect(attemptEchoed).not.toHaveBeenCalled()
  })

  it('skips an identical artifact when the custom channel already names its version', async () => {
    const fixture = packedRelease(['1.0.6-alpha.1'])
    const entry = fixture.packages[0]!
    registry(
      new Map([[entry.name, { [CHANNEL]: entry.version }]]),
      new Map([[`${entry.name}@${entry.version}`, entry.integrity]]),
    )

    await publishRelease('vendor', fixture.directory, CHANNEL)

    expect(attemptEchoed).not.toHaveBeenCalled()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('leaves an absent custom channel unchanged when the identical version is already published', async () => {
    const fixture = packedRelease(['1.0.6-alpha.1'])
    const entry = fixture.packages[0]!
    registry(new Map([[entry.name, {}]]), new Map([[`${entry.name}@${entry.version}`, entry.integrity]]))

    await publishRelease('vendor', fixture.directory, CHANNEL)

    expect(attemptEchoed).not.toHaveBeenCalled()
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('rejects different bytes already published at the requested version', async () => {
    const fixture = packedRelease(['1.0.6-alpha.1'])
    const entry = fixture.packages[0]!
    registry(
      new Map([[entry.name, { [CHANNEL]: entry.version }]]),
      new Map([[`${entry.name}@${entry.version}`, 'sha512-different']]),
    )

    await expect(publishRelease('vendor', fixture.directory, CHANNEL)).rejects.toThrow('already published with different content')

    expect(attemptEchoed).not.toHaveBeenCalled()
  })
})
