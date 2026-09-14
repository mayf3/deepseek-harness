/** Static package declarations never execute installed code. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPackageMetadata } from '../src/index.ts'
const NAME = 'dsh-test-bin'
const roots: string[] = []
afterEach(() => { roots.splice(0).forEach((root) => { rmSync(root, { recursive: true, force: true }) }) })
interface StagedPackage {
  main?: string
  manifest?: Record<string, unknown>
  files?: Record<string, string>
}

/** Stage a profile with packages under its node_modules and an empty app anchor. */
function stage(packages: Record<string, StagedPackage>): { profileDir: string; installAnchor: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-metadata-'))
  roots.push(root)
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


describe('readPackageMetadata', () => {
  it('preserves anonymous rows and absent package versions as static declarations', () => {
    const staged = stage({ pkg: {
      manifest: { version: undefined, dsh: { bundle: { patch: './patch.yml' } } },
      files: { 'patch.yml': '- insert:\n    - name: pkg/tool\n      disabled: false\n' },
    } })
    const metadata = readPackageMetadata({ ...staged, binName: NAME, packageName: 'pkg' })
    expect(metadata.version).toBeUndefined()
    expect(metadata.rows).toEqual([{ name: 'pkg/tool', gated: false }])
  })
  it.each(['foreign', 'proxy', 'unidentified', 'broken'] as const)('reports physical Cordis resolution for a %s peer without executing it', (kind) => {
    const peerManifest = {
      name: kind === 'unidentified' ? 'wrong-package' : '@deepseek-ai/cordis',
      exports: kind === 'broken' ? './absent.js' : './lib/index.js',
      ...kind === 'proxy' ? { dsh: { moduleFallback: { targets: { '.': import.meta.resolve('@deepseek-ai/cordis') } } } } : {},
    }
    const staged = stage({ pkg: { files: {
      'node_modules/@deepseek-ai/cordis/package.json': JSON.stringify(peerManifest),
      'node_modules/@deepseek-ai/cordis/lib/index.js': 'throw new Error("must not execute")',
    } } })
    const metadata = readPackageMetadata({ ...staged, binName: NAME, packageName: 'pkg' })
    expect(metadata.cordisSameCopy).toBe(kind === 'foreign' ? false : kind === 'proxy' ? true : null)
  })

  it('reads package identity without executing the main export', () => {
    const staged = stage({ pkg: {
      main: "import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./executed', import.meta.url), 'bad'); throw new Error('must never execute')",
      manifest: { dsh: { title: 'Package' } },
    } })
    const options = { ...staged, binName: NAME, packageName: 'pkg' }
    const result = readPackageMetadata(options)
    expect(result).toMatchObject({ kind: 'unknown', title: 'Package', version: '1.0.0' })
    const dir = join(staged.profileDir, 'node_modules/pkg')
    expect(existsSync(join(dir, 'executed'))).toBe(false)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pkg', version: '2.0.0' }))
    expect(readPackageMetadata(options)).toMatchObject({ kind: 'unknown', version: '2.0.0' })
  })
  it('lists bundle rows, nested groups, unevaluated gates and external overrides', () => {
    const staged = stage({ pkg: {
      manifest: { description: 'Bundle', engines: { dsh: '>=0.1.0' }, dsh: { bundle: { patch: './patch.yml' } } },
      files: { 'patch.yml': `- insert:
    - id: group
      name: cordis:group
      group: true
      config:
        - id: tool
          name: pkg/tool
          disabled: !!js 'missingService.disabled'
- id: tool
  config: { a: 1 }
- id: webserver
  config: { port: 0 }
` },
    } })
    expect(readPackageMetadata({ ...staged, binName: NAME, packageName: 'pkg' })).toMatchObject({
      kind: 'bundle', description: 'Bundle', enginesDsh: '>=0.1.0',
      rows: [{ id: 'group', name: 'cordis:group', gated: false }, { id: 'tool', name: 'pkg/tool', gated: true }],
      overrides: ['webserver'],
    })
  })
  it.each(['export default () => {}', 'export function apply() {}', 'throw new Error("broken")'])('keeps an undeclared package unknown: %s', (main) => {
    const staged = stage({ pkg: { main } })
    expect(readPackageMetadata({ ...staged, binName: NAME, packageName: 'pkg' }).kind).toBe('unknown')
    expect(existsSync(join(staged.profileDir, 'node_modules/pkg/package.json'))).toBe(true)
  })
  it('ignores unrelated metadata while reading a bundle patch', () => {
    const staged = stage({ pkg: {
      manifest: { dsh: { bundle: { patch: './patch.yml' }, plugins: 'unrecognized metadata' } },
      files: { 'patch.yml': '- insert:\n    - id: tool\n      name: pkg/tool\n' },
    } })
    expect(readPackageMetadata({ ...staged, binName: NAME, packageName: 'pkg' })).toMatchObject({
      kind: 'bundle', rows: [{ id: 'tool', name: 'pkg/tool', gated: false }],
    })
  })
})
