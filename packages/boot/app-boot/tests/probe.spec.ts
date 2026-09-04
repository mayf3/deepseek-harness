/**
 * The install-time probe: manifest facts read in-process, imports checked in
 * a child process, and the per-profile cache.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLUGIN_PROBE_DIR, PLUGIN_PROBE_FORMAT, probePackage, readProbeCache, writeProbeCache, type PluginProbe } from '../src/index.ts'

const NAME = 'dsh-test-bin'

interface StagedPackage {
  main?: string
  manifest?: Record<string, unknown>
  files?: Record<string, string>
}

/** Stage a profile with packages under its node_modules and an empty app anchor. */
function stage(packages: Record<string, StagedPackage>): { profileDir: string; installAnchor: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
  const appDir = join(root, 'app')
  mkdirSync(join(appDir, 'node_modules'), { recursive: true })
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'dsh-app', version: '0.0.0' }))
  const profileDir = join(root, 'profile')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-test', private: true }))
  for (const [name, spec] of Object.entries(packages)) {
    const dir = join(profileDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name, version: '1.0.0', type: 'module', ...spec.main === undefined ? {} : { main: './index.js' }, ...spec.manifest,
    }))
    if (spec.main !== undefined) writeFileSync(join(dir, 'index.js'), spec.main)
    for (const [file, content] of Object.entries(spec.files ?? {})) {
      mkdirSync(join(dir, file, '..'), { recursive: true })
      writeFileSync(join(dir, file), content)
    }
  }
  return { profileDir, installAnchor: join(appDir, 'package.json') }
}

const PLUGIN_MAIN = `
export const name = 'probe-plugin'
export const Config = { toJSON: () => ({ type: 'object', properties: { flag: { type: 'boolean' } } }) }
export function apply() {}
`

describe('probePackage', () => {
  it('classifies a bundle, lists its rows and overrides, and keeps the config schema', async () => {
    const { profileDir, installAnchor } = stage({
      'ext-bundle': {
        main: PLUGIN_MAIN,
        manifest: {
          description: 'A test bundle',
          engines: { dsh: '>=0.1.0' },
          dsh: { title: 'Ext', bundle: { patch: './cordis.patch.yml' }, plugins: [{ name: 'ext-bundle', title: 'Main as row', config: { a: 1 } }] },
        },
        files: {
          'cordis.patch.yml': [
            '- insert:',
            '    - id: seam',
            '      name: other-pkg',
            "      disabled: !!js 'false'",
            '    - id: ext',
            '      name: ext-bundle',
            '    - name: ext-bundle/anonymous',
            '    - id: grp',
            '      name: cordis:group',
            '      group: true',
            '      config:',
            '        - id: nested',
            '          name: ext-bundle/nested',
            '- id: ext',
            '  config: { flag: true }',
            '- id: settings',
            '  config: { path: /x }',
            '',
          ].join('\n'),
        },
      },
    })
    const probe = await probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'ext-bundle' })
    expect(probe).toMatchObject({
      packageName: 'ext-bundle', version: '1.0.0', description: 'A test bundle', title: 'Ext', kind: 'bundle', ok: true,
      enginesDsh: '>=0.1.0', overrides: ['settings'],
      rows: [
        { id: 'seam', name: 'other-pkg', gated: true },
        { id: 'ext', name: 'ext-bundle', gated: false },
        { name: 'ext-bundle/anonymous', gated: false },
        { id: 'grp', name: 'cordis:group', gated: false },
        { id: 'nested', name: 'ext-bundle/nested', gated: false },
      ],
      configSchema: { type: 'object', properties: { flag: { type: 'boolean' } } },
    })
    expect(probe.addable).toEqual([{ name: 'ext-bundle', title: 'Main as row', config: { a: 1 }, ok: true, configSchema: { type: 'object', properties: { flag: { type: 'boolean' } } } }])
    expect(probe.cordisSameCopy).toBeNull()
    expect(Date.parse(probe.checkedAt)).not.toBeNaN()
  })

  it('classifies a plugin by its declaration to dsh, and a library by the lack of one', async () => {
    const { profileDir, installAnchor } = stage({
      'peer-plugin': { main: 'export function apply() {}\n', manifest: { peerDependencies: { '@deepseek-ai/cordis': '*' } } },
      'titled-plugin': { main: 'export default { apply() {} }\n', manifest: { dsh: { title: 'Titled' } } },
      'plain-lib': { main: 'export const helper = 1\n' },
      // A function export alone is not a plugin: lodash exports one too.
      'function-lib': { main: 'export default function _() {}\n' },
    })
    const kindOf = async (packageName: string): Promise<string> =>
      (await probePackage({ binName: NAME, profileDir, installAnchor, packageName })).kind
    expect(await kindOf('peer-plugin')).toBe('plugin')
    expect(await kindOf('titled-plugin')).toBe('plugin')
    expect(await kindOf('function-lib')).toBe('library')
    const lib = await probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'plain-lib' })
    expect(lib.kind).toBe('library')
    expect(lib.ok).toBe(true)
  })

  it('reports a package that fails to import, and one that brings its own cordis', async () => {
    const { profileDir, installAnchor } = stage({
      'broken': { main: 'throw new Error("import-time explosion")\n' },
      'own-cordis': {
        main: 'export function apply() {}\n',
        files: {
          'node_modules/@deepseek-ai/cordis/package.json': JSON.stringify({ name: '@deepseek-ai/cordis', version: '0.0.0', type: 'module', main: './index.js' }),
          'node_modules/@deepseek-ai/cordis/index.js': 'export const Context = class {}\n',
        },
      },
    })
    const broken = await probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'broken' })
    expect(broken.ok).toBe(false)
    expect(broken.reason).toContain('import-time explosion')
    expect(broken.kind).toBe('library')

    const own = await probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'own-cordis' })
    expect(own.cordisSameCopy).toBe(false)
    expect(own.ok).toBe(false)
    expect(own.reason).toContain('own copy of @deepseek-ai/cordis')
  })

  it('probes a package with the minimal manifest and no main export', async () => {
    const { profileDir, installAnchor } = stage({
      'minimal': { manifest: { version: undefined } },
    })
    const probe = await probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'minimal' })
    // No version, description, title, engines, or main: only the facts every package has.
    expect(probe).toEqual({
      packageName: 'minimal', kind: 'library', ok: true, cordisSameCopy: null,
      rows: [], overrides: [], addable: [], checkedAt: expect.any(String) as string,
    })
  })

  it('records an addable module that fails to import without failing the package', async () => {
    const { profileDir, installAnchor } = stage({
      'partial': {
        main: 'export function apply() {}\n',
        manifest: { dsh: { plugins: [{ name: 'partial/missing' }] } },
      },
    })
    const probe = await probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'partial' })
    expect(probe.ok).toBe(true)
    expect(probe.addable).toEqual([expect.objectContaining({ name: 'partial/missing', ok: false })])
    expect(probe.addable[0]?.error).toBeDefined()
  })

  it('kills a child that never reports and refuses an unresolvable package', async () => {
    const { profileDir, installAnchor } = stage({
      'hangs': { main: 'setInterval(() => {}, 1000)\nexport function apply() {}\n' },
      'exits': { main: 'process.stderr.write("refusing to report"); process.exit(3)\n' },
    })
    await expect(probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'hangs', timeoutMs: 300 }))
      .rejects.toThrow(/timed out after 300ms/)
    await expect(probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'exits' }))
      .rejects.toThrow(/exited with 3 without a report: refusing to report/)
    await expect(probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'ghost' }))
      .rejects.toThrow(/cannot resolve profile bundle "ghost"/)
    await expect(probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'exits', nodeExecutable: '/no/such/node' }))
      .rejects.toThrow(/ENOENT/)
  })
})

describe('probe cache', () => {
  it('round-trips a record per package and treats a different version as absent', () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-probe-cache-'))
    const record: PluginProbe = {
      packageName: '@scope/pkg', version: '1.0.0', kind: 'plugin', ok: true, cordisSameCopy: null,
      rows: [], overrides: [], addable: [], checkedAt: '2026-09-04T00:00:00.000Z',
    }
    expect(readProbeCache(profileDir, '@scope/pkg')).toBeUndefined()
    writeProbeCache(profileDir, record)
    expect(readProbeCache(profileDir, '@scope/pkg')).toEqual(record)
    expect(readProbeCache(profileDir, '@scope/pkg', '1.0.0')).toEqual(record)
    expect(readProbeCache(profileDir, '@scope/pkg', '2.0.0')).toBeUndefined()
    writeFileSync(join(profileDir, PLUGIN_PROBE_DIR, '@scope__pkg.json'), '{ not json')
    expect(readProbeCache(profileDir, '@scope/pkg')).toBeUndefined()
    // A record an older probe wrote — no format, or another one — is probed again, not trusted.
    writeFileSync(join(profileDir, PLUGIN_PROBE_DIR, '@scope__pkg.json'), JSON.stringify(record))
    expect(readProbeCache(profileDir, '@scope/pkg')).toBeUndefined()
    writeFileSync(join(profileDir, PLUGIN_PROBE_DIR, '@scope__pkg.json'), JSON.stringify({ format: PLUGIN_PROBE_FORMAT - 1, ...record }))
    expect(readProbeCache(profileDir, '@scope/pkg')).toBeUndefined()
  })
})
