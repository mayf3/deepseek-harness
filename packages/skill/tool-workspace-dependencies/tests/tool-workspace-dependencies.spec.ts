import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as workspaceDependencies from '../src/index.ts'
import { installPrimaryRuntime, readPrimaryRuntime, resolvePrimaryRuntime, workspaceDependencyPaths, type PrimaryRuntimeManifest } from '../src/index.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, rename: vi.fn(actual.rename), lstat: vi.fn(actual.lstat), cp: vi.fn(actual.cp) }
})

const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-primary-runtime-'))
  roots.push(directory)
  const source = join(directory, 'resources')
  const root = join(directory, 'home', 'dsh-runtimes', 'dsh-primary-runtime')
  const manifest: PrimaryRuntimeManifest = {
    desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
    components: { python: '3.12.14', node: '24.21.0', pnpm: '11.7.0', numpy: '2.3.5', pandas: '3.0.1' },
    pythonPackages: { 'python-docx': '1.2.0', 'python-pptx': '1.0.2', openpyxl: '3.1.5' },
  }
  const paths = workspaceDependencyPaths(source, manifest)
  for (const path of [paths.python, paths.node, paths.pnpm]) {
    if (path === undefined) continue
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'interpreter')
  }
  await mkdir(paths.pythonPackages, { recursive: true })
  if (paths.nodePackages !== undefined) await mkdir(paths.nodePackages, { recursive: true })
  await writeFile(join(source, 'runtime.json'), JSON.stringify(manifest))
  return { source, root, manifest, directory }
}

it.each(['win32', 'darwin', 'linux'])('returns %s interpreter and package paths', (platform) => {
  const manifest: PrimaryRuntimeManifest = { desktopVersion: '1', platform, arch: 'x64', components: { python: '3.12.14', node: '24.21.0', pnpm: '11.7.0', numpy: '2.3.5', pandas: '3.0.1' } }
  const paths = workspaceDependencyPaths('/runtime', manifest)
  expect(paths.pythonDistributions).toEqual({})
  expect(paths.python).toBe(join('/runtime', 'dependencies', 'python', ...(platform === 'win32' ? ['python.exe'] : ['bin', 'python3'])))
  expect(paths.pythonPackages).toBe(join('/runtime', 'dependencies', 'python', ...(platform === 'win32' ? ['Lib'] : ['lib', 'python3.12']), 'site-packages'))
})

it('installs offline, reuses the same release, and leaves environment and user packages unchanged', async () => {
  const { source, root, manifest } = await fixture()
  const environment = { ...process.env }
  const installed = await installPrimaryRuntime(source, root)
  await writeFile(join(installed.pythonPackages, 'user-package.py'), 'user content')
  expect(await installPrimaryRuntime(source, root)).toEqual(installed)
  expect(installed.pythonDistributions).toEqual(manifest.pythonPackages)
  expect(await readFile(join(installed.pythonPackages, 'user-package.py'), 'utf8')).toBe('user content')
  expect(process.env).toEqual(environment)
})

it('replaces release components and recovers an interrupted directory swap', async () => {
  const { source, root, manifest } = await fixture()
  await installPrimaryRuntime(source, root)
  await rename(root, `${root}.previous`)
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, desktopVersion: '2.0.0' }))
  await installPrimaryRuntime(source, root)
  expect((await readPrimaryRuntime(root)).desktopVersion).toBe('2.0.0')
})

it('replaces dependencies when the locked payload changes without a Desktop version change', async () => {
  const { source, root, manifest } = await fixture()
  const first = { ...manifest, payloadDigest: 'a'.repeat(64), pythonPackages: { 'python-docx': '1.1.2' } }
  await writeFile(join(source, 'runtime.json'), JSON.stringify(first))
  const installed = await installPrimaryRuntime(source, root)
  await writeFile(join(installed.pythonPackages, 'old-package.py'), 'old dependency')
  const next = { ...first, payloadDigest: 'b'.repeat(64), pythonPackages: { 'python-docx': '1.2.0' } }
  await writeFile(join(source, 'runtime.json'), JSON.stringify(next))
  await writeFile(join(workspaceDependencyPaths(source, next).pythonPackages, 'new-package.py'), 'new dependency')
  await installPrimaryRuntime(source, root)
  expect(await readPrimaryRuntime(root)).toEqual(next)
  expect(await readFile(join(installed.pythonPackages, 'new-package.py'), 'utf8')).toBe('new dependency')
  await expect(readFile(join(installed.pythonPackages, 'old-package.py'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('upgrades a release manifest without a payload digest', async () => {
  const { source, root, manifest } = await fixture()
  await installPrimaryRuntime(source, root)
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, payloadDigest: 'a'.repeat(64), pythonPackages: { 'python-docx': '1.2.0' } }))
  await installPrimaryRuntime(source, root)
  expect((await readPrimaryRuntime(root)).payloadDigest).toBe('a'.repeat(64))
})

it('replaces changed payload bytes when only the digest changes', async () => {
  const { source, root, manifest } = await fixture()
  const first = { ...manifest, payloadDigest: 'a'.repeat(64), pythonPackages: { 'python-docx': '1.2.0' } }
  const sourceFile = join(workspaceDependencyPaths(source, first).pythonPackages, 'library.py')
  await writeFile(join(source, 'runtime.json'), JSON.stringify(first))
  await writeFile(sourceFile, 'first wheel bytes')
  const installed = await installPrimaryRuntime(source, root)
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...first, payloadDigest: 'b'.repeat(64) }))
  await writeFile(sourceFile, 'repacked wheel bytes')
  await installPrimaryRuntime(source, root)
  expect(await readFile(join(installed.pythonPackages, 'library.py'), 'utf8')).toBe('repacked wheel bytes')
  expect((await readPrimaryRuntime(root)).pythonPackages).toEqual(first.pythonPackages)
})

it('keeps the installed release when the replacement payload is incomplete', async () => {
  const { source, root, manifest } = await fixture()
  await installPrimaryRuntime(source, root)
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, desktopVersion: '2.0.0' }))
  await rm(workspaceDependencyPaths(source, manifest).python)
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow()
  expect((await readPrimaryRuntime(root)).desktopVersion).toBe('1.0.0')
})

it('refuses linked installation directories without modifying their targets', async () => {
  const { source, root, directory } = await fixture()
  const outside = join(directory, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'untouched')
  await mkdir(dirname(root), { recursive: true })
  await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow('filesystem link')
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('untouched')
})

it('rejects malformed metadata and incompatible targets', async () => {
  const { source, root, manifest } = await fixture()
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, arch: process.arch === 'x64' ? 'arm64' : 'x64' }))
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow('incompatible')
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, components: { ...manifest.components, python: '../escape' } }))
  await expect(readPrimaryRuntime(source)).rejects.toThrow('invalid metadata')
})

it.each([['numpy', 'numpy'], ['pandas', 'pandas'], ['Numpy', 'numpy'], ['PANDAS', 'pandas']] as const)('rejects conflicting %s component and distribution versions', async (distribution, name) => {
  const { source, manifest } = await fixture()
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, pythonPackages: { [distribution]: '0.0.1' } }))
  await expect(readPrimaryRuntime(source)).rejects.toThrow(`conflicting ${name} distribution version`)
  const consistent = { ...manifest, pythonPackages: { [distribution]: manifest.components[name] } }
  await writeFile(join(source, 'runtime.json'), JSON.stringify(consistent))
  expect(await readPrimaryRuntime(source)).toEqual(consistent)
})

it.each([
  { payloadDigest: 'invalid' },
  { pythonPackages: ['python-docx'] },
  { pythonPackages: { 'python-docx': '../escape' } },
  { pythonPackages: { '../escape': '1.2.0' } },
  { pythonPackages: { numpy: '2.3.5', Numpy: '2.3.5' } },
  { pythonPackages: { Pillow: '12.3.0', pillow: '12.3.0' } },
  { pythonPackages: { typing_extensions: '4.16.0', 'typing.extensions': '4.16.0' } },
])('rejects invalid locked payload metadata: %j', async (invalid) => {
  const { source, manifest } = await fixture()
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, ...invalid }))
  await expect(readPrimaryRuntime(source)).rejects.toThrow('invalid metadata')
})

it('loads the real tool through Cordis, exposes payload paths in place, and unregisters on disposal', async () => {
  const { source, manifest, directory } = await fixture()
  const ctx = new Context()
  try {
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['agents', AgentRegistry], ['systemPrompt', SystemPrompt], ['tools', ToolRuntime], ['dependencies', workspaceDependencies],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected plugin ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    const config = join(directory, 'cordis.yml')
    await writeFile(config, `- name: agents\n- name: systemPrompt\n- name: tools\n- name: dependencies\n  config:\n    source: ${JSON.stringify(source)}\n`)
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    const environment = { ...process.env }
    const request = { signal: new AbortController().signal, name: 'load_workspace_dependencies', arguments: {} }
    const results = await Promise.all(['first', 'second'].map(id => ctx.tools.execute({ ...request, callId: ToolCallId(id) })))
    for (const result of results) {
      expect(result.isError).toBe(false)
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(workspaceDependencyPaths(source, manifest), undefined, 2) }])
    }
    expect(process.env).toEqual(environment)
    const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dependencies')
    expect(entry).toBeDefined()
    await entry?.fiber?.dispose()
    expect(ctx.tools.schemas().some(tool => tool.name === 'load_workspace_dependencies')).toBe(false)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('uses a payload in place without copying and tolerates a payload without Node.js or pnpm', async () => {
  const { source, directory } = await fixture()
  const manifest: PrimaryRuntimeManifest = {
    desktopVersion: '1.0.0', platform: process.platform, arch: process.arch,
    components: { python: '3.12.14', numpy: '2.3.5', pandas: '3.0.1' },
    pythonPackages: { 'python-docx': '1.2.0' },
  }
  await writeFile(join(source, 'runtime.json'), JSON.stringify(manifest))
  const paths = await resolvePrimaryRuntime(source)
  expect(paths).toEqual({
    python: join(source, 'dependencies', 'python', ...(process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3'])),
    pythonPackages: join(source, 'dependencies', 'python', ...(process.platform === 'win32' ? ['Lib'] : ['lib', 'python3.12']), 'site-packages'),
    pythonDistributions: { 'python-docx': '1.2.0' },
  })
  await expect(readFile(join(directory, 'home', 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await rm(paths.python)
  await expect(resolvePrimaryRuntime(source)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rejects a payload whose Node.js or pnpm version is malformed', async () => {
  const { source, manifest } = await fixture()
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, components: { ...manifest.components, node: 'latest' } }))
  await expect(readPrimaryRuntime(source)).rejects.toThrow('invalid metadata')
})

/** Create the real scoped tool registry for lifecycle and failure-path assertions. */
async function tool(config: workspaceDependencies.Config) {
  const ctx = new Context()
  try {
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = ctx.plugin(workspaceDependencies, config)
    await fiber
    const execute = () => ctx.tools.execute({
      signal: new AbortController().signal, name: 'load_workspace_dependencies',
      arguments: {}, callId: ToolCallId('dependencies'),
    })
    return { ctx, fiber, execute }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

it.each([null, [], { desktopVersion: '' }, { platform: 'unsupported' }, { arch: 'ia32' },
  { components: null }, { components: { python: 3 } }, { payloadDigest: 1 },
  { pythonPackages: null }, { pythonPackages: { numpy: 3 } },
])('rejects malformed manifest fields: %j', async (invalid) => {
  const { source, manifest } = await fixture()
  const value = invalid === null || Array.isArray(invalid) ? invalid : { ...manifest, ...invalid }
  await writeFile(join(source, 'runtime.json'), JSON.stringify(value))
  await expect(readPrimaryRuntime(source)).rejects.toThrow('invalid metadata')
})

it('reads legacy metadata without a distribution map and rejects incompatible platforms', async () => {
  const { source, manifest } = await fixture()
  const { pythonPackages: _packages, ...legacy } = manifest
  await writeFile(join(source, 'runtime.json'), JSON.stringify(legacy))
  expect((await resolvePrimaryRuntime(source)).pythonDistributions).toEqual({})
  await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, platform: process.platform === 'linux' ? 'darwin' : 'linux' }))
  await expect(resolvePrimaryRuntime(source)).rejects.toThrow('incompatible')
})

it('propagates filesystem access failures without touching the installation', async () => {
  const { source, root } = await fixture()
  vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow('denied')
  await expect(readFile(join(root, 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([false, true])('preserves the previous installation if publication fails (previous: %s)', async (previous) => {
  const { source, root, manifest } = await fixture()
  if (previous) {
    await installPrimaryRuntime(source, root)
    await writeFile(join(source, 'runtime.json'), JSON.stringify({ ...manifest, desktopVersion: '2.0.0' }))
  }
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  vi.mocked(fs.rename).mockImplementationOnce(previous ? actual.rename : async () => { throw new Error('publication failed') })
  if (previous) vi.mocked(fs.rename).mockRejectedValueOnce(new Error('publication failed'))
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow('publication failed')
  if (previous) expect((await readPrimaryRuntime(root)).desktopVersion).toBe('1.0.0')
  else await expect(readFile(join(root, 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await fs.readdir(dirname(root))).filter(name => name.startsWith('.primary-runtime-'))).toEqual([])
})

it('retries a failed tool preparation and renders its call presentation', async () => {
  const { source, root } = await fixture()
  const metadata = await readFile(join(source, 'runtime.json'))
  await rm(join(source, 'runtime.json'))
  const { ctx, execute } = await tool({ source, root })
  try {
    expect((await execute()).isError).toBe(true)
    await writeFile(join(source, 'runtime.json'), metadata)
    expect((await execute()).isError).toBe(false)
    expect(await readFile(join(root, 'runtime.json'))).toEqual(metadata)
    const descriptor = ctx.tools.get('load_workspace_dependencies')!
    expect(descriptor.presentCall?.({})).toEqual({ card: 'generic', title: 'Load workspace dependencies', kind: 'read' })
  } finally { await ctx.fiber.dispose() }
})

it.each([false, true])('disposal waits for pending filesystem preparation (failure: %s)', async (failure) => {
  const { source, root } = await fixture()
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  let release!: () => void
  let copying!: () => void
  const entered = new Promise<void>((resolve) => { copying = resolve })
  const proceed = new Promise<void>((resolve) => { release = resolve })
  vi.mocked(fs.cp).mockImplementationOnce(async (...args) => {
    copying()
    await proceed
    if (failure) throw new Error('copy failed')
    await actual.cp(...args)
  })
  const { ctx, fiber, execute } = await tool({ source, root })
  const pending = execute()
  try {
    await entered
    let disposed = false
    const disposal = fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release()
    await disposal
    expect((await pending).isError).toBe(failure)
    expect(ctx.tools.schemas().some(value => value.name === 'load_workspace_dependencies')).toBe(false)
  } finally {
    release()
    await pending
    await ctx.fiber.dispose()
  }
})

it('disposes an unused tool without preparing the payload', async () => {
  const { source, root } = await fixture()
  const { ctx } = await tool({ source, root })
  await ctx.fiber.dispose()
  await expect(readFile(join(root, 'runtime.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([{ source: 'relative' }, { source: process.cwd(), root: 'relative' }])('rejects relative runtime configuration at plugin load: %j', async (config) => {
  await expect(tool(config)).rejects.toThrow('must be absolute paths')
})

it.each([{}, { source: '' }, { source: 1 }])('rejects invalid payload configuration with a named source error: %j', (config) => {
  expect(() => workspaceDependencies.Config(config as unknown as workspaceDependencies.Config)).toThrow('source')
})

it('validates the previous directory even when a current installation exists', async () => {
  const { source, root, directory } = await fixture()
  await installPrimaryRuntime(source, root)
  const outside = join(directory, 'outside-previous')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'untouched')
  await symlink(outside, `${root}.previous`, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(installPrimaryRuntime(source, root)).rejects.toThrow('filesystem link')
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('untouched')
})
