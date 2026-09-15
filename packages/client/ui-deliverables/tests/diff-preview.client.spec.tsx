// @vitest-environment jsdom
/** The comparison tab type: its addresses, its Host reads, and the states its body draws. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { changesDiffAddress, changesDiffUrl, parseChangesDiffAddress, type ChangesDiff } from '../src/changes.ts'
import { ChangesDiffStore } from '../src/client/changes-diff.ts'
import { DiffPreview, hunkRows, type DiffPreviewInjected, type DiffPreviewProps } from '../src/client/DiffPreview.tsx'
import { changesDiffDefinition } from '../src/client/diff-definition.ts'
import { PresentedOpenController } from '../src/client/present-open.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const SESSION = SessionId('viewed')
const COORDINATES = { sessionId: SESSION, seq: 5, index: 1, display: 'src/app/main.ts' }
const URL_ = changesDiffUrl(SESSION, 5, 1)

const text: ChangesDiff = {
  kind: 'text', path: 'src/app/main.ts', display: 'src/app/main.ts', before: true, after: true, coarse: false,
  hunks: [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' a', '-b', '+B', '+c', ' d'] },
    { oldStart: 10, oldLines: 1, newStart: 11, newLines: 1, lines: ['-x', '+y'] },
  ],
}

describe('comparison addresses', () => {
  it('round-trips coordinates and titles the tab by the file name', () => {
    const address = changesDiffAddress({ ...COORDINATES, display: 'dir/we ird#name.ts' })
    expect(address).toBe('dsh-resource://changes-diff/session/viewed/5/1/dir%2Fwe%20ird%23name.ts')
    expect(parseChangesDiffAddress(address)).toEqual({ ...COORDINATES, display: 'dir/we ird#name.ts' })
    const definition = changesDiffDefinition()
    expect(definition).toMatchObject({ kind: 'changes-diff', priority: 'builtin', patterns: ['dsh-resource://changes-diff/**'] })
    expect(definition.canOpen?.(address)).toBe(true)
    expect(definition.title(address)).toBe('we ird#name.ts')
    for (const bad of [
      'dsh-resource://file/session/viewed/a.ts', 'dsh-resource://changes-diff/session/viewed/5/1',
      'dsh-resource://changes-diff/session//5/1/a', 'dsh-resource://changes-diff/session/viewed/x/1/a',
      'dsh-resource://changes-diff/session/viewed/5/1/', 'dsh-resource://changes-diff/session/viewed/5/1/%E0%A4%A',
    ]) {
      expect(parseChangesDiffAddress(bad)).toBeUndefined()
      expect(definition.canOpen?.(bad)).toBe(false)
      expect(definition.title(bad)).toBe(bad)
    }
  })
})

describe('ChangesDiffStore', () => {
  it('keeps served and missing comparisons, retries failures, and forgets on reset and disposal', async () => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
    vi.stubGlobal('fetch', fetcher)
    const store = new ChangesDiffStore()
    fetcher.mockResolvedValueOnce(Response.json(text))
    await store.load(SESSION, 5, 1)
    expect(store.state.getSnapshot()[URL_]).toEqual(text)
    await store.load(SESSION, 5, 1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockResolvedValueOnce(new Response('gone', { status: 404 }))
    await store.load(SESSION, 5, 2)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 2)]).toBe('missing')
    await store.load(SESSION, 5, 2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    fetcher.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 3)]).toBe('error')
    fetcher.mockResolvedValueOnce(Response.json({ kind: 'text' }))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 3)]).toBe('error')
    fetcher.mockRejectedValueOnce(new Error('offline'))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 3)]).toBe('error')
    fetcher.mockResolvedValueOnce(Response.json({ kind: 'oversized', path: 'p', display: 'p' }))
    await store.load(SESSION, 5, 3)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 5, 3)]).toEqual({ kind: 'oversized', path: 'p', display: 'p' })
    store.reset()
    expect(store.state.getSnapshot()).toEqual({})
    let settle!: (response: Response) => void
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { settle = resolve }))
    const stale = store.load(SESSION, 5, 1)
    expect(store.state.getSnapshot()[URL_]).toBe('loading')
    store.reset()
    settle(Response.json(text))
    await stale
    expect(store.state.getSnapshot()[URL_]).toBeUndefined()
    fetcher.mockReturnValueOnce(new Promise<Response>((resolve) => { settle = resolve }))
    const late = store.load(SESSION, 5, 1)
    const disposal = store.dispose()
    settle(Response.json(text))
    await Promise.all([late, disposal])
    expect(store.state.getSnapshot()[URL_]).toBe('loading')
    await store.load(SESSION, 6, 0)
    expect(store.state.getSnapshot()[changesDiffUrl(SESSION, 6, 0)]).toBeUndefined()
  })
})

describe('DiffPreview', () => {
  function mount(
    diffs = new ChangesDiffStore(), controller = new PresentedOpenController(), locale = en, address = changesDiffAddress(COORDINATES),
  ) {
    const injected = {
      loadChangesDiff: vi.fn<DiffPreviewInjected['loadChangesDiff']>(() => Promise.resolve()),
      reloadPresentedHost: vi.fn<DiffPreviewInjected['reloadPresentedHost']>(() => Promise.resolve()),
      openChanged: vi.fn<DiffPreviewInjected['openChanged']>(() => Promise.resolve()),
    }
    const runtime = {
      useTabInfo: () => ({ tab: { contentId: address } }),
      useChangesDiff: <T,>(select: (state: ReturnType<typeof diffs.state.getSnapshot>) => T): T => select(diffs.state.getSnapshot()),
      usePresentedOpen: <T,>(select: (state: ReturnType<typeof controller.state.getSnapshot>) => T): T =>
        select(controller.state.getSnapshot()),
      usePresentedHost: <T,>(select: (state: ReturnType<typeof controller.host.getSnapshot>) => T): T =>
        select(controller.host.getSnapshot()),
      t: makeTranslate(locale),
      ...injected,
    } as unknown as DiffPreviewProps
    const view = render(<DiffPreview {...runtime} />)
    return { view, injected, rerender: () => { view.rerender(<DiffPreview {...runtime} />) } }
  }

  it('numbers hunk lines on the side they belong to', () => {
    expect(hunkRows(text.hunks[0]!)).toEqual([
      { kind: 'context', old: 1, new: 1, text: 'a' },
      { kind: 'del', old: 2, new: undefined, text: 'b' },
      { kind: 'add', old: undefined, new: 2, text: 'B' },
      { kind: 'add', old: undefined, new: 3, text: 'c' },
      { kind: 'context', old: 3, new: 4, text: 'd' },
    ])
  })

  it('asks for the comparison once, then draws its hunks with line numbers and the path header', () => {
    const diffs = new ChangesDiffStore()
    const { view, injected, rerender } = mount(diffs)
    expect(injected.loadChangesDiff).toHaveBeenCalledWith('viewed', 5, 1)
    expect(injected.reloadPresentedHost).toHaveBeenCalledTimes(1)
    expect(view.getByRole('status').textContent).toBe(en['diff.loading'])
    expect(view.getByTitle('src/app/main.ts').textContent).toBe('src/app/main.ts')
    diffs.state.set({ [URL_]: text })
    rerender()
    expect(injected.loadChangesDiff).toHaveBeenCalledTimes(1)
    const root = view.container.querySelector('[data-changes-diff]')
    expect(root?.getAttribute('data-diff-state')).toBe('text')
    expect(view.getByText('@@ -1,3 +1,4 @@')).toBeTruthy()
    const lines = [...view.container.querySelectorAll('[data-diff-line]')]
    expect(lines.map(line => line.getAttribute('data-diff-line'))).toEqual(['context', 'del', 'add', 'add', 'context', 'del', 'add'])
    expect(lines[1]?.textContent).toBe('2-b')
    expect(lines[2]?.textContent).toBe('2+B')
    expect(lines[4]?.textContent).toBe('34 d')
    expect(view.queryByText(en['diff.created'])).toBeNull()
    // Without a desktop the header carries no native-open control.
    expect(view.queryByRole('button')).toBeNull()
  })

  it('states created, deleted, unchanged, and coarse comparisons, and the binary, oversized, missing, and failed reads', () => {
    const diffs = new ChangesDiffStore()
    const { view, injected, rerender } = mount(diffs, new PresentedOpenController(), zh)
    diffs.state.set({ [URL_]: { ...text, before: false, coarse: true } })
    rerender()
    expect(view.getByText(zh['diff.created'])).toBeTruthy()
    expect(view.container.querySelector('[data-diff-coarse]')?.textContent).toBe(zh['diff.coarse'])
    diffs.state.set({ [URL_]: { ...text, after: false } })
    rerender()
    expect(view.getByText(zh['diff.deleted'])).toBeTruthy()
    diffs.state.set({ [URL_]: { ...text, hunks: [] } })
    rerender()
    expect(view.getByText(zh['diff.unchanged'])).toBeTruthy()
    diffs.state.set({ [URL_]: { kind: 'binary', path: 'p', display: 'other/name.bin' } })
    rerender()
    expect(view.getByText(zh['diff.binary'])).toBeTruthy()
    expect(view.getByTitle('other/name.bin')).toBeTruthy()
    diffs.state.set({ [URL_]: { kind: 'oversized', path: 'p', display: 'p' } })
    rerender()
    expect(view.getByText(zh['diff.oversized'])).toBeTruthy()
    diffs.state.set({ [URL_]: 'missing' })
    rerender()
    expect(view.getByText(zh['diff.missing'])).toBeTruthy()
    diffs.state.set({ [URL_]: 'error' })
    rerender()
    expect(view.getByText(zh['diff.error'])).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: zh['presented.retry'] }))
    expect(injected.loadChangesDiff).toHaveBeenCalledTimes(2)
  })

  it('offers the native open only with a desktop and shows its pending and failed states', () => {
    const diffs = new ChangesDiffStore()
    diffs.state.set({ [URL_]: text })
    const controller = new PresentedOpenController()
    controller.host.set({ name: 'desktop', available: true, fileManager: 'finder' })
    const { view, injected, rerender } = mount(diffs, controller)
    expect(injected.reloadPresentedHost).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: en['diff.openNative'] }))
    expect(injected.openChanged).toHaveBeenCalledWith('viewed', 5, 1)
    controller.state.set({ '/api/changes.open?sessionId=viewed&seq=5&index=1': 'opening' })
    rerender()
    expect((view.getByRole('button', { name: en['presented.opening'] }) as HTMLButtonElement).disabled).toBe(true)
    controller.state.set({ '/api/changes.open?sessionId=viewed&seq=5&index=1': 'error' })
    rerender()
    expect(view.getByRole('button', { name: en['diff.openNativeError'] })).toBeTruthy()
    controller.state.set({ '/api/changes.open?sessionId=viewed&seq=5&index=1': 'nativeUnavailable' })
    rerender()
    expect(view.queryByRole('button')).toBeNull()
    controller.state.set({})
    controller.host.set({ name: 'server', available: false, fileManager: null })
    rerender()
    expect(view.queryByRole('button')).toBeNull()
    controller.host.set('error')
    rerender()
    expect(view.queryByRole('button')).toBeNull()
  })

  it('refuses an address it did not mint', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => mount(undefined, undefined, en, 'dsh-resource://file/session/viewed/a.ts')).toThrow('not a comparison address')
    error.mockRestore()
  })
})
