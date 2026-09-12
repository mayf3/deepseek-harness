/** Production dependency selection and offline catalog freshness regressions. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectDependencies, computeDependencyCatalogOutputs, staleDependencyCatalogPaths } from './gen-dependency-catalog.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

function lockfile() {
  return {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@deepseek-ai/dsh': 'latest' } },
      'node_modules/@deepseek-ai/dsh': {
        version: '1.0.0', dependencies: { library: '^2.0.0', alias: 'npm:original@1.0.0' },
        optionalDependencies: { unavailable: '1.0.0' },
      },
      'node_modules/library': { version: '1.0.0' },
      'node_modules/@deepseek-ai/dsh/node_modules/library': { version: '2.0.0' },
      'node_modules/alias': { name: 'original', version: '1.0.0' },
      'node_modules/plugin': { version: '1.0.0', peerDependencies: { peer: '*' } },
      'node_modules/peer': { version: '3.0.0', peer: true },
      'node_modules/native-linux': { version: '1.0.0', optional: true, os: ['linux'], cpu: ['arm64'], libc: ['glibc'] },
      'node_modules/native-helper': { version: '1.0.0', optional: true, devOptional: true },
      'node_modules/test-only': { version: '1.0.0', dev: true },
    },
  }
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-dependency-catalog-test-'))
  roots.push(root)
  mkdirSync(join(root, 'scripts/dependency-catalog'), { recursive: true })
  writeFileSync(join(root, 'scripts/dependency-catalog/package-lock.json'), JSON.stringify(lockfile()))
  writeFileSync(join(root, 'scripts/dependency-catalog/resolution.json'), JSON.stringify({
    capturedAt: '2026-09-12T00:00:00.000Z', npm: '11.17.0', node: '24.19.0',
    platform: 'darwin', arch: 'arm64', registry: 'https://registry.npmjs.org/',
  }))
  return root
}

describe('published npm dependency catalog', () => {
  it('retains nested versions, aliases, peers, and optional candidates while excluding development-only packages', () => {
    const { version, rows } = collectDependencies(lockfile())
    expect(version).toBe('1.0.0')
    expect(rows).toHaveLength(7)
    expect(rows.filter(row => row.direct).map(row => [row.name, row.version])).toEqual([
      ['library', '2.0.0'], ['original', '1.0.0'],
    ])
    expect(rows.find(row => row.name === 'peer')).toMatchObject({ peer: true, optional: false })
    expect(rows.find(row => row.name === 'native-linux')).toMatchObject({
      optional: true, platforms: 'os: linux; cpu: arm64; libc: glibc',
    })
    expect(rows.find(row => row.name === 'native-helper')).toMatchObject({ optional: true })
    expect(rows.map(row => row.name)).not.toContain('test-only')
    expect(rows.map(row => row.name)).not.toContain('unavailable')
  })

  it('does not silently produce an incomplete catalog from invalid or unrelated resolutions', () => {
    expect(() => collectDependencies({ lockfileVersion: 2 })).toThrow('lockfileVersion 3')
    expect(() => collectDependencies({ lockfileVersion: 3, packages: {} })).toThrow('consumer must be an object')
    const input = lockfile()
    input.packages[''].dependencies['@deepseek-ai/dsh'] = 'next'
    expect(() => collectDependencies(input)).toThrow('must request only @deepseek-ai/dsh@latest')
    const missing = lockfile()
    Reflect.deleteProperty(missing.packages, 'node_modules/alias')
    expect(() => collectDependencies(missing)).toThrow('missing direct dependency alias')
    const linked = lockfile()
    Object.assign(linked.packages['node_modules/library'], { link: true })
    expect(() => collectDependencies(linked)).toThrow('is a local link')
  })

  it('sorts packages independently of lockfile object order and keeps duplicate installation locations', () => {
    const input = lockfile()
    const reordered = { ...input, packages: Object.fromEntries(Object.entries(input.packages).reverse()) }
    expect(collectDependencies(reordered)).toEqual(collectDependencies(input))
    Object.assign(input.packages, { 'node_modules/plugin/node_modules/library': { version: '1.0.0' } })
    expect(collectDependencies(input).rows.filter(row => row.name === 'library' && row.version === '1.0.0')).toHaveLength(2)
  })

  it('rejects missing, edited, or stale translations and pairing records without rewriting them', () => {
    const root = fixture()
    const outputs = computeDependencyCatalogOutputs(root)
    expect(staleDependencyCatalogPaths(root)).toEqual([...outputs.keys()])
    for (const [path, content] of outputs) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    expect(staleDependencyCatalogPaths(root)).toEqual([])
    for (const [path, content] of outputs) {
      writeFileSync(join(root, path), `${content}stale\n`)
      expect(staleDependencyCatalogPaths(root)).toEqual([path])
      expect(readFileSync(join(root, path), 'utf8')).toBe(`${content}stale\n`)
      writeFileSync(join(root, path), content)
    }
    const updated = lockfile()
    updated.packages['node_modules/peer'].version = '3.1.0'
    writeFileSync(join(root, 'scripts/dependency-catalog/package-lock.json'), JSON.stringify(updated))
    expect(staleDependencyCatalogPaths(root)).toEqual([...outputs.keys()])
  })

  it('keeps the checked-in catalog synchronized with its recorded npm resolution', () => {
    expect(staleDependencyCatalogPaths(resolve(import.meta.dirname, '..'))).toEqual([])
  })
})
