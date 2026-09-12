/** Source, installation, and composition regressions for default-product isolation. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyDefaultProductIsolation } from './verify-default-product-isolation.ts'

const roots: string[] = []
const experimental = '@deepseek-ai/dsh-experimental-prototype'
const core = '@deepseek-ai/dsh-core'
const base = '@deepseek-ai/dsh-base'
const profile = 'packages/boot/app-boot/src/profile.ts'
const preset = 'packages/preset/agent-presets/presets/standard/agent.cordis.yml'
const patch = 'packages/bundle/base/cordis.patch.yml'

function write(root: string, path: string, value: unknown): void {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
}

function manifest(root: string, path: string, fields: Record<string, unknown>): void {
  const existing = JSON.parse(readFileSync(join(root, path), 'utf8')) as Record<string, unknown>
  write(root, path, { ...existing, ...fields })
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-default-isolation-'))
  roots.push(root)
  write(root, 'apps/cli/package.json', { name: '@deepseek-ai/dsh', dependencies: { [core]: 'workspace:^' } })
  write(root, 'apps/cli/src/bin.ts', 'export {}\n')
  write(root, 'apps/web/package.json', { name: '@deepseek-ai/dsh-web-frontend' })
  write(root, 'apps/web/index.html', '<script type="module" src="/src/main.ts"></script>')
  write(root, 'apps/web/src/main.ts', 'export {}\n')
  write(root, 'python/sdk-runtime/package.json', { name: '@deepseek-ai/dsh-python-runtime' })
  write(root, 'packages/core/core/package.json', { name: core })
  write(root, 'packages/core/core/src/index.ts', 'export {}\n')
  write(root, 'packages/bundle/base/package.json', { name: base, dsh: { bundle: { patch: './cordis.patch.yml' } } })
  write(root, patch, [{ insert: [{ name: core }] }])
  write(root, preset, [{ name: core }])
  write(root, profile, `export const PROFILE_TEMPLATES = { headless: { bundles: ['${base}'], patchReload: 'startup' } }\n`
    + `export const DEFAULT_PROFILE_BUNDLES = ['${base}']\n`)
  write(root, 'packages/experimental/prototype/package.json', { name: experimental })
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('default product isolation', () => {
  it('allows development dependencies, type imports, and separate experimental preview entries', () => {
    const root = fixture()
    manifest(root, 'apps/cli/package.json', { devDependencies: { [experimental]: 'workspace:^' } })
    write(root, 'apps/cli/src/bin.ts', `import type { Options } from '${experimental}'\nexport type { Options }\n`)
    write(root, 'apps/web/src/preview.ts', `import '${experimental}'\n`)
    write(root, 'packages/experimental/prototype/cordis.patch.yml', [{ name: experimental }])

    expect(verifyDefaultProductIsolation(root)).toMatchObject({ failures: [], packageCount: 5, configCount: 2 })
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])(
    'rejects transitive experimental %s',
    (section) => {
      const root = fixture()
      manifest(root, 'packages/core/core/package.json', { [section]: { [experimental]: 'workspace:^' } })

      expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(`${core} ${section} -> ${experimental}`)
    },
  )

  it.each([
    `npm:${experimental}@1.0.0`, `workspace:${experimental}@*`,
    'file:../../experimental/prototype', 'link:../../experimental/prototype',
    'workspace:../../experimental/prototype',
  ])('rejects a safe-looking dependency alias targeting %s', (range) => {
    const root = fixture()
    manifest(root, 'packages/core/core/package.json', { dependencies: { safe: range } })

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('rejects experimental names absent from the inventory and paths with another package name', () => {
    const root = fixture()
    manifest(root, 'apps/cli/package.json', { dependencies: { '@deepseek-ai/dsh-experimental-missing': '*' } })
    manifest(root, 'packages/experimental/prototype/package.json', { name: '@fixture/innocent' })
    manifest(root, 'python/sdk-runtime/package.json', { dependencies: { '@fixture/innocent': '*' } })

    const failures = verifyDefaultProductIsolation(root).failures.join('\n')
    expect(failures).toContain('@deepseek-ai/dsh-experimental-missing')
    expect(failures).toContain('@fixture/innocent')
  })

  it('follows private application intermediaries and terminates cycles', () => {
    const root = fixture()
    write(root, 'apps/desktop/package.json', { name: '@fixture/desktop', private: true,
      dependencies: { [core]: '*', [experimental]: '*' } })
    manifest(root, 'packages/core/core/package.json', { peerDependencies: { '@fixture/desktop': '*' } })

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it.each([
    `import '${experimental}'`,
    `export * from '${experimental}'`,
    `await import('${experimental}/client')`,
    `const x = require('${experimental}')`,
    'import \'./../../../packages/experimental/prototype/src/index.ts\'',
  ])('rejects runtime source reference %s', (source) => {
    const root = fixture()
    write(root, 'apps/cli/src/bin.ts', source)
    write(root, 'packages/experimental/prototype/src/index.ts', 'export {}\n')

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it.each([
    "import './preview.ts'", "import './preview.ts?worker'", "new Worker(new URL('./preview.ts', import.meta.url))",
  ])('rejects default Web entry reaching preview via %s', (source) => {
    const root = fixture()
    write(root, 'apps/web/src/main.ts', source)
    write(root, 'apps/web/src/preview.ts', `import '${experimental}'\n`)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it.each([
    [{ name: experimental, disabled: true }],
    [{ group: true, config: [{ name: experimental }] }],
    [{ insert: [{ name: experimental }] }],
    [{ name: '@deepseek-ai/cordis-plugin-group', config: [{ name: experimental }] }],
    [{ name: '@deepseek-ai/cordis-plugin-include', config: { patches: [{ insert: [{ name: experimental }] }] } }],
  ].map(entries => ({ entries })))('rejects experimental plugin rows in $entries', ({ entries }) => {
    const root = fixture()
    write(root, patch, entries)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('follows Include files while ignoring ordinary plugin config data', () => {
    const root = fixture()
    write(root, patch, [{ name: core, config: { name: experimental, insert: [{ name: experimental }] } }])
    expect(verifyDefaultProductIsolation(root).failures).toEqual([])
    write(root, patch, [{ name: '@deepseek-ai/cordis-plugin-include', config: { path: './nested.yml' } }])
    write(root, 'packages/bundle/base/nested.yml', [{ name: experimental }])
    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('checks default profile bundle names and declared config trees', () => {
    const root = fixture()
    write(root, profile, `export const PROFILE_TEMPLATES = { test: { bundles: ['${experimental}'] } }\n`
      + `export const DEFAULT_PROFILE_BUNDLES = ['${base}']\n`)
    manifest(root, 'apps/cli/package.json', { dsh: { configTrees: [{ path: './config' }] } })
    write(root, 'apps/cli/config/extra.cordis.yml', [{ name: experimental }])
    const failures = verifyDefaultProductIsolation(root).failures.join('\n')
    expect(failures).toContain(`${profile} -> ${experimental}`)
    expect(failures).toContain('apps/cli/config/extra.cordis.yml')
  })

  it('checks desktop configuration reached through a source URL', () => {
    const root = fixture()
    write(root, 'apps/desktop-host/package.json', { name: '@fixture/desktop-host', private: true })
    write(root, 'apps/desktop-host/src/index.ts', "new URL('../config/desktop.cordis.patch.yml', import.meta.url)")
    write(root, 'apps/desktop-host/config/desktop.cordis.patch.yml', [{ insert: [{ name: experimental }] }])

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('checks installation-owned profile tuples as well as new-profile defaults', () => {
    const root = fixture()
    const source = readFileSync(join(root, profile), 'utf8')
    write(root, profile, `${source}\nconst INSTALLATION_OWNED_PROFILE_TUPLES = { headless: ['${experimental}'] }\n`)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it('checks inline modules alongside the default Web script', () => {
    const root = fixture()
    write(root, 'apps/web/index.html', '<script type="module" src="/src/main.ts"></script>'
      + `<script type="module">import '${experimental}'</script>`)

    expect(verifyDefaultProductIsolation(root).failures.join('\n')).toContain(experimental)
  })

  it.each(['apps/cli/package.json', 'apps/web/index.html', 'python/sdk-runtime/package.json', preset])(
    'fails closed when required input %s is missing',
    (path) => {
      const root = fixture()
      rmSync(join(root, path))
      expect(verifyDefaultProductIsolation(root).failures.length).toBeGreaterThan(0)
    },
  )

  it.each([
    '',
    'export const PROFILE_TEMPLATES = {}; export const DEFAULT_PROFILE_BUNDLES = []',
    'export const PROFILE_TEMPLATES = computedProfiles(); export const DEFAULT_PROFILE_BUNDLES = []',
  ])('rejects absent, empty, or uninspectable default profile definitions', (source) => {
    const root = fixture()
    write(root, profile, source)
    expect(() => verifyDefaultProductIsolation(root)).toThrow('profile')
  })
})
