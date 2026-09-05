/**
 * Startup isolation: a row inside a `cordis:contained-group` fails on its
 * own and is recorded, the group and its siblings stay up, and the boot
 * audit treats the record as a report rather than a fatal. Built-in rows keep
 * the fatal path, and a built-in row left waiting because an isolated bundle
 * failed still fails the boot while naming that bundle.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  assertEntriesActivated, boot, ContainedFailureRegistry, ContainedGroup, ensurePluginFailures, installRuntimeGuards,
  isContainedEntry, rootIncludeEntry, warnNestedFiberFailures, type RuntimeGuardProcess,
} from '../src/index.ts'

const NAME = 'dsh-test-bin'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const good: Plugin.Function = () => {}
const throws: Plugin.Function = () => { throw new Error('boom at apply') }
const pending: Plugin.Object = { inject: ['neverReady'], apply() {} }
const nestedThrows: Plugin.Function = (ctx) => {
  ctx.inject([], () => { throw new Error('nested boom') })
}
let flakyCalls = 0
const flaky: Plugin.Function = () => {
  flakyCalls += 1
  if (flakyCalls > 1) throw new Error('flaky on reload')
}

const prepare = (ctx: Context): void => {
  ctx.loader.builtins.good = good
  ctx.loader.builtins.throws = throws
  ctx.loader.builtins.pending = pending
  ctx.loader.builtins['nested-throws'] = nestedThrows
  ctx.loader.builtins.flaky = flaky
}

function stage(config: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-contained-'))
  const path = join(dir, 'cordis.yml')
  writeFileSync(path, config)
  return path
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30))

describe('cordis:contained-group', () => {
  it('isolates a failing row, keeps its siblings, and records the failure', async () => {
    const ctx = await boot(NAME, stage(`
- id: bundle/ext
  name: cordis:contained-group
  group: true
  config:
    - id: ext/ok
      name: cordis:good
    - id: ext/bad
      name: cordis:throws
- id: builtin-ok
  name: cordis:good
`), [], prepare)
    contexts.push(ctx)
    // Tree-wide ids carry the root include's prefix; the composition's own ids do not.
    const ids = [...ctx.loader.entries()].map(entry => entry.id)
    expect(ids).toEqual(expect.arrayContaining(['include:bundle/ext', 'include:ext/ok', 'include:builtin-ok']))
    expect(ids).not.toContain('include:ext/bad')
    const registry = ctx.get('pluginFailures') as ContainedFailureRegistry
    expect(registry.list()).toEqual([expect.objectContaining({
      entryId: 'include:ext/bad', rowId: 'ext/bad', moduleName: 'cordis:throws', groupId: 'include:bundle/ext', stage: 'apply',
    })])
    expect(registry.get('include:ext/bad')?.message).toContain('boom at apply')
    expect(isContainedEntry(ctx.loader.resolve('include:ext/ok'))).toBe(true)
    expect(isContainedEntry(ctx.loader.resolve('include:builtin-ok'))).toBe(false)
    expect(rootIncludeEntry(ctx)?.id).toBe('include')
  })

  it('records a contained row that waits forever for a service instead of failing the boot', async () => {
    const ctx = await boot(NAME, stage(`
- id: bundle/ext
  name: cordis:contained-group
  group: true
  config:
    - id: ext/waiting
      name: cordis:pending
`), [], prepare)
    contexts.push(ctx)
    const registry = ctx.get('pluginFailures') as ContainedFailureRegistry
    expect(registry.get('include:ext/waiting')).toEqual(expect.objectContaining({ stage: 'inject-pending', rowId: 'ext/waiting' }))
    expect(registry.get('include:ext/waiting')?.message).toContain('neverReady')
  })

  it('still fails the boot for a built-in row, and names isolated bundles when a built-in row is left waiting', async () => {
    await expect(boot(NAME, stage(`
- id: builtin-bad
  name: cordis:throws
`), [], prepare)).rejects.toThrow(/boom at apply/)

    await expect(boot(NAME, stage(`
- id: bundle/ext
  name: cordis:contained-group
  group: true
  config:
    - id: ext/bad
      name: cordis:throws
- id: builtin-waiting
  name: cordis:pending
`), [], prepare)).rejects.toThrow(/isolated bundle failure\(s\) may be the missing provider — check include:bundle\/ext/)
  })

  it('re-running the audit clears a record whose row later mounted', async () => {
    const ctx = await boot(NAME, stage(`
- id: bundle/ext
  name: cordis:contained-group
  group: true
  config:
    - id: ext/ok
      name: cordis:good
`), [], prepare)
    contexts.push(ctx)
    const registry = ctx.get('pluginFailures') as ContainedFailureRegistry
    registry.record({ entryId: 'include:ext/ok', rowId: 'ext/ok', moduleName: 'cordis:good', groupId: 'include:bundle/ext', stage: 'unknown', message: 'stale' })
    await assertEntriesActivated(ctx, NAME)
    expect(registry.get('include:ext/ok')).toBeUndefined()
  })

  it('records an import failure, and spells ids without a prefix in a tree with no include', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    ctx.loader.builtins['contained-group'] = ContainedGroup
    ensurePluginFailures(ctx)
    const group: EntryOptions = {
      id: 'bundle/ext', name: 'cordis:contained-group', group: true,
      config: [{ id: 'ext/missing', name: 'no-such-package-for-dsh-tests' }],
    }
    await ctx.loader.create(group)
    const registry = ctx.get('pluginFailures') as ContainedFailureRegistry
    expect(registry.get('ext/missing')).toEqual(expect.objectContaining({ entryId: 'ext/missing', rowId: 'ext/missing', stage: 'import', groupId: 'bundle/ext' }))
  })

  it('records a contained row whose fiber fails on a later reload', async () => {
    flakyCalls = 0
    const ctx = await boot(NAME, stage(`
- id: bundle/ext
  name: cordis:contained-group
  group: true
  config:
    - id: ext/flaky
      name: cordis:flaky
`), [], prepare)
    contexts.push(ctx)
    const entry = ctx.loader.resolve('include:ext/flaky')
    // The restart rethrows the reload failure; the fiber stays mounted as FAILED.
    await entry.fiber?.restart().catch(() => undefined)
    await settle()
    await assertEntriesActivated(ctx, NAME)
    const registry = ctx.get('pluginFailures') as ContainedFailureRegistry
    expect(registry.get('include:ext/flaky')).toEqual(expect.objectContaining({ stage: 'apply', rowId: 'ext/flaky' }))
    expect(registry.get('include:ext/flaky')?.message).toContain('flaky on reload')
  })

  it('forgets its rows\' records when the group unmounts', async () => {
    const ctx = await boot(NAME, stage(`
- id: bundle/ext
  name: cordis:contained-group
  group: true
  config:
    - id: ext/bad
      name: cordis:throws
    - id: ext/ok
      name: cordis:good
- id: bundle/other
  name: cordis:contained-group
  group: true
  config:
    - id: other/bad
      name: cordis:throws
`), [], prepare)
    contexts.push(ctx)
    const registry = ctx.get('pluginFailures') as ContainedFailureRegistry
    expect(registry.list().map(failure => failure.entryId).sort()).toEqual(['include:ext/bad', 'include:other/bad'])
    // The group's row id keys the tree store; `Entry.id` carries the include prefix.
    const group = ctx.loader.resolve('include:bundle/ext')
    await group.parent.remove(group.options.id)
    expect([...ctx.loader.entries()].some(entry => entry.id === 'include:ext/ok')).toBe(false)
    expect(registry.list().map(failure => failure.entryId)).toEqual(['include:other/bad'])
  })

  it('provides one registry per runtime', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const registry = ensurePluginFailures(ctx)
    expect(ensurePluginFailures(ctx.extend({}))).toBe(registry)
    registry.record({ entryId: 'a', rowId: 'a', moduleName: 'm', groupId: 'g', stage: 'import', message: 'x' })
    registry.record({ entryId: 'a', rowId: 'a', moduleName: 'm', groupId: 'g', stage: 'apply', message: 'y' })
    expect(registry.list()).toHaveLength(1)
    registry.clear('a')
    expect(registry.list()).toEqual([])
  })
})

describe('warnNestedFiberFailures', () => {
  it('reports a failed nested fiber under a built-in entry and ignores contained ones', async () => {
    const ctx = await boot(NAME, stage(`
- id: builtin-nested
  name: cordis:nested-throws
- id: bundle/ext
  name: cordis:contained-group
  group: true
  config:
    - id: ext/nested
      name: cordis:nested-throws
`), [], prepare)
    contexts.push(ctx)
    await settle()
    const lines: string[] = []
    expect(warnNestedFiberFailures(ctx, NAME, line => lines.push(line))).toBe(1)
    expect(lines).toEqual([expect.stringContaining('cordis:nested-throws')])
    // The default sink is the context logger; it must accept the call too.
    expect(warnNestedFiberFailures(ctx, NAME)).toBe(1)
  })

  it('reports nothing for a clean tree', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Loader)
    expect(warnNestedFiberFailures(ctx, NAME, () => { throw new Error('unexpected') })).toBe(0)
  })
})

describe('installRuntimeGuards', () => {
  function fakeProc(): RuntimeGuardProcess & { handlers: Map<string, (err: unknown) => void>; exits: number[] } {
    const handlers = new Map<string, (err: unknown) => void>()
    const exits: number[] = []
    return {
      handlers,
      exits,
      on: (event, handler) => { handlers.set(event, handler) },
      off: (event) => { handlers.delete(event) },
      exit: (code) => { exits.push(code) },
    }
  }

  it('reports a rejection without exiting, exits on an exception, and uninstalls both', () => {
    const proc = fakeProc()
    const lines: string[] = []
    const uninstall = installRuntimeGuards(NAME, line => lines.push(line), proc)
    proc.handlers.get('unhandledRejection')?.(new Error('stray'))
    expect(proc.exits).toEqual([])
    expect(lines[0]).toContain('unhandled rejection after boot')
    expect(lines[0]).toContain('stray')
    proc.handlers.get('uncaughtException')?.('plain')
    expect(proc.exits).toEqual([1])
    expect(lines[1]).toContain('uncaught exception after boot')
    uninstall()
    expect(proc.handlers.size).toBe(0)
  })

  it('defaults to the real process', () => {
    const before = process.listenerCount('uncaughtException')
    const uninstall = installRuntimeGuards(NAME, () => {})
    expect(process.listenerCount('uncaughtException')).toBe(before + 1)
    uninstall()
    expect(process.listenerCount('uncaughtException')).toBe(before)
  })
})
