import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PACKAGE_DEPENDENCY_POLICY,
  type PackageDependencyPolicy,
} from './package-dependency-policy.ts'
import {
  collectPackageDependencyViolations,
  discoverPackageDependencyScope,
  fixPackageDependencies,
  formatManagedRuntimeDependencies,
  readPackageDependencyFacts,
  repairPackageDependencyManifest,
  type PackageDependencyFacts,
  type PackageDependencyManifest,
  type WorkspacePackageManifest,
} from './verify-package-dependencies.ts'

const CORDIS = '@deepseek-ai/cordis'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function pkg(
  name: string,
  manifestPath: string,
  manifest: Partial<PackageDependencyManifest> = {},
): WorkspacePackageManifest {
  return {
    name,
    manifestPath,
    dir: dirname(manifestPath),
    manifest: { name, ...manifest },
  }
}

function policy(fields: Partial<PackageDependencyPolicy> = {}): PackageDependencyPolicy {
  return {
    clientFaceInclude: [],
    clientFaceExclude: [],
    hostPackages: [],
    ...fields,
  }
}

function facts(manifest: PackageDependencyManifest): PackageDependencyFacts {
  return {
    manifestPath: 'packages/core/probe/package.json',
    role: 'configured-host',
    manifest,
    workspaceNames: new Set([
      CORDIS,
      '@deepseek-ai/dsh-runtime',
      '@deepseek-ai/dsh-types',
      '@deepseek-ai/dsh-stale',
      '@deepseek-ai/schemastery',
    ]),
    allSourceUses: new Map([
      ['@deepseek-ai/dsh-runtime', ['packages/core/probe/src/index.ts']],
      ['@deepseek-ai/dsh-types', ['packages/core/probe/src/types.ts']],
    ]),
    hostRuntimeSourceUses: new Map([
      ['@deepseek-ai/dsh-runtime', ['packages/core/probe/src/index.ts']],
    ]),
    clientInject: new Set(),
  }
}

describe('package dependency scope', () => {
  it('keeps the measured Host relay roster explicit', () => {
    expect(PACKAGE_DEPENDENCY_POLICY.clientFaceExclude).toEqual([
      '@deepseek-ai/dsh-api-session-controller',
    ])
    expect(PACKAGE_DEPENDENCY_POLICY.hostPackages).toEqual([
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-session',
    ])
  })

  it('discovers the Client directory, dsh.client declarations, and configured Host packages', () => {
    const packages = [
      pkg('@f/static', 'packages/client/static/package.json'),
      pkg('@f/dynamic-client', 'packages/client/dynamic/package.json', { dsh: { client: {} } }),
      pkg('@f/dual', 'packages/api/dual/package.json', { dsh: { client: {} } }),
      pkg('@f/export-only', 'packages/api/export-only/package.json', { exports: { './client': './lib/client.js' } }),
      pkg('@f/forced-client', 'packages/api/forced/package.json'),
      pkg('@f/excluded', 'packages/api/excluded/package.json', { dsh: { client: {} } }),
      pkg('@f/host', 'packages/core/host/package.json'),
    ]

    const found = discoverPackageDependencyScope(packages, policy({
      clientFaceInclude: ['@f/forced-client'],
      clientFaceExclude: ['@f/excluded'],
      hostPackages: ['@f/host'],
    }))

    expect(found.violations).toEqual([])
    expect(found.selected.map(item => [item.name, item.role])).toEqual([
      ['@f/dual', 'client-host'],
      ['@f/forced-client', 'client-host'],
      ['@f/dynamic-client', 'client-host'],
      ['@f/static', 'client-host'],
      ['@f/host', 'configured-host'],
    ])
  })

  it('rejects stale, redundant, overlapping, and unknown configuration', () => {
    const packages = [
      pkg('@f/client', 'packages/client/client/package.json'),
      pkg('@f/dual', 'packages/api/dual/package.json', { dsh: { client: {} } }),
      pkg('@f/host', 'packages/core/host/package.json'),
    ]
    const found = discoverPackageDependencyScope(packages, policy({
      clientFaceInclude: ['@f/dual', '@f/missing', '@f/host'],
      clientFaceExclude: ['@f/client', '@f/host', '@f/missing'],
      hostPackages: ['@f/dual'],
    }))

    expect(found.violations).toEqual(expect.arrayContaining([
      expect.stringContaining('clientFaceInclude redundantly names automatically discovered package @f/dual'),
      expect.stringContaining('@f/host appears in both clientFaceInclude and clientFaceExclude'),
      expect.stringContaining('clientFaceExclude cannot exempt packages/client package @f/client'),
      expect.stringContaining('clientFaceExclude names @f/host, which declares no dsh.client entry'),
      expect.stringContaining('hostPackages redundantly names Client-faced package @f/dual'),
      expect.stringContaining('unknown release package @f/missing'),
    ]))
  })
})

describe('face-aware source classification', () => {
  it('counts Host values as dependencies and Client values as development inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-package-faces-'))
    roots.push(root)
    const subject = pkg('@f/dual', 'packages/g/dual/package.json', {
      dsh: { client: { inject: ['@f/injected'] } },
    })
    const files = {
      'packages/g/dual/src/index.ts': [
        "import { value } from '@f/runtime'",
        "import type { Shared } from '@f/types'",
        "export { nested } from './nested.ts'",
      ].join('\n'),
      'packages/g/dual/src/nested.ts': "export { nested } from '@f/nested'",
      'packages/g/dual/src/client/index.ts': "import { browser } from '@f/browser'",
    }
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), source)
    }

    const found = readPackageDependencyFacts(root, subject, 'client-host', new Set([
      CORDIS, '@f/runtime', '@f/types', '@f/nested', '@f/browser', '@f/injected',
    ]))

    expect([...found.hostRuntimeSourceUses.keys()].sort()).toEqual(['@f/nested', '@f/runtime'])
    expect([...found.allSourceUses.keys()].sort()).toEqual(['@f/browser', '@f/nested', '@f/runtime', '@f/types'])
  })
})

describe('dependency sections', () => {
  it('accepts Host dependencies, development-only inputs, and shared Cordis', () => {
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-probe',
      dependencies: {
        '@deepseek-ai/dsh-runtime': 'workspace:^',
        '@deepseek-ai/schemastery': 'workspace:^',
        external: '^1.0.0',
      },
      devDependencies: {
        '@deepseek-ai/dsh-types': 'workspace:^',
        [CORDIS]: 'workspace:^',
      },
      peerDependencies: { [CORDIS]: 'workspace:^' },
    }
    expect(collectPackageDependencyViolations({
      facts: [facts(manifest)], packages: [], policyViolations: [], workspaceNames: facts(manifest).workspaceNames,
    })).toEqual([])
  })

  it('lists managed Host runtime dependencies for fix review', () => {
    const subject = facts({ name: '@deepseek-ai/dsh-probe' })
    expect(formatManagedRuntimeDependencies({
      facts: [subject], packages: [], policyViolations: [], workspaceNames: subject.workspaceNames,
    })).toEqual([
      'verify-package-dependencies: 1 managed Host runtime dependency edge(s) remain in dependencies across 1 package(s):',
      '  @deepseek-ai/dsh-probe: @deepseek-ai/dsh-runtime',
    ])
  })

  it('reports wrong sections, workspace ranges, and stale peer metadata', () => {
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-probe',
      dependencies: { '@deepseek-ai/dsh-types': 'workspace:*' },
      devDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-runtime': 'workspace:^' },
      peerDependencies: { [CORDIS]: 'workspace:*', '@deepseek-ai/dsh-runtime': 'workspace:^' },
      peerDependenciesMeta: { '@deepseek-ai/dsh-missing': { optional: true } },
    }
    const state = {
      facts: [facts(manifest)], packages: [], policyViolations: [], workspaceNames: facts(manifest).workspaceNames,
    }
    const violations = collectPackageDependencyViolations(state)
    expect(violations).toEqual(expect.arrayContaining([
      expect.stringContaining('@deepseek-ai/dsh-runtime'),
      expect.stringContaining('@deepseek-ai/dsh-types'),
      expect.stringContaining(`${CORDIS} must be matching peerDependencies + devDependencies`),
      expect.stringContaining('dependencies.@deepseek-ai/dsh-types must use workspace:^'),
      expect.stringContaining('peerDependenciesMeta.@deepseek-ai/dsh-missing has no matching'),
    ]))
  })

  it('repairs owned relationships without changing unrelated dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-package-dependencies-'))
    roots.push(root)
    const manifestPath = 'package.json'
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-probe',
      dependencies: { '@deepseek-ai/schemastery': 'workspace:*', external: '^1.0.0' },
      devDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-runtime': 'workspace:^' },
      peerDependencies: {
        [CORDIS]: 'workspace:^',
        '@deepseek-ai/dsh-runtime': 'workspace:^',
        '@deepseek-ai/dsh-stale': 'workspace:^',
      },
      peerDependenciesMeta: { '@deepseek-ai/dsh-stale': { optional: true } },
    }
    writeFileSync(join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`)
    const subject = { ...facts(manifest), manifestPath }
    const state = { facts: [subject], packages: [], policyViolations: [], workspaceNames: subject.workspaceNames }

    expect(fixPackageDependencies(root, state)).toEqual([manifestPath])
    const fixed = JSON.parse(readFileSync(join(root, manifestPath), 'utf8')) as PackageDependencyManifest
    expect(fixed.dependencies).toEqual({
      '@deepseek-ai/schemastery': 'workspace:^',
      external: '^1.0.0',
      '@deepseek-ai/dsh-runtime': 'workspace:^',
    })
    expect(fixed.devDependencies).toEqual({
      [CORDIS]: 'workspace:^',
      '@deepseek-ai/dsh-types': 'workspace:^',
      '@deepseek-ai/dsh-stale': 'workspace:^',
    })
    expect(fixed.peerDependencies).toEqual({ [CORDIS]: 'workspace:^' })
    expect(fixed.peerDependenciesMeta).toBeUndefined()
  })

  it('repairs an in-memory manifest for benchmark simulation', () => {
    const manifest: PackageDependencyManifest = {
      name: '@deepseek-ai/dsh-probe',
      peerDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-runtime': 'workspace:^' },
      devDependencies: { [CORDIS]: 'workspace:^', '@deepseek-ai/dsh-runtime': 'workspace:^' },
    }
    repairPackageDependencyManifest(facts(manifest))
    expect(manifest.dependencies).toEqual({ '@deepseek-ai/dsh-runtime': 'workspace:^' })
    expect(manifest.peerDependencies).toEqual({ [CORDIS]: 'workspace:^' })
  })
})
