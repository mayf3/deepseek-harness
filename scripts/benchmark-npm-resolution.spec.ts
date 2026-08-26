import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  benchmarkNpmResolution,
  buildRegistryIndex,
  parseBenchmarkOptions,
  publishWorkspaceRange,
  resolveNpmPackageLock,
  type RegistryIndex,
} from './benchmark-npm-resolution.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeJson(root: string, path: string, value: unknown): void {
  const absolute = join(root, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`)
}

describe('npm resolution benchmark', () => {
  it('parses repeat, timeout, threshold, and ref options', () => {
    expect(parseBenchmarkOptions([])).toEqual({ runs: 1, timeoutMs: 300_000 })
    expect(parseBenchmarkOptions([
      '--runs', '3', '--timeout-ms', '45000', '--max-ms', '20000', '--ref', 'master',
    ])).toEqual({ runs: 3, timeoutMs: 45_000, maxMs: 20_000, ref: 'master' })
    expect(parseBenchmarkOptions(['--', '--runs', '2'])).toEqual({ runs: 2, timeoutMs: 300_000 })
    expect(() => parseBenchmarkOptions(['--runs', '0'])).toThrow('--runs must be a positive integer')
  })

  it('projects workspace protocols to published ranges', () => {
    expect(publishWorkspaceRange('workspace:^', '1.2.3')).toBe('^1.2.3')
    expect(publishWorkspaceRange('workspace:~', '1.2.3')).toBe('~1.2.3')
    expect(publishWorkspaceRange('workspace:*', '1.2.3')).toBe('1.2.3')
    expect(publishWorkspaceRange('^4.0.0', '1.2.3')).toBe('^4.0.0')
  })

  it('combines installed metadata with current publishable workspace fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-npm-registry-index-'))
    roots.push(root)
    writeJson(root, 'node_modules/.pnpm/external@2.0.0/node_modules/external/package.json', {
      name: 'external',
      version: '2.0.0',
      dependencies: { child: '^1.0.0' },
      devDependencies: { ignored: '^1.0.0' },
    })
    writeJson(root, 'apps/cli/package.json', {
      name: '@deepseek-ai/dsh',
      version: '0.1.0',
      dependencies: { '@deepseek-ai/dsh-child': 'workspace:^', external: '^2.0.0' },
      devDependencies: { ignored: 'workspace:^' },
    })
    writeJson(root, 'packages/core/child/package.json', {
      name: '@deepseek-ai/dsh-child',
      version: '0.1.0',
    })

    const index = buildRegistryIndex(root)

    expect(index.get('external')?.get('2.0.0')).toMatchObject({ dependencies: { child: '^1.0.0' } })
    expect(index.get('@deepseek-ai/dsh')?.get('0.1.0')).toEqual({
      name: '@deepseek-ai/dsh',
      version: '0.1.0',
      dependencies: { '@deepseek-ai/dsh-child': '^0.1.0', external: '^2.0.0' },
    })
  })

  it('runs npm against the local registry without requesting an archive', async () => {
    const index: RegistryIndex = new Map([[
      '@deepseek-ai/dsh',
      new Map([['0.1.0', { name: '@deepseek-ai/dsh', version: '0.1.0' }]]),
    ]])
    const result = await benchmarkNpmResolution(index, '0.1.0', 10_000)

    expect(result.durationMs).toBeGreaterThan(0)
    expect(result.registryRequests).toBeGreaterThan(0)
    expect(result.archiveRequests).toBe(0)
    expect(result.unknownPackages).toEqual([])
  })

  it('returns npm placement for two aliased package versions without requesting archives', async () => {
    const index: RegistryIndex = new Map([[
      '@deepseek-ai/dsh',
      new Map([
        ['0.1.0', { name: '@deepseek-ai/dsh', version: '0.1.0' }],
        ['0.2.0', { name: '@deepseek-ai/dsh', version: '0.2.0' }],
      ]),
    ]])

    const result = await resolveNpmPackageLock(index, {
      '@deepseek-ai/dsh': '0.2.0',
      'dsh-previous': 'npm:@deepseek-ai/dsh@0.1.0',
    }, 10_000)

    expect(result.archiveRequests).toBe(0)
    expect(result.packageLock.packages['node_modules/@deepseek-ai/dsh']?.version).toBe('0.2.0')
    expect(result.packageLock.packages['node_modules/dsh-previous']).toMatchObject({
      name: '@deepseek-ai/dsh',
      version: '0.1.0',
    })
  })
})
