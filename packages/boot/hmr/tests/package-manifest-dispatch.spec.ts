/** HMR dispatch of package manifest changes through a real Loader and a controlled watcher. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { FSWatcher, type ChokidarOptions } from 'chokidar'
import { expect, it, onTestFinished, vi } from 'vitest'
import Hmr from '../src/index.ts'

const watchers = vi.hoisted(() => [] as FSWatcher[])
// File notifications are delivered only when a test emits them.
vi.mock('chokidar', async (original) => {
  const actual = await original<typeof import('chokidar')>()
  return { ...actual, watch: (_paths: string | string[], options: ChokidarOptions = {}) => {
    const watcher = new actual.FSWatcher(options)
    watchers.push(watcher)
    queueMicrotask(() => watcher.emit('ready'))
    return watcher
  } }
})

function file(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
}

function plugin(marker: string): string {
  return `import { value } from '#dep';
export function apply(ctx) {
  ctx.get('manifestTrace').push('start:${marker}:' + value);
  ctx.effect(() => () => { ctx.get('manifestTrace').push('stop:${marker}'); });
}
`
}

function manifest(entry: string, dep: string): string {
  return JSON.stringify({ name: 'addon', type: 'module', exports: `./${entry}.mjs`, imports: { '#dep': `./${dep}.mjs` } })
}

async function fixture(source = plugin('a')) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-hmr-manifest-dispatch-')))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { rmSync(root, { recursive: true, force: true }) }
  })
  const pkg = join(root, 'plugins', 'addon')
  file(join(pkg, 'package.json'), manifest('a', 'dep-1'))
  file(join(pkg, 'a.mjs'), source)
  file(join(pkg, 'b.mjs'), plugin('b'))
  file(join(pkg, 'dep-1.mjs'), 'export const value = 1')
  file(join(pkg, 'dep-2.mjs'), 'export const value = 2')
  file(join(root, 'app', 'package.json'), '{"type":"module"}')
  mkdirSync(join(root, 'app', 'node_modules'), { recursive: true })
  symlinkSync(pkg, join(root, 'app', 'node_modules', 'addon'), process.platform === 'win32' ? 'junction' : 'dir')
  const trace: string[] = []
  ctx.baseUrl = pathToFileURL(join(root, 'app')).href + '/'
  ctx.provide('manifestTrace', trace)
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  const start = watchers.length
  await ctx.plugin(Hmr, { root: ['../plugins'], ignored: [], debounce: 0 })
  const watcher = watchers.slice(start).at(-1)!
  const entry = ctx.loader.resolve(await ctx.loader.create({ name: 'addon' }))
  await ctx.loader.await()
  const emit = async (...paths: string[]) => {
    const dispatch = vi.spyOn(ctx.hmr, 'runExclusive')
    try {
      for (const path of paths) watcher.emit('change', path)
      await vi.waitFor(() => { expect(dispatch).toHaveBeenCalledOnce() })
      const result = dispatch.mock.results[0]!
      expect(result.type).toBe('return')
      await result.value
    } finally {
      dispatch.mockRestore()
    }
  }
  return { ctx, pkg, trace, emit, entry }
}

it('does not reload for a manifest alone and resolves the new entry when the Loader entry restarts', async () => {
  const f = await fixture()
  expect(f.trace).toEqual(['start:a:1'])
  file(join(f.pkg, 'package.json'), manifest('b', 'dep-2'))
  await f.emit(join(f.pkg, 'package.json'))
  expect(f.trace).toEqual(['start:a:1'])

  await f.entry.update({ disabled: true })
  await f.entry.update({ disabled: false })
  await f.ctx.loader.await()
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:b:2'])
})

const jsonPlugin = `import manifest from './package.json' with { type: 'json' };
export function apply(ctx) {
  ctx.get('manifestTrace').push('start:json:' + manifest.imports['#dep']);
  ctx.effect(() => () => { ctx.get('manifestTrace').push('stop:json'); });
}
`

it('reloads a plugin that imports its changed manifest as a JSON module', async () => {
  const f = await fixture(jsonPlugin)
  expect(f.trace).toEqual(['start:json:./dep-1.mjs'])
  file(join(f.pkg, 'package.json'), manifest('a', 'dep-2'))
  await f.emit(join(f.pkg, 'package.json'))
  expect(f.trace).toEqual(['start:json:./dep-1.mjs', 'stop:json', 'start:json:./dep-2.mjs'])
})

it('requests a host reload for a changed manifest in the host module graph', async () => {
  const f = await fixture(jsonPlugin)
  const filename = join(f.pkg, 'package.json')
  const externals = Reflect.get(f.ctx.hmr, 'externals') as Set<string>
  externals.add(pathToFileURL(filename).href)
  const exit = vi.spyOn(f.ctx.loader, 'exit').mockImplementation(() => {})
  onTestFinished(() => { exit.mockRestore() })
  file(filename, manifest('a', 'dep-2'))
  await f.emit(filename)
  expect(exit).toHaveBeenCalledOnce()
  expect(f.trace).toEqual(['start:json:./dep-1.mjs'])
})

it('leaves a configuration-owned manifest to its dedicated watcher', async () => {
  const f = await fixture(jsonPlugin)
  const filename = join(f.pkg, 'package.json')
  const dispose = await f.ctx.hmr.watchConfig(filename, async () => {})
  try {
    file(filename, manifest('a', 'dep-2'))
    await f.emit(filename)
    expect(f.trace).toEqual(['start:json:./dep-1.mjs'])
  } finally {
    await dispose()
  }
})

it('resolves package imports from the changed manifest when a source change reloads the plugin', async () => {
  const f = await fixture()
  file(join(f.pkg, 'package.json'), manifest('a', 'dep-2'))
  file(join(f.pkg, 'a.mjs'), `${plugin('a')}// edited\n`)
  await f.emit(join(f.pkg, 'a.mjs'), join(f.pkg, 'package.json'))
  await f.ctx.loader.await()
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a:2'])
})

it('keeps cached package imports when only source changes', async () => {
  const f = await fixture()
  file(join(f.pkg, 'package.json'), manifest('a', 'dep-2'))
  file(join(f.pkg, 'a.mjs'), `${plugin('a')}// edited\n`)
  await f.emit(join(f.pkg, 'a.mjs'))
  await f.ctx.loader.await()
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a:1'])
})

it('leaves manifests below node_modules to their package lifecycle', async () => {
  const f = await fixture()
  const installed = join(dirname(f.pkg), 'node_modules', 'dep', 'package.json')
  file(installed, '{"name":"dep"}')
  const invalidate = vi.spyOn(Reflect.get(f.ctx.hmr, 'manifests') as { invalidate(path: string): void }, 'invalidate')
  onTestFinished(() => { invalidate.mockRestore() })
  await f.emit(installed)
  expect(invalidate).not.toHaveBeenCalled()
})
