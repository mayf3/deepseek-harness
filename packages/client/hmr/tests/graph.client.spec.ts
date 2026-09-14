// @vitest-environment jsdom
/** Live graph changes through the browser module system and real Cordis Loader. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createClientModuleSystem, type ClientModuleLoaderTarget, type WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import * as hmr from '../src/client/index.ts'

it('adds, removes and re-adds client contributions without reloading retained modules', async () => {
  class Source extends EventTarget {
    static current: Source
    constructor() { super(); Source.current = this }
    close() {}
  }
  vi.stubGlobal('EventSource', Source)
  onTestFinished(() => { vi.unstubAllGlobals() })
  const ctx = new Context()
  ctx.baseUrl = 'https://dsh.invalid/'
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  let mounted = 0
  let disposed = 0
  const imports: string[] = []
  const graph = (rev: string, ids: string[]): WebBootGraph => ({
    rev, entries: ids.map(id => ({ id, url: `/plugins/${id}.js`, rev })),
    batches: ids.length === 0 ? [] : [{ phase: 'application', url: '/batch.js', rev, entries: ids }],
  })
  const target: ClientModuleLoaderTarget = {
    mode: 'queue', pendingQueue: [], load() {},
    create() { throw new Error('already created') },
  }
  const modules = createClientModuleSystem(target, { id: 'bootstrap', exports: {} }, {
    boot: graph('empty', []), staticModules: {},
    loadBundle: async (url) => {
      imports.push(url)
      target.load({ id: 'added', factory: () => ({ apply(host: Context) {
        mounted++
        host.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'added')
          document.head.append(style)
          return () => { disposed++ }
        })
      } }) })
    },
  })
  ctx.loader.internal = modules as never
  ctx.provide('modules', modules)
  await ctx.plugin(hmr)
  const send = (value: unknown) => Source.current.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  send({ type: 'graph', graph: graph('one', ['added']) })
  await vi.waitFor(() => { expect(mounted).toBe(1) })
  expect([...ctx.loader.entries()].filter(row => row.options.name === 'added')).toHaveLength(1)
  expect(imports).toEqual(['/plugins/added.js'])
  send({ type: 'graph', graph: graph('one', ['added']) })
  send({ type: 'graph', graph: graph('removed', []) })
  await vi.waitFor(() => { expect(disposed).toBe(1) })
  expect([...ctx.loader.entries()].filter(row => row.options.name === 'added')).toHaveLength(0)
  expect(document.querySelector('style[data-plugin="added"]')).toBeNull()
  expect(modules.loadCache.has('added')).toBe(false)
  send({ type: 'graph', graph: graph('two', ['added']) })
  await vi.waitFor(() => { expect(mounted).toBe(2) })
  expect(imports).toEqual(['/plugins/added.js', '/plugins/added.js'])
})
