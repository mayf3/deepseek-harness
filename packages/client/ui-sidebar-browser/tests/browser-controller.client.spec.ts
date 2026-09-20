// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { BrowserController, createBrowserControllers } from '../src/client/browser/BrowserController.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import { createIframePage } from '../src/client/pages.ts'

const TAB = 'tab' as TabId
const APP = 'https://dsh.example'
const lifetimes = new Set<AbortController>()
const disposables: { dispose(): Promise<void> }[] = []
const hosts: HTMLElement[] = []
let sequence = 0

function lifetime(): AbortController {
  const controller = new AbortController()
  lifetimes.add(controller)
  return controller
}

function harness() {
  const id = `browser-controller-test-${String(++sequence)}`
  const store = createBrowserStore().create(id)
  let open = true
  const face = createBrowserControllers(store.actions, createIframePage, () => open)
  disposables.push(face)
  const host = document.createElement('div')
  host.id = id
  hosts.push(host)
  document.body.append(host)
  const mount = (signal: AbortSignal): (() => void) => face.mount({
    tabId: TAB, signal, viewportId: id, applicationOrigin: APP,
    initial: store.getSnapshot().byTab[TAB], initialUrl: undefined, openTab: vi.fn(),
  })
  const iframe = (): HTMLIFrameElement => {
    const element = host.querySelector('iframe')
    if (element === null) throw new Error('expected a mounted iframe')
    return element
  }
  return { store, face, mount, iframe, close: () => { open = false } }
}

afterEach(async () => {
  await Promise.all(disposables.splice(0).map(value => value.dispose()))
  for (const controller of lifetimes) controller.abort()
  lifetimes.clear()
  for (const host of hosts.splice(0)) host.remove()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('BrowserController', () => {
  it('ignores navigation commands after its tab occurrence ends', async () => {
    const store = createBrowserStore().create('browser-controller-ended-test')
    const tabLifetime = lifetime()
    const controller = new BrowserController({
      tabId: TAB, signal: tabLifetime.signal, applicationOrigin: APP, actions: store.actions,
      initial: undefined, createPage: createIframePage, openTab: vi.fn(),
    })
    disposables.push(controller)
    tabLifetime.abort()
    await controller.dispose()

    controller.loadUrl('https://ignored.example/')
    controller.goBack()
    controller.goForward()
    controller.reload()
    expect(controller.getSnapshot().frame.target).toBeUndefined()
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
  })

  it('owns the four navigation commands and frame load state', () => {
    const { store, face, mount, iframe, close } = harness()
    const tabLifetime = lifetime()
    mount(tabLifetime.signal)
    const state = face.keyedHooks.browserState(TAB)!
    mount(tabLifetime.signal)
    expect(face.keyedHooks.browserState(TAB)).toBe(state)
    face.goBack(TAB)
    face.goForward(TAB)
    face.reload(TAB)

    face.loadUrl(TAB, 'https://example.test/one')
    const first = iframe()
    expect(first.src).toBe('https://example.test/one')
    first.dispatchEvent(new Event('load'))
    expect(store.getSnapshot().byTab[TAB]?.navigation.status).toBe('known')
    first.dispatchEvent(new Event('load'))
    expect(store.getSnapshot().byTab[TAB]?.navigation.status).toBe('unknown')
    face.goBack(TAB)
    face.goForward(TAB)
    expect(store.getSnapshot().byTab[TAB]?.navigation.status).toBe('unknown')

    face.loadUrl(TAB, 'https://example.test/two')
    face.goBack(TAB)
    expect(state.getSnapshot().frame.target?.url).toBe('https://example.test/one')
    face.goForward(TAB)
    expect(state.getSnapshot().frame.target?.url).toBe('https://example.test/two')
    const beforeReload = store.getSnapshot().byTab[TAB]!.request!.revision
    face.reload(TAB)
    expect(store.getSnapshot().byTab[TAB]?.request?.revision).toBe(beforeReload + 1)
    face.loadUrl(TAB, 'https://example.test/two')
    expect(store.getSnapshot().byTab[TAB]?.request?.revision).toBe(beforeReload + 2)

    close()
    tabLifetime.abort()
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    first.dispatchEvent(new Event('load'))
    face.loadUrl(TAB, 'https://ignored.example/')
    face.goBack(TAB)
    face.goForward(TAB)
    face.reload(TAB)
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    expect(face.keyedHooks.browserState(TAB)).toBeUndefined()
  })

  it('does not let an old occurrence delete a replacement controller', () => {
    const { store, face, mount } = harness()
    const first = lifetime()
    const second = lifetime()
    mount(first.signal)
    const original = face.keyedHooks.browserState(TAB)
    mount(second.signal)
    const replacement = face.keyedHooks.browserState(TAB)
    expect(replacement).not.toBe(original)
    first.abort()
    expect(store.getSnapshot().byTab[TAB]).toBeUndefined()
    face.loadUrl(TAB, 'https://example.test/')
    expect(store.getSnapshot().byTab[TAB]).toBeDefined()
    mount(second.signal)
    expect(face.keyedHooks.browserState(TAB)).toBe(replacement)
  })

  it('loads loopback under sandbox and reloads it across sandbox changes', () => {
    const { store, face, mount, iframe } = harness()
    const tabLifetime = lifetime()
    mount(tabLifetime.signal)
    const state = face.keyedHooks.browserState(TAB)!

    face.loadUrl(TAB, 'http://localhost:5173/app')
    expect(state.getSnapshot().frame).toMatchObject({
      sandboxEnabled: true,
      target: { url: 'http://localhost:5173/app' },
    })
    const beforeToggle = store.getSnapshot().byTab[TAB]!.request!.revision

    face.setSandbox(TAB, false)
    expect(state.getSnapshot().frame.sandboxEnabled).toBe(false)
    expect(iframe().src).toBe('http://localhost:5173/app')
    expect(store.getSnapshot().byTab[TAB]?.request?.revision).toBe(beforeToggle + 1)

    face.setSandbox(TAB, true)
    expect(state.getSnapshot().frame).toMatchObject({
      sandboxEnabled: true,
      target: { url: 'http://localhost:5173/app' },
    })
    expect(store.getSnapshot().byTab[TAB]?.request?.revision).toBe(beforeToggle + 2)
  })

  it('loads public HTTP without changing the sandbox policy', () => {
    const { face, mount } = harness()
    const tabLifetime = lifetime()
    mount(tabLifetime.signal)

    face.loadUrl(TAB, 'http://example.test/path')
    const state = face.keyedHooks.browserState(TAB)!
    expect(state.getSnapshot().frame).toMatchObject({
      sandboxEnabled: true,
      target: { url: 'http://example.test/path' },
    })
    const beforeFailure = state.getSnapshot().frame
    face.loadUrl(TAB, 'javascript:alert(1)')
    expect(state.getSnapshot().addressFailure).toBe('protocol')
    expect(state.getSnapshot().frame).toBe(beforeFailure)
    face.reload(TAB)
    expect(state.getSnapshot().addressFailure).toBeUndefined()
  })
})
