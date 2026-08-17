import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyRuntimeClosure } from './verify-runtime-closure.ts'

const roots: string[] = []

function fixture(files: Record<string, string | Record<string, unknown>>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-closure-'))
  roots.push(root)
  for (const [relative, value] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`)
  }
  return root
}

const platforms = {
  'linux-x64': { tag: 'manylinux_2_28_x86_64', executable: 'runtime-linux-x64' },
  'linux-arm64': { tag: 'manylinux_2_28_aarch64', executable: 'runtime-linux-arm64' },
  'macos-arm64': { tag: 'macosx_14_0_arm64', executable: 'runtime-macos-arm64' },
}

function workspace(root: string, name: string, manifest: Record<string, unknown>): void {
  const packageName = name.replace('@scope/', '')
  const path = join(root, 'packages/core', packageName, 'package.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ name, ...manifest }, null, 2)}\n`)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('verifyRuntimeClosure', () => {
  it('requires only plugins active for a Linux or macOS target', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: { '@scope/shared': 'workspace:^' } },
      'python/sdk-runtime/platforms.json': platforms,
      'apps/cli/config/agent-presets/standard/agent.cordis.yml': `
- id: tools
  name: cordis:group
  group: true
  config:
    - id: shared
      name: '@scope/shared'
    - id: linux
      name: '@scope/linux'
      disabled: !!js process.platform !== 'linux'
    - id: macos
      name: '@scope/macos'
      disabled: !!js process.platform !== 'darwin'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.presetCount).toBe(1)
    expect(result.failures).toEqual([
      'standard preset -> @scope/linux (linux-arm64, linux-x64)',
      'standard preset -> @scope/macos (macos-arm64)',
    ])
  })

  it('treats an unsupported disabled expression as active on every target', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: {} },
      'python/sdk-runtime/platforms.json': platforms,
      'apps/cli/config/agent-presets/standard/agent.cordis.yml': `
- id: conditional
  name: '@scope/conditional'
  disabled: !!js process.env.DSH_DISABLE_CONDITIONAL === '1'
`,
    })

    const result = await verifyRuntimeClosure(root)

    expect(result.failures).toEqual([
      'standard preset -> @scope/conditional (linux-arm64, linux-x64, macos-arm64)',
    ])
  })

  it('retains the required workspace-peer closure check', async () => {
    const root = fixture({
      'python/sdk-runtime/package.json': { name: 'runtime', dependencies: { '@scope/root': 'workspace:^' } },
      'python/sdk-runtime/platforms.json': platforms,
      'apps/cli/config/agent-presets/minimal/agent.cordis.yml': '[]\n',
    })
    workspace(root, '@scope/root', {
      peerDependencies: { '@scope/required': 'workspace:^', '@scope/optional': 'workspace:^' },
      peerDependenciesMeta: { '@scope/optional': { optional: true } },
    })
    workspace(root, '@scope/required', {})
    workspace(root, '@scope/optional', {})

    const result = await verifyRuntimeClosure(root)

    expect(result.workspacePackageCount).toBe(1)
    expect(result.failures).toEqual(['runtime -> @scope/root -> @scope/required'])
  })
})
