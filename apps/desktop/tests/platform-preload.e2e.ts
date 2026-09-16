/** The built sandbox preload provides a synchronous getter after one synchronous initialization. */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

interface Bridge { getAuthToken(): string; displayMode: string }
function load(mainFrame: boolean, response: unknown, origin = 'https://platform.deepseek.com') {
  const bridges = new Map<string, Bridge>()
  const invoke = vi.fn(() => response)
  runInNewContext(readFileSync(new URL('../lib/preload-platform-account.cjs', import.meta.url), 'utf8'), {
    require: (id: string) => {
      if (id !== 'electron') throw new Error('Sandbox module unavailable')
      return {
        contextBridge: { exposeInMainWorld: (key: string, value: Bridge) => bridges.set(key, value) },
        ipcRenderer: { sendSync: invoke },
      }
    },
    process: { isMainFrame: mainFrame, argv: ['--dsh-platform-origin=https://platform.deepseek.com'] }, location: new URL('/usage', origin), exports: {},
  })
  return { bridge: bridges.get('dsh'), invoke }
}
it('provides a synchronous getter immediately after exactly one bootstrap IPC', () => {
  const { bridge, invoke } = load(true, { origin: 'https://platform.deepseek.com', token: 'fixture-secret' })
  expect(bridge!.displayMode).toBe('embedded')
  expect(bridge!.getAuthToken()).toBe('fixture-secret')
  expect(bridge!.getAuthToken()).toBe('fixture-secret')
  expect(bridge).not.toHaveProperty('ready')
  expect(invoke).toHaveBeenCalledTimes(1)
})
it('does not expose the credential bridge to subframes', () => {
  const { bridge, invoke } = load(false, null)
  expect(bridge).toBeUndefined()
  expect(invoke).not.toHaveBeenCalled()
})
it('rejects a mismatched issuer before exposing credentials', () => {
  const { bridge } = load(true, { origin: 'https://other.example', token: 'fixture-secret' })
  expect(bridge!.displayMode).toBe('embedded')
  expect(() => bridge!.getAuthToken()).toThrow()
})
it('fails closed when the main process rejects bootstrap', () => {
  const { bridge } = load(true, null)
  expect(bridge!.displayMode).toBe('embedded')
  expect(() => bridge!.getAuthToken()).toThrow()
})

it('exposes no bridge when the document leaves the allowed origin', () => {
  const { bridge, invoke } = load(true, null, 'https://other.example')
  expect(bridge).toBeUndefined()
  expect(invoke).not.toHaveBeenCalled()
})
