import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { DesktopBackendState } from '../src/backend-controller.ts'
import type { DshDesktopStartupApi } from '../src/ipc.ts'
import { resolveDesktopLocale } from '../src/locale.ts'

function startup(locale = 'en', status: Promise<DesktopBackendState> = Promise.resolve({ phase: 'starting' })) {
  const dom = new JSDOM(readFileSync(new URL('../renderer/startup.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  onTestFinished(() => {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'))
    dom.window.close()
  })
  const listeners = new Set<(state: DesktopBackendState) => void>()
  const unsubscribe = vi.fn(() => { listeners.clear() })
  const retry = vi.fn(async () => {})
  const openPlugins = vi.fn(async () => {})
  const queried = Promise.withResolvers<undefined>()
  const api: DshDesktopStartupApi = {
    protocolVersion: 1,
    locale: async () => resolveDesktopLocale(locale),
    backend: {
      status: () => { queried.resolve(undefined); return status },
      retry,
      subscribe: (listener) => { listeners.add(listener); return unsubscribe },
    },
    openPlugins,
  }
  Object.defineProperty(dom.window, 'dshDesktop', { value: api })
  runInContext(readFileSync(new URL('../renderer/startup.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  const document = dom.window.document
  const element = (selector: string): HTMLElement => {
    const result = document.querySelector<HTMLElement>(selector)
    if (result === null) throw new Error(`Missing startup element: ${selector}`)
    return result
  }
  const button = (selector: string): HTMLButtonElement => {
    const result = document.querySelector<HTMLButtonElement>(selector)
    if (result === null) throw new Error(`Missing startup button: ${selector}`)
    return result
  }
  const publish = (state: DesktopBackendState): void => { for (const listener of listeners) listener(state) }
  const copy = (): string => [element('#title').textContent, element('#description').textContent,
    ...['#error', '#actions'].filter(selector => !element(selector).hidden)
      .flatMap(selector => selector === '#actions'
        ? [button('#retry').textContent, button('#plugins').textContent]
        : [element(selector).textContent]),
  ].join('\n')
  return { dom, document, element, button, publish, copy, retry, openPlugins, unsubscribe, queried: queried.promise }
}

it('shows English loading and recovery actions without a Host document', async () => {
  const page = startup()
  await expect.poll(() => page.element('#title').textContent).not.toBe('')
  expect(page.copy()).toMatchInlineSnapshot(`
    "Starting DeepSeek Harness…
    Your workspace will open when it is ready."
  `)
  expect(page.element('main').getAttribute('aria-busy')).toBe('true')
  expect(page.element('#spinner').hidden).toBe(false)
  expect(page.element('#actions').hidden).toBe(true)
  expect(page.button('#retry').disabled).toBe(true)
  expect(page.button('#plugins').disabled).toBe(true)
  page.publish({ phase: 'error', message: 'Plugin failed to load' })
  expect(page.copy()).toMatchInlineSnapshot(`
    "DeepSeek Harness could not start
    The application could not start. Retry or manage Desktop plugins to resolve the problem.
    Plugin failed to load
    Retry startup
    Manage plugins"
  `)
  expect(page.element('main').getAttribute('aria-busy')).toBe('false')
  expect(page.element('#spinner').hidden).toBe(true)
  page.button('#plugins').click()
  expect(page.openPlugins).toHaveBeenCalledOnce()
  page.button('#retry').click()
  expect(page.retry).toHaveBeenCalledOnce()
  expect(page.element('#actions').hidden).toBe(true)
  expect(page.element('#error').textContent).toBe('')
  expect(page.element('main').getAttribute('aria-busy')).toBe('true')
})

it('shows Chinese loading and recovery copy', async () => {
  const page = startup('zh-CN')
  await expect.poll(() => page.element('#title').textContent).not.toBe('')
  expect(page.document.documentElement.lang).toBe('zh-CN')
  expect(page.copy()).toMatchInlineSnapshot(`
    "正在启动 DeepSeek Harness…
    准备就绪后将自动打开工作区。"
  `)
  page.publish({ phase: 'error', message: '插件加载失败' })
  expect(page.copy()).toMatchInlineSnapshot(`
    "DeepSeek Harness 无法启动
    应用未能启动。你可以重试，或管理桌面插件以解决问题。
    插件加载失败
    重试启动
    管理插件"
  `)
})

it('renders diagnostic markup as text and exposes failures from recovery actions', async () => {
  const page = startup()
  await expect.poll(() => page.element('#title').textContent).not.toBe('')
  const diagnostic = '<img src=x onerror="window.compromised=true">'
  page.publish({ phase: 'error', message: diagnostic })
  expect(page.element('#error').textContent).toBe(diagnostic)
  expect(page.element('#error').childElementCount).toBe(0)
  page.openPlugins.mockRejectedValueOnce(new page.dom.window.Error('Cannot open plugin manager'))
  page.button('#plugins').click()
  await expect.poll(() => page.element('#error').textContent).toBe('Cannot open plugin manager')
  page.retry.mockRejectedValueOnce(new page.dom.window.Error('Retry failed'))
  page.button('#retry').click()
  await expect.poll(() => page.element('#error').textContent).toBe('Retry failed')
  expect(page.button('#retry').disabled).toBe(false)
  expect(page.button('#plugins').disabled).toBe(false)
})

it('keeps subscribed state when initial status arrives late and detaches on pagehide', async () => {
  const initial = Promise.withResolvers<DesktopBackendState>()
  const page = startup('en', initial.promise)
  await page.queried
  page.publish({ phase: 'error', message: 'Fresh startup failure' })
  initial.resolve({ phase: 'starting' })
  await initial.promise
  expect(page.element('#error').textContent).toBe('Fresh startup failure')
  expect(page.element('#actions').hidden).toBe(false)
  page.dom.window.dispatchEvent(new page.dom.window.Event('pagehide'))
  expect(page.unsubscribe).toHaveBeenCalledOnce()
  page.publish({ phase: 'starting' })
  expect(page.element('#error').textContent).toBe('Fresh startup failure')
  page.dom.window.dispatchEvent(new page.dom.window.Event('pagehide'))
  expect(page.unsubscribe).toHaveBeenCalledOnce()
})
