import { JSDOM } from 'jsdom'
import { afterEach, expect, it, vi } from 'vitest'
import { installMandatoryUpdateOverlay } from '../src/preload-mandatory-overlay.ts'
import { MANDATORY_IPC } from '../src/mandatory-update-ipc.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { MandatoryUpdateView } from '../src/mandatory-update-window.ts'

const ipc = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), invoke: vi.fn(async () => {}) }))
vi.mock('electron', () => ({ ipcRenderer: ipc }))
let dom: JSDOM
afterEach(() => {
  dom.window.dispatchEvent(new dom.window.Event('pagehide'))
  dom.window.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  vi.useRealTimers()
})

function setup() {
  dom = new JSDOM('<html><body><button>Product action</button></body></html>', { url: 'dsh-app://app/' })
  vi.stubGlobal('window', dom.window)
  vi.stubGlobal('document', dom.window.document)
  vi.spyOn(dom.window.document, 'readyState', 'get').mockReturnValue('complete')
  const shadow = vi.spyOn(dom.window.HTMLElement.prototype, 'attachShadow')
  installMandatoryUpdateOverlay()
  const publish = ipc.on.mock.calls.find(([channel]) => channel === MANDATORY_IPC.state)![1] as
    (event: unknown, state: MandatoryUpdateView) => void
  const view: MandatoryUpdateView = { locale: resolveDesktopLocale('zh-CN'), policy: { blocking: true, checking: false },
    update: { phase: 'available', version: '2.0.0' }, deferred: false }
  publish({}, view)
  const root = shadow.mock.results[0]!.value as ShadowRoot
  const frame = root.querySelector('iframe')!
  // JSDOM does not create browsing contexts for frames inside a shadow root.
  Object.defineProperty(frame, 'contentWindow', { value: dom.window })
  return { publish, view, root, frame, host: root.host as HTMLElement }
}

it('uses an in-page frame below the caption, reuses it on updates, and never blurs the main body', () => {
  const f = setup()
  expect(f.host.style.top).toBe('40px')
  expect(f.host.style.bottom).toBe('0px')
  expect(f.host.style.position).toBe('fixed')
  expect(f.frame.src).toBe('dsh-app://shell/mandatory-update.html')
  expect(dom.window.document.body.style.filter).toBe('')
  f.publish({}, { ...f.view, update: { phase: 'downloading', version: '2.0.0', percent: 30 } })
  expect(f.root.querySelector('iframe')).toBe(f.frame)
})

it('accepts actions only from the owned shell frame and leaves no overlay after clearance or navigation', async () => {
  vi.useFakeTimers()
  const f = setup()
  const data = { type: 'dsh-mandatory-action', id: 1, action: 'download', version: '2.0.0', revision: undefined }
  const send = (source: Window | null, origin: string) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { source, origin, data }))
  send(null, 'dsh-app://shell')
  send(f.frame.contentWindow, 'https://other.example')
  expect(ipc.invoke).not.toHaveBeenCalled()
  send(f.frame.contentWindow, 'dsh-app://shell')
  await Promise.resolve()
  expect(ipc.invoke).toHaveBeenCalledExactlyOnceWith(MANDATORY_IPC.action, 'download', '2.0.0', undefined)
  f.publish({}, { ...f.view, policy: { blocking: false, checking: false } })
  vi.advanceTimersByTime(150)
  expect(f.host.isConnected).toBe(false)
  dom.window.dispatchEvent(new dom.window.Event('pagehide'))
  expect(ipc.off).toHaveBeenCalledWith(MANDATORY_IPC.state, expect.any(Function))
})
