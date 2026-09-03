import { describe, expect, it, vi } from 'vitest'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import {
  SettingsDescribeMirror, SettingsMirrorRegistry, type SettingsDescribeView,
} from '../src/client/settings-mirror.ts'

/** What a Remote call answers with: no carrier envelope, and a typed failure. */
type Answer<T> =
  | { ok: true; value: T }
  | { ok: false; error: RemoteError }

function ok<T>(value: T): Answer<T> {
  return { ok: true, value }
}

function rejected<T>(message: string): Answer<T> {
  return { ok: false, error: new RemoteError('settings/rejected', message, { ns: 'theme' }) }
}

/** The providing plugin's context, scripted down to the one method the mirror calls. */
function ctxWith(describeCall: unknown) {
  return { remote: { settings: { describe: describeCall } } } as never
}

function view(ns: string, revision = 0): SettingsNamespaceView {
  return { ns, registered: true, schema: {}, value: { field: ns }, applies: 'live', secrets: [], revision }
}

function described(namespaces: SettingsNamespaceView[], scope?: string): Answer<SettingsDescribeView> {
  return ok({
    writable: true, hasDocument: true, namespaces,
    ...scope === undefined ? { scopes: [] } : { scope, scopes: [scope] },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('SettingsDescribeMirror', () => {
  it('folds loads before the wire read into it, and mid-flight loads into one rerun', async () => {
    const gate = deferred<Answer<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValue(described([view('theme', 1)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    const first = mirror.load()
    // Issued before the wire read goes out: covered by that read, no rerun.
    const early = mirror.load()
    await Promise.resolve()
    expect(describeCall).toHaveBeenCalledTimes(1)
    // Issued while the read is on the wire: exactly one rerun, however many.
    const mid = mirror.load()
    const midToo = mirror.load()
    gate.resolve(described([view('theme', 0)]))
    await Promise.all([first, early, mid, midToo])
    expect(describeCall).toHaveBeenCalledTimes(2)
    expect(mirror.getSnapshot().status).toBe('ready')
    expect(mirror.namespace('theme')?.revision).toBe(1)
  })

  it('keeps the last good view when a later refresh fails, recording the failure', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 2)]))
      .mockRejectedValueOnce(new Error('host gone'))
      .mockResolvedValueOnce(rejected('busy'))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    expect(mirror.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    await mirror.load()
    expect(mirror.getSnapshot()).toMatchObject({ status: 'ready', error: 'host gone' })
    expect(mirror.namespace('theme')?.revision).toBe(2)
    await mirror.load()
    expect(mirror.getSnapshot()).toMatchObject({ status: 'ready', error: 'busy' })
    expect(mirror.getSnapshot().view?.namespaces).toHaveLength(1)
  })

  it('returns to idle after a first read that never succeeded, so ensure retries', async () => {
    const describeCall = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(described([view('theme', 1)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.ensure()
    expect(mirror.getSnapshot()).toMatchObject({ status: 'idle', view: undefined, error: 'offline' })
    await mirror.ensure()
    expect(mirror.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    expect(describeCall).toHaveBeenCalledTimes(2)
  })

  it('treats ensure as a no-op once ready', async () => {
    const describeCall = vi.fn().mockResolvedValue(described([view('theme', 1)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.ensure()
    await mirror.ensure()
    await mirror.ensure()
    expect(describeCall).toHaveBeenCalledTimes(1)
  })

  it('memory persistence is terminally unavailable and never touches the wire', async () => {
    const describeCall = vi.fn()
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall), 'memory')
    await mirror.ensure()
    await mirror.load()
    expect(mirror.getSnapshot()).toEqual({ status: 'unavailable', view: undefined, error: null })
    expect(describeCall).not.toHaveBeenCalled()
  })

  it('acceptView folds one write answer into the held view without a wire read', async () => {
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 1), view('locale', 4)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    const seen: number[] = []
    mirror.subscribe(() => { seen.push(mirror.namespace('theme')?.revision ?? -1) })
    mirror.acceptView(view('theme', 9))
    expect(mirror.namespace('theme')?.revision).toBe(9)
    expect(mirror.namespace('locale')?.revision).toBe(4)
    expect(seen).toEqual([9])
    expect(describeCall).toHaveBeenCalledTimes(1)
  })

  it('acceptView before any answer is a no-op instead of inventing a document', () => {
    const describeCall = vi.fn()
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    mirror.acceptView(view('theme', 1))
    expect(mirror.getSnapshot()).toEqual({ status: 'idle', view: undefined, error: null })
  })

  it('acceptView appends a namespace the held view has not seen yet', async () => {
    const describeCall = vi.fn().mockResolvedValueOnce(described([view('theme', 1)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    mirror.acceptView(view('fresh-ns', 0))
    expect(mirror.namespace('fresh-ns')).toBeDefined()
    expect(mirror.getSnapshot().view?.namespaces).toHaveLength(2)
  })

  it('never loses a load landing between a run settling and its slot clearing', async () => {
    // Regression: with the in-flight slot cleared by a promise .finally(),
    // a load() in the one-microtask gap after the rerun check marked a rerun
    // nobody read, and that refresh never reached the wire.
    const describeCall = vi.fn().mockResolvedValue(described([view('theme', 1)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    void mirror.load()
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(1) })
    void mirror.load()
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(2) })
    void mirror.load()
    await vi.waitFor(() => { expect(describeCall).toHaveBeenCalledTimes(3) })
  })

  it('starts no second run for a load issued inside the loading publish', async () => {
    const gate = deferred<Answer<SettingsDescribeView>>()
    const describeCall = vi.fn().mockReturnValue(gate.promise)
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    let reentered = false
    const unsubscribe = mirror.subscribe(() => {
      if (reentered) return
      reentered = true
      void mirror.load()
    })
    const loading = mirror.load()
    await Promise.resolve()
    expect(describeCall).toHaveBeenCalledTimes(1)
    gate.resolve(described([view('theme', 1)]))
    await loading
    unsubscribe()
    // The reentrant load folded into the first run rather than racing it.
    expect(describeCall).toHaveBeenCalledTimes(1)
    expect(mirror.getSnapshot().status).toBe('ready')
  })

  it('lets the first read cover a write folded inside the loading publish', async () => {
    const describeCall = vi.fn().mockResolvedValue(described([view('theme', 2)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    const unsubscribe = mirror.subscribe(() => {
      unsubscribe()
      mirror.acceptView(view('theme', 2))
    })

    await mirror.load()

    expect(describeCall).toHaveBeenCalledTimes(1)
    expect(mirror.getSnapshot().status).toBe('ready')
    expect(mirror.namespace('theme')?.revision).toBe(2)
  })

  it('re-reads after a folded write invalidates an in-flight document', async () => {
    const slow = deferred<Answer<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockResolvedValueOnce(described([view('theme', 4), view('locale', 1)]))
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(described([view('theme', 5), view('locale', 2)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    expect(describeCall).toHaveBeenCalledTimes(1)
    const stale = mirror.load()
    await Promise.resolve()
    mirror.acceptView(view('theme', 5))
    slow.resolve(described([view('theme', 4), view('locale', 2)]))
    await stale
    expect(describeCall).toHaveBeenCalledTimes(3)
    expect(mirror.namespace('theme')?.revision).toBe(5)
    expect(mirror.namespace('locale')?.revision).toBe(2)
  })

  it('re-reads after a pre-answer write invalidates the in-flight document', async () => {
    const slow = deferred<Answer<SettingsDescribeView>>()
    const describeCall = vi.fn()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(described([view('theme', 2)]))
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    const loading = mirror.load()
    await Promise.resolve()
    mirror.acceptView(view('theme', 2))
    slow.resolve(described([view('theme', 1)]))
    await loading
    expect(describeCall).toHaveBeenCalledTimes(2)
    expect(mirror.namespace('theme')?.revision).toBe(2)
  })
})

describe('SettingsDescribeMirror failure text', () => {
  it('records a rejection that is not an Error by its string form', async () => {
    const describeCall = vi.fn().mockRejectedValueOnce('offline')
    const mirror = new SettingsDescribeMirror(ctxWith(describeCall))
    await mirror.load()
    expect(mirror.getSnapshot()).toMatchObject({ status: 'idle', error: 'offline' })
  })
})

describe('SettingsDescribeMirror under a named scope', () => {
  it('reads the scope it was created for, and the global mirror sends no argument', async () => {
    const describeCall = vi.fn((scope?: string) => Promise.resolve(
      described([view(scope === undefined ? 'global-theme' : 'scoped-theme', 2)], scope)))
    const global = new SettingsDescribeMirror(ctxWith(describeCall))
    const scoped = new SettingsDescribeMirror(ctxWith(describeCall), 'host', 'preset/research')
    await Promise.all([global.load(), scoped.load()])
    expect(describeCall.mock.calls).toEqual([[], ['preset/research']])
    expect(global.scope).toBeUndefined()
    expect(scoped.scope).toBe('preset/research')
    expect(global.namespace('global-theme')?.revision).toBe(2)
    expect(scoped.getSnapshot().view).toMatchObject({ scope: 'preset/research', scopes: ['preset/research'] })
  })
})

describe('SettingsMirrorRegistry', () => {
  function registry(persistence: 'host' | 'memory' = 'host') {
    const describeCall = vi.fn((scope?: string) => Promise.resolve(described([view(scope ?? 'global')], scope)))
    return { describeCall, mirrors: new SettingsMirrorRegistry(ctxWith(describeCall), persistence) }
  }

  it('creates one mirror per named scope on first use and keeps it', () => {
    const { mirrors } = registry()
    expect(mirrors.mirrorFor()).toBe(mirrors.global)
    const research = mirrors.mirrorFor('preset/research')
    expect(research.scope).toBe('preset/research')
    expect(mirrors.mirrorFor('preset/research')).toBe(research)
    expect(mirrors.scopes()).toEqual(['preset/research'])
  })

  it('routes a scoped commit to that scope alone and a global commit to every mirror', async () => {
    const { describeCall, mirrors } = registry()
    mirrors.mirrorFor('preset/research')
    mirrors.mirrorFor('preset/code')
    await mirrors.invalidate('preset/research')
    expect(describeCall.mock.calls).toEqual([['preset/research']])
    // An unmirrored scope has nothing to refresh.
    await mirrors.invalidate('preset/unknown')
    expect(describeCall).toHaveBeenCalledTimes(1)
    await mirrors.invalidate()
    expect(describeCall.mock.calls.slice(1)).toEqual([[], ['preset/research'], ['preset/code']])
    await mirrors.reload()
    expect(describeCall).toHaveBeenCalledTimes(7)
    expect(mirrors.mirrorFor('preset/code').namespace('preset/code')).toBeDefined()
  })

  it('keeps every mirror process-local in memory mode', async () => {
    const { describeCall, mirrors } = registry('memory')
    mirrors.mirrorFor('preset/research')
    await mirrors.reload()
    await mirrors.invalidate('preset/research')
    expect(describeCall).not.toHaveBeenCalled()
    expect(mirrors.mirrorFor('preset/research').getSnapshot().status).toBe('unavailable')
  })
})
