/**
 * The install-time probe: manifest facts read in-process, imports checked in
 * a child process, and the per-profile cache.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLUGIN_PROBE_DIR, PLUGIN_PROBE_FORMAT, probePackage, readProbeCache, writeProbeCache, type PluginProbe } from '../src/index.ts'
import { parseProbeRecord } from '../src/probe.ts'
import { parseChildReport, type ChildReport } from '../src/probe-report.ts'

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

  it('keeps probing a package that prints at import, and kills one that lingers once it reported', async () => {
    const { profileDir, installAnchor } = stage({
      'chatty': { main: 'console.log("initializing logging-plugin")\nexport function apply() {}\n', manifest: { dsh: { title: 'Chatty' } } },
      'lingers': { main: 'setInterval(() => {}, 1000)\nexport function apply() {}\n', manifest: { dsh: { title: 'Lingers' } } },
    })
    const chatty = await probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'chatty' })
    expect(chatty).toMatchObject({ kind: 'plugin', ok: true })
    const lingers = await probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'lingers', timeoutMs: 5_000 })
    expect(lingers).toMatchObject({ kind: 'plugin', ok: true })
    // The probe settled on the child's close: nothing of the killed child is still open.
    expect(process.getActiveResourcesInfo()).not.toContain('ChildProcess')
  })

  it('takes only the message that echoes its token, hides credentials from the child, and keeps a stderr tail', async () => {
    const { profileDir, installAnchor } = stage({
      // A report forged at import, complete with the token's name: the token is
      // gone from the environment and `process.send` from `process` by then.
      'forges': {
        main: 'process.send?.({ token: process.env.DSH_PROBE_REPORT ?? "", cordis: null, main: { ok: true, isPlugin: true, configSchema: null }, addable: {} })\n'
          + 'export const notAPlugin = 1\n',
        manifest: { dsh: { title: 'Forges' } },
      },
      'peeks': {
        main: 'throw new Error("env=" + Object.keys(process.env).filter(k => k.startsWith("PROBE_TEST") || k === "DSH_PROBE_REPORT").sort().join(","))\n',
      },
      'floods': { main: 'import { writeSync } from "node:fs"\nwriteSync(2, "x".repeat(200_000))\nwriteSync(2, "tail-marker")\nprocess.exit(3)\n' },
    })
    const forged = await probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'forges' })
    expect(forged).toMatchObject({ kind: 'library', ok: true })
    process.env.PROBE_TEST_SECRET = 'hidden'
    process.env.PROBE_TEST_PLAIN = 'visible'
    try {
      const peeked = await probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'peeks' })
      expect(peeked.reason).toContain('env=PROBE_TEST_PLAIN')
    } finally {
      delete process.env.PROBE_TEST_SECRET
      delete process.env.PROBE_TEST_PLAIN
    }
    const flood = await probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'floods' }).then(() => undefined, (error: unknown) => error as Error)
    expect(flood?.message).toMatch(/exited with 3 without a report: x+tail-marker$/)
    expect(flood?.message.length).toBeLessThan(17_000)
  })

  it('kills a child that never reports, rejects an unrecognized report, and refuses an unresolvable package', async () => {
    const { profileDir, installAnchor } = stage({
      // Blocks the child's thread inside the import: an unsettled top-level await would make Node exit instead.
      'hangs': { main: 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)\nexport function apply() {}\n' },
      'exits': { main: 'process.stderr.write("refusing to report"); process.exit(3)\n' },
      // `process.send` is gone by the time the package runs; a message it could send would not carry the token anyway.
      'spoofs': { main: 'process.send?.({ nope: true }); process.exit(0)\n' },
    })
    await expect(probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'hangs', timeoutMs: 300 }))
      .rejects.toThrow(/timed out after 300ms/)
    await expect(probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'exits' }))
      .rejects.toThrow(/exited with 3 without a report: refusing to report/)
    await expect(probePackage({ binName: NAME, profileDir, installAnchor, packageName: 'spoofs' }))
      .rejects.toThrow(/exited with 0 without a report/)
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
    // A file with the right format but not the fields of a record is probed again, not returned as one.
    writeFileSync(join(profileDir, PLUGIN_PROBE_DIR, '@scope__pkg.json'), JSON.stringify({ format: PLUGIN_PROBE_FORMAT }))
    expect(readProbeCache(profileDir, '@scope/pkg')).toBeUndefined()
    writeFileSync(join(profileDir, PLUGIN_PROBE_DIR, '@scope__pkg.json'), JSON.stringify({ format: PLUGIN_PROBE_FORMAT, ...record, kind: 'weird' }))
    expect(readProbeCache(profileDir, '@scope/pkg')).toBeUndefined()
    writeFileSync(join(profileDir, PLUGIN_PROBE_DIR, '@scope__pkg.json'), JSON.stringify([record]))
    expect(readProbeCache(profileDir, '@scope/pkg')).toBeUndefined()
  })

  it('accepts only a complete record', () => {
    const record: PluginProbe = {
      packageName: 'pkg', version: '1.0.0', description: 'd', title: 't', kind: 'bundle', ok: false, reason: 'r',
      cordisSameCopy: false, enginesDsh: '>=1', rows: [{ id: 'a', name: 'm', gated: false }, { name: 'n', gated: true }],
      overrides: ['x'], addable: [{ name: 'p', title: 'u', ok: false, error: 'e' }, { name: 'q', ok: true }],
      configSchema: { type: 'object' }, checkedAt: '2026-09-05T00:00:00.000Z',
    }
    expect(parseProbeRecord(record)).toBe(record)
    const broken: Record<string, unknown>[] = [
      { packageName: 1 }, { checkedAt: 1 }, { version: 1 }, { kind: 1 }, { kind: 'weird' }, { ok: 'yes' },
      { cordisSameCopy: 'no' }, { rows: {} }, { rows: [1] }, { rows: [{ id: 1, name: 'm', gated: false }] },
      { rows: [{ name: 1, gated: false }] }, { rows: [{ name: 'm', gated: 'no' }] }, { overrides: 'x' }, { overrides: [1] },
      { addable: {} }, { addable: [1] }, { addable: [{ name: 1, ok: true }] }, { addable: [{ name: 'p', title: 1, ok: true }] },
      { addable: [{ name: 'p', ok: 'yes' }] }, { addable: [{ name: 'p', ok: true, error: 1 }] },
    ]
    for (const fields of broken) expect(parseProbeRecord({ ...record, ...fields }), JSON.stringify(fields)).toBeUndefined()
    expect(parseProbeRecord('record')).toBeUndefined()
  })
})

describe('parseChildReport', () => {
  it('accepts the child\'s message only with every field in place', () => {
    const inspection = { ok: true, isPlugin: true, configSchema: null }
    const report: ChildReport = { token: 't', cordis: null, main: inspection, addable: { 'pkg/x': { ...inspection, ok: false, error: 'boom' } } }
    expect(parseChildReport(report)).toBe(report)
    expect(parseChildReport({ ...report, cordis: 'file:///cordis/index.js' })).toBeDefined()
    const broken: Record<string, unknown>[] = [
      { token: undefined }, { token: 1 }, { cordis: 1 }, { main: undefined }, { main: { ...inspection, ok: 'yes' } }, { main: { ...inspection, isPlugin: 'no' } },
      { main: { ok: true, isPlugin: true } }, { main: { ...inspection, error: 1 } }, { addable: [] }, { addable: { 'pkg/x': 1 } },
    ]
    for (const fields of broken) expect(parseChildReport({ ...report, ...fields }), JSON.stringify(fields)).toBeUndefined()
    expect(parseChildReport('report')).toBeUndefined()
  })
})
